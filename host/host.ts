// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话落在独立 profile `omp-desktop` 下（~/.omp/profiles/omp-desktop/agent），
//   与用户 CLI 的 ~/.omp/agent 隔离；profile 沿用旧 RPC 版的认证（agent.db）
// - UI 壳通过 WebSocket 连入：命令（create/load/prompt/list/get_messages）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
import { setProfile, getAgentDir } from "@oh-my-pi/pi-utils";

// setProfile 必须先于 coding-agent 的 import：其模块在 import 时读取 agentDir
setProfile("omp-desktop");
// theme 是 pi-tui 的延迟初始化单例（export var theme 初始 undefined），TUI 启动流程才会
// ensureThemeSync；headless 宿主必须在 coding-agent（含 ask 工具的 theme.status.success）加载前
// 初始化——Bun 对命名导入做快照，事后初始化救不了已加载的 ask.ts
const { ensureThemeSync } = await import("@oh-my-pi/pi-tui/theme");
ensureThemeSync();
const { getSupportedEfforts } = await import("@oh-my-pi/pi-catalog/model-thinking");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
  await import("@oh-my-pi/pi-coding-agent");
import os from "node:os";
import path from "node:path";

const defaultCwd = os.homedir();

// ---------- 进程级底座（全进程一份，逐 session 共享） ----------
const agentDir = getAgentDir();
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd: defaultCwd, agentDir });

// 可选模型覆盖：OMP_DESKTOP_MODEL="provider/id"（默认模型是本地慢模型，验证/日常用这个切快模型）
const availableModels = modelRegistry.getAvailable();
const modelOverride = process.env.OMP_DESKTOP_MODEL
  ? availableModels.find((m) => `${m.provider}/${m.id}` === process.env.OMP_DESKTOP_MODEL)
  : undefined;
if (process.env.OMP_DESKTOP_MODEL && !modelOverride) {
  process.stderr.write(`[host] 模型覆盖失败：找不到 ${process.env.OMP_DESKTOP_MODEL}，回退默认选择\n`);
}

// ---------- 会话池 ----------
type TranscriptItem = { role: "user" | "assistant" | "tool"; text: string };
type PoolEntry = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionResult: Awaited<ReturnType<typeof createAgentSession>>; // setToolUIContext 等宿主注入点
  unsubscribe: () => void;
  transcript: TranscriptItem[];
  assistantDraft: string; // 当前 turn 的流式文本累积，turn_end 时定稿
  path: string; // 会话文件路径（磁盘标识）
  cwd: string;
};
const sessions = new Map<string, PoolEntry>(); // key = 前端持有的 sessionId

// omp 事件 → 前端窄事件（前端只认这 4 种，不依赖 omp 事件 shape 细节）
type UiEvent =
  | { kind: "turn_start" }
  | { kind: "text_delta"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "turn_end" };

function translateEvent(ev: any, entry: PoolEntry): UiEvent | null {
  switch (ev.type) {
    case "agent_start":
      return { kind: "turn_start" };
    case "message_update":
      if (ev.assistantMessageEvent?.type === "text_delta") {
        entry.assistantDraft += ev.assistantMessageEvent.delta;
        return { kind: "text_delta", text: ev.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start":
      entry.transcript.push({ role: "tool", text: ev.toolName });
      return { kind: "tool", name: ev.toolName };
    case "agent_end":
      // isTerminal === false 表示 maintenance/异步投递还会续跑，不是真正结束
      if (ev.isTerminal === false) return null;
      entry.transcript.push({ role: "assistant", text: entry.assistantDraft });
      entry.assistantDraft = "";
      return { kind: "turn_end" };
    default:
      return null;
  }
}

// 磁盘历史条目 → 前端 transcript（跳过 thinking/toolResult 块，只保留对话文本与工具名）
function entriesToTranscript(entries: any[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const { role, content } = e.message ?? {};
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content === "string") {
      out.push({ role, text: content });
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text") out.push({ role, text: block.text });
      else if (block.type === "toolCall") out.push({ role: "tool", text: block.name });
    }
  }
  return out;
}

// 子代理事件 → 前端窄事件（纯转发，不落父会话 transcript；文本由前端按 subagentId 累积）
function translateSubagentEvent(ev: any): UiEvent | null {
  switch (ev.type) {
    case "agent_start":
      return { kind: "turn_start" };
    case "message_update":
      if (ev.assistantMessageEvent?.type === "text_delta") {
        return { kind: "text_delta", text: ev.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start":
      return { kind: "tool", name: ev.toolName };
    case "agent_end":
      if (ev.isTerminal === false) return null;
      return { kind: "turn_end" };
    default:
      return null;
  }
}

async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[]) {
  const result = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings,
    model: modelOverride,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager,
    disableExtensionDiscovery: true,
    enableMCP: false,
    hasUI: true, // 审批 gate 的 fail-cold 判定走 runner.hasUI()：不开则非 yolo 模式下所有需审批工具直接报错
  });
  const { session } = result;
  const sessionId = crypto.randomUUID();
  const entry: PoolEntry = {
    session,
    sessionResult: result,
    unsubscribe: () => {},
    transcript,
    assistantDraft: "",
    path: session.sessionFile,
    cwd,
  };
  return { sessionId, entry, eventBus: result.eventBus };
}

// ---------- WebSocket 服务 ----------
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // 动态端口：多 workspace 并行开同名应用时固定端口会撞
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.send(
        JSON.stringify({
          type: "ready",
          approvalMode: settings.get("tools.approvalMode"),
          models: availableModels.map((m) => ({
            id: `${m.provider}/${m.id}`,
            name: m.name ?? m.id,
            efforts: getSupportedEfforts(m), // 模型支持的思考档位（reasoning=false 时为空）
          })),
        }),
      );
    },
    async message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "非法 JSON" }));
        return;
      }
      try {
        switch (msg.type) {
          case "create_session":
            await handleCreateSession(ws, msg.cwd);
            break;
          case "load_session":
            await handleLoadSession(ws, msg.path);
            break;
          case "list_sessions":
            await handleListSessions(ws);
            break;
          case "prompt":
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""));
            break;
          case "get_messages":
            handleGetMessages(ws, msg.sessionId);
            break;
          case "set_approval_mode": {
            const mode = msg.mode;
            if (mode !== "yolo" && mode !== "write" && mode !== "always-ask") {
              throw new Error(`非法审批模式: ${mode}`);
            }
            // execute-time 解析：无需重建会话，下一个工具调用即生效（对全部会话生效——settings 全进程共享）
            settings.override("tools.approvalMode", mode);
            ws.send(JSON.stringify({ type: "approval_mode", mode }));
            break;
          }
          case "approval_response": {
            const pending = pendingApprovals.get(msg.requestId);
            if (!pending) throw new Error(`审批请求不存在或已结束: ${msg.requestId}`);
            pending.resolve(typeof msg.answer === "string" ? msg.answer : undefined);
            ws.send(JSON.stringify({ type: "approval_resolved", requestId: msg.requestId }));
            break;
          }
          case "set_model": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const target = availableModels.find((m) => `${m.provider}/${m.id}` === msg.model);
            if (!target) throw new Error(`未知模型: ${msg.model}`);
            await entry.session.setModel(target); // persist 默认 false，仅本会话生效
            const model = `${entry.session.model.provider}/${entry.session.model.id}`;
            // 模型切换后思考级别可能被能力钳制，一并回传生效值
            ws.send(
              JSON.stringify({
                type: "session_model",
                sessionId: msg.sessionId,
                model,
                thinking: entry.session.thinkingLevel ?? "auto",
              }),
            );
            break;
          }
          case "set_thinking": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            entry.session.setThinkingLevel(msg.level);
            // getter 返回按模型能力钳制后的生效值（如 medium→low），如实回传
            ws.send(
              JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.thinkingLevel ?? "auto" }),
            );
            break;
          }
          default:
            ws.send(JSON.stringify({ type: "error", message: `未知命令: ${msg.type}` }));
        }
      } catch (err) {
        // 单条命令失败不拖垮宿主，错误如实上报前端
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, message: String(err) }));
        process.stderr.write(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
  },
});

// 挂起的审批请求：requestId -> resolve（answer 为 undefined 即拒绝语义）
const pendingApprovals = new Map<string, { resolve: (v: string | undefined) => void }>();

function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify({ type: "event", sessionId, ...ui }));
  });
  // 审批/对话框：非 yolo 模式下审批 gate 通过 ExtensionUIContext.select 挂起等用户选择
  const uiCtx = {
    // ask 等工具的 UI 超时从对话框呈现起算，而不是工具发起时
    timeoutStartsOnPresentation: true,
    select(title: string, options: any[], dialogOptions?: any): Promise<string | undefined> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        // agent 中止/工具取消：AbortSignal 到来即按取消（undefined）结束挂起
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title,
            options: options.map((o) => (typeof o === "string" ? o : o.label)),
          }),
        );
      });
    },
    confirm(title: string, message: string): Promise<boolean> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v === "OK");
        };
        pendingApprovals.set(requestId, { resolve: settle });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title: `${title}\n${message}`,
            options: ["OK", "Cancel"],
          }),
        );
      });
    },
    editor(title: string, prefill?: string, dialogOptions?: any): Promise<string | undefined> {
      // ask 的「Other」自定义输入走这里；缺实现会 undefined is not a function 直接挂工具
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title,
            options: ["提交", "取消"],
            editable: true,
            prefill: prefill ?? "",
          }),
        );
      });
    },
  };
  entry.sessionResult.setToolUIContext(uiCtx, true);
  // 关键一步（ACP 同款，acp-agent.ts:2631）：runner.hasUI() 判的是 initialize 注入的 uiContext，
  // 只调 setToolUIContext 不够——审批 gate 会 fail-closed「no interactive UI」
  entry.session.extensionRunner?.initialize({}, {}, {}, uiCtx, "rpc");
  // 整棵 spawn 树共享根会话的 eventBus（sdk.ts:1341）：子代理 lifecycle/event 帧都在上面
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    ws.send(
      JSON.stringify({
        type: "subagent_lifecycle",
        sessionId,
        subagentId: p.id,
        agent: p.agent,
        description: p.description,
        status: p.status,
      }),
    );
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify({ type: "subagent_event", sessionId, subagentId: id, ...ui }));
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubLifecycle();
    unsubEvents();
  };
  sessions.set(sessionId, entry);
}

async function handleCreateSession(ws: any, cwd?: string) {
  const workDir = typeof cwd === "string" && cwd ? cwd : defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workDir, SessionManager.create(workDir), []);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: workDir,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.thinkingLevel ?? "auto",
    }),
  );
  process.stderr.write(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir}（活跃 ${sessions.size}）\n`);
}

async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error("缺少 path");
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // 会话原始工作目录存在 header 条目里（open 内部同源读取）
  const header = entries.find((e: any) => e.type === "session");
  const workCwd = header?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.thinkingLevel ?? "auto",
    }),
  );
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  process.stderr.write(
    `[host] 加载会话 ${sessionId.slice(0, 8)} cwd=${entry.cwd} 历史 ${transcript.length} 条\n`,
  );
}

async function handleListSessions(ws: any) {
  const all = await SessionManager.listAll(); // 全部 project 目录，pinned 优先
  const byProject = new Map<string, any[]>();
  for (const s of all) {
    const list = byProject.get(s.cwd) ?? [];
    list.push(s);
    byProject.set(s.cwd, list);
  }
  const projects = [...byProject.entries()]
    .map(([cwd, list]) => ({
      cwd,
      sessions: list
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          id: s.id,
          path: s.path,
          title: s.title ?? null,
          firstMessage: s.firstMessage.slice(0, 80),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(JSON.stringify({ type: "session_list", projects }));
}

async function handlePrompt(ws: any, sessionId: string, text: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  if (!text) throw new Error("消息为空");
  entry.transcript.push({ role: "user", text });
  // 命令立即返回；turn 产物全部走事件流（omp 的 prompt 在流式中自带 steer/排队语义）
  entry.session.prompt(text).catch((err) => {
    ws.send(JSON.stringify({ type: "error", sessionId, message: String(err) }));
  });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}

process.on("SIGTERM", async () => {
  // Tauri 壳退出兜底；dispose 触发落盘收尾
  await Promise.allSettled([...sessions.values()].map((e) => e.session.dispose()));
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

console.log(`READY ws://127.0.0.1:${server.port}`);
