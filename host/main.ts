// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
// 本文件是宿主主体，由薄入口 host.ts 在零参数形态下动态装载（argv 分流见 host.ts）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入（bootstrap.ts + profile.ts）
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话落在独立 profile 下，与用户 CLI 的 ~/.omp/agent 隔离；profile 沿用旧 RPC 版的认证（agent.db）
// - UI 壳通过 WebSocket 连入：命令（94 个 RPC，host/rpc/ 九域处理器表）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
//
// 本文件只保留：启动序言（profile 装配）、WS 服务壳（ready 帧 + RPC 分发）、
// 宿主级后台任务（配额刷新/外部写入检测/看门狗/孤儿自愈）。
// 模块分工：bootstrap.ts（SDK 加载闸门）/ state.ts（共享状态与推送桥）/ profile.ts（profile·env·开关）/
// frames.ts（models/settings 帧组装）/ session-lifecycle.ts（会话生命周期与事件接线）/
// plan.ts · goal.ts · queue.ts（域逻辑）/ translate.ts（omp 事件→窄事件）/
// rpc/（RPC 处理器九域）/ assets.ts · extensions.ts · models.ts · stats.ts · limits/ · mcp-pool.ts · pty.ts。
import { stat, open } from "node:fs/promises";
import { initialProfile } from "./bootstrap.ts";
import { H, sessions, HOST_INSTANCE_ID } from "./state.ts";
import { applyProfile, refreshAvailableProfiles } from "./profile.ts";
import { modelsPayload, modelsDefaults } from "./models.ts";
import { settingsFrame } from "./frames.ts";
import { dispatchRpc } from "./rpc/index";
import { disposeTerminalsOf } from "./pty.ts";
import { closeAllSharedMcpConnections } from "./mcp-pool.ts";
import { refreshAllLimits } from "./limits/index.ts";
import { augmentGuiPath } from "./gui-path.ts";

// ---------- 启动序言：激活持久化 profile，装配进程级底座 ----------
// PATH augment completion point: the first RPC after UI connects
// (list_agent_assets → MCP health probes) already spawns subprocesses, so it
// must complete before that. host.ts fired it early, overlapping the SDK
// static graph load — usually zero wait here.
await augmentGuiPath();
// profile 初始化不等在线模型目录发现（applyProfile 内 refreshInBackground），
// ready 帧携带磁盘缓存目录立即可用；目录后台补全后经 onModelsRefreshed 补推 models 帧。
const activeWs: { value: unknown } = { value: null };
H.onModelsRefreshed = () => {
  const ws = activeWs.value as { send(data: string): unknown } | null;
  if (ws) ws.send(JSON.stringify({ type: "models", models: modelsPayload(), ...modelsDefaults() }));
};
const profileReady = (async () => {
  H.currentProfile = initialProfile;
  await refreshAvailableProfiles();
  await applyProfile(H.currentProfile);
})();
profileReady.catch((err) => {
  process.stderr.write(`[host] Profile 初始化失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});

// ---------- WebSocket 服务 ----------
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // 动态端口：多 workspace 并行开同名应用时固定端口会撞
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      activeWs.value = ws;
      process.stderr.write(`[host] WS 客户端接入（前端加载与连接全链路 OK） [t=${performance.now().toFixed(0)}ms]\n`);
      void profileReady.then(
        () => {
          ws.send(
            JSON.stringify({
              type: "ready",
              hi: HOST_INSTANCE_ID, // 握手不占事件序号，但携带实例身份供 UI 立即比对
              approvalMode: H.settings.get("tools.approvalMode"),
              models: modelsPayload(),
              ...modelsDefaults(),
              settings: settingsFrame(),
            }),
          );
        },
        (err) => {
          ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.initFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
        },
      );
    },
    async message(ws, raw) {
      let msg: any;
      try {
        await profileReady;
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.initFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
        return;
      }
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.invalidJson") }));
        return;
      }
      try {
        await dispatchRpc(ws, msg);
      } catch (err) {
        // 单条命令失败不拖垮宿主，错误如实上报前端
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, kind: msg.kind ?? null, message: String(err) }));
        process.stderr.write(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
    close(ws) {
      // 前端断开：清理其名下终端 PTY，防孤儿 shell 进程
      if (activeWs.value === ws) activeWs.value = null;
      disposeTerminalsOf(ws);
    },
  },
});

process.on("SIGTERM", async () => {
  // Tauri 壳退出兜底；dispose 触发落盘收尾
  await Promise.allSettled([...sessions.values()].map((e) => e.session.dispose()));
  await closeAllSharedMcpConnections();
  process.exit(0);
});

// 父进程死亡自监测：tauri dev 杀进程树时壳的 Exit 回调可能来不及 kill，
// 宿主轮询 ppid，父进程消失就自行退出，杜绝孤儿进程
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
}, 2000);

// ---------- 宿主内存看门狗 ----------
// 失控会话/缓存累积可能把宿主 RSS 推到吃光整机内存。Bun/JSC 没有可用的堆上限开关
// （BUN_JSC_forceRAMSize 实测不生效），改为 RSS 轮询：超限打日志后以退出码 86 退出，
// Tauri 壳识别 86 限频重启宿主（src-tauri/src/lib.rs），前端重试环自动接入新 WS 端口，
// 磁盘会话不受影响。正常使用远达不到该阈值，仅作失控兜底。
const HOST_RSS_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
setInterval(() => {
  const rss = process.memoryUsage.rss();
  if (rss > HOST_RSS_LIMIT_BYTES) {
    process.stderr.write(`[host] RSS ${(rss / 1048576) | 0}MB 超上限 2048MB，主动退出等待壳重启\n`);
    process.exit(86);
  }
}, 30_000);

console.log(`READY ws://127.0.0.1:${server.port}`);
process.stderr.write(`[host][启动计时] WS 服务就绪 [t=${performance.now().toFixed(0)}ms]\n`);

// 配额后台刷新:启动时预载所有已配置供应商(模型目录里出现过的 provider),
// 此后每 5 分钟按账号全量重拉;缓存 TTL 同为 5min,前台 hover/切页永远命中缓存,
// 对供应商的实际请求频率严格等于本节奏。
const LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
function configuredLimitProviders() {
  const seen = new Map<string, string>();
  for (const m of H.availableModels) {
    if (seen.has(m.provider)) continue;
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(m.provider) ?? "";
    } catch {}
    seen.set(m.provider, baseUrl);
  }
  return [...seen].map(([id, baseUrl]) => ({ id, baseUrl }));
}
const runLimitsRefresh = () => {
  const providers = configuredLimitProviders();
  void refreshAllLimits(H.authStorage, providers).then(() => {
    process.stderr.write(`[host] 配额预载/刷新完成: ${providers.length} 个供应商\n`);
  });
};
void profileReady.then(runLimitsRefresh);
setInterval(() => {
  void profileReady.then(runLimitsRefresh);
}, LIMITS_REFRESH_INTERVAL_MS);

// ---------- 宿主池外部写入检测 ----------
// 池内会话 = desktop 正持有内存态的全集（宿主池无上限，前端 OPEN_SESSIONS_MAX 只管 UI LRU）。
// 锁文件无信号（.lock.os 是 advisory 残留、publish 持有窗口 <500ms），唯一可靠信号 =
// 文件被本进程之外的进程追加：从 pollKnownSize 起读新增完整行，行内 id 不在 manager
// 内存索引里 = 外部写入（CLI 对话/改名/压缩都会落新条目）。自己写入的 id 必先进过内存，零误报。
const POLL_EXTERNAL_WRITES_MS = 2000;
async function pollExternalWrites() {
  for (const [sessionId, entry] of sessions.entries()) {
    try {
      const st = await stat(entry.path);
      if (st.size === entry.pollKnownSize) continue;
      if (st.size < entry.pollKnownSize) entry.pollKnownSize = 0; // 全量重写：从头再扫
      const fh = await open(entry.path, "r");
      let data: Buffer;
      try {
        data = Buffer.alloc(st.size - entry.pollKnownSize);
        const { bytesRead } = await fh.read(data, 0, data.length, entry.pollKnownSize);
        data = data.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      // 只消费到最后一个完整行（半行留待下次，避免读到写一半的 JSON）
      let lineEnd = -1;
      for (let i = 0; i < data.length; i++) if (data[i] === 10) lineEnd = i;
      if (lineEnd < 0) continue;
      const newIds: string[] = [];
      let lineStart = 0;
      while (lineStart <= lineEnd) {
        const nl = data.indexOf(10, lineStart);
        const line = data.subarray(lineStart, nl).toString("utf8");
        lineStart = nl + 1;
        if (line.trim()) {
          try {
            const o = JSON.parse(line) as { id?: unknown; type?: unknown };
            // 文件书架行不参与判定：header（type "session"，带 sessionId 形状的 id 但
            // getEntries 明确不含 header）与 title slot 行；只有真条目比对内存索引
            if (typeof o.id === "string" && o.type !== "session") newIds.push(o.id);
          } catch {
            // 完整但损坏的行：跳过
          }
        }
      }
      entry.pollKnownSize += lineStart;
      if (entry.externalWrite || newIds.length === 0) continue;
      const known = new Set<string>(entry.manager.getEntries().map((e: { id?: string }) => e?.id));
      if (!newIds.some((id) => !known.has(id))) continue;
      entry.externalWrite = true;
      const ws = entry.attachedWs as { send(data: string): unknown } | null;
      ws?.send(JSON.stringify({ type: "session_external_write", sessionId }));
    } catch (err) {
      // 新会话文件是懒落盘（首条条目才创建）：ENOENT = 尚无可监测对象，静默跳过
      if ((err as { code?: string }).code === "ENOENT") continue;
      process.stderr.write(`[host] 外部写入轮询失败 ${entry.path}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
setInterval(() => { void pollExternalWrites(); }, POLL_EXTERNAL_WRITES_MS);
