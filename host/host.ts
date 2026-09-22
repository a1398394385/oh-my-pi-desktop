// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入（bootstrap.ts + profile.ts）
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话落在独立 profile `omp-desktop` 下（~/.omp/profiles/omp-desktop/agent），
//   与用户 CLI 的 ~/.omp/agent 隔离；profile 沿用旧 RPC 版的认证（agent.db）
// - UI 壳通过 WebSocket 连入：命令（create/load/prompt/list/get_messages/get_limits 等）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
//
// 模块分工：bootstrap.ts（SDK 加载顺序闸门）/ state.ts（共享可变状态 H）/ profile.ts（profile·env·项目清单）/
// models.ts（模型目录与设置快照）/ assets.ts（skills·mcp·agents 磁盘资产）/ stats.ts（使用统计）/
// translate.ts（omp 事件 → 前端窄事件）。本文件只保留 WebSocket 服务与会话生命周期。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  SessionManager,
  createAgentSession,
  AgentRegistry,
  Tokenizer,
  getProviderDefinition,
  initialProfile,
  setMcpServerEnabled,
  addMCPServer,
  updateMCPServer,
  removeMCPServer,
  isUserQueuedMessage,
  isHiddenUserCompanion,
  toRestoredQueuedMessage,
  USER_INTERRUPT_LABEL,
} from "./bootstrap.ts";
import { createTerminal, disposeTerminalsOf, terminalFor } from "./pty.ts";
import { createAcpCompressTools } from "./acp-tools.ts";
import { AcpSessionState, parseAcpContextWindow, type AcpNudgeConfig } from "./acp-state.ts";
import { createAcpContextExtension } from "./acp-context.ts";
import {
  H,
  sessions,
  defaultCwd,
  enabledDefaults,
  loginPendingPrompts,
  type PoolEntry,
  type TranscriptItem,
  type DesktopEnv,
} from "./state.ts";
import {
  applyProfile,
  refreshAvailableProfiles,
  saveDesktopProjects,
  mergeHistoryProjects,
  applySleepPrevention,
  applyDesktopEnv,
} from "./profile.ts";
import { rebuildScopedModels, modelsPayload, settingsSnapshot, modelCatalog, modelRolesPayload, modelsDefaults } from "./models.ts";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings";

// models 帧统一组装：目录 + 新建会话配置默认（defaultModel/defaultThinking），
// 所有发送点共用，避免漏带默认字段
function modelsFrame() {
  return { type: "models", models: modelsPayload(), ...modelsDefaults() };
}
import {
  listAgentAssets,
  probeMcpServerHealth,
  mcpHealthCache,
  nearestProjectOmpDir,
  assetOmpDir,
  mcpCandidates,
  resolveAssetFile,
  type AssetKind,
} from "./assets.ts";
import { collectUsageStats } from "./stats.ts";
import { translateEvent, translateSubagentEvent, entriesToTranscript, sumRunDurationMs } from "./translate.ts";
import { fetchSessionLimits, fetchProviderAccountsLimits, refreshAllLimits, listAllProviders } from "./limits/index.ts";

// ---------- 启动序言：激活持久化 profile，装配进程级底座 ----------
H.currentProfile = initialProfile;
await refreshAvailableProfiles();
await applyProfile(H.currentProfile);

// MCP 工具 schema token 估算缓存:tools roster 身份不变就不重算
const mcpTokensCache = new WeakMap<object, number>();

// MCP 工具(mcp__ 前缀)schema token 单独估算;breakdown 的 systemToolsTokens 含全部工具,
// 前端展示时减去即得纯内置系统工具。roster 身份不变就不重算。
// 注:发布的 pi-coding-agent npm 包不含 modes/utils/context-usage,这里用
// Tokenizer 直接数 wire schema JSON(approximate 模式),不引 SDK 内部模块。
function estimateMcpToolsTokens(entry: PoolEntry): number {
  const tools = entry.session.state?.tools;
  if (!Array.isArray(tools)) return 0;
  const cached = mcpTokensCache.get(tools);
  if (cached !== undefined) return cached;
  const model = entry.session.model;
  if (!model) return 0;
  const fragments: string[] = [];
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || !tool.name.startsWith("mcp__")) continue;
    fragments.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  if (fragments.length === 0) return 0;
  const tokens = new Tokenizer(model).countTokens(fragments);
  mcpTokensCache.set(tools, tokens);
  return tokens;
}

function isGitWorktree(cwd: string): boolean {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

// 池外会话的磁盘解析：扫全部会话文件（与 list_sessions 同源），按底座会话 id 匹配
// 出文件路径。用于对未打开的历史会话做 rename/archive 等操作。
async function sessionPathFromDisk(sessionId: string): Promise<string> {
  const hit = (await SessionManager.listAll()).find((s: any) => s.id === sessionId);
  if (!hit) throw new Error(`会话不存在: ${sessionId}`);
  return hit.path;
}

// git 写操作共用：参数数组直传子进程（无 shell 拼接，天然防注入），失败时把 stderr
// 汇总成 error 字段交调用方回包（不抛异常炸连接），成功返回 stdout/stderr
function runGitChecked(cwd: string, args: string[]): { ok: true; stdout: string; stderr: string } | { ok: false; error: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    return { ok: false, error: p.stderr.toString().trim().slice(0, 500) || `git ${args[0]} 失败（exit ${p.exitCode}）` };
  }
  return { ok: true, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

// git 写操作 RPC 的 paths 参数：字符串数组、去空
function stringPaths(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter((x) => x.trim()) : [];
}

/** 读 omp-desktop.json 原始对象（读失败返回空对象）。 */
function readAcpRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readAcpNudgeConfig(): AcpNudgeConfig {
  const fallback: AcpNudgeConfig = { maxContextLimit: 0.55, minContextLimit: 0.45 };
  const acp = readAcpRaw().acp as Record<string, unknown> | undefined;
  if (!acp || typeof acp !== "object") return fallback;
  const parse = (v: unknown, dflt: number): number => {
    if (typeof v === "number" && v > 0 && v <= 1) return v;
    if (typeof v === "string") {
      const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(v);
      if (m) return Number(m[1]) / 100;
    }
    return dflt;
  };
  return {
    maxContextLimit: parse(acp.maxContextLimit, 0.55),
    minContextLimit: parse(acp.minContextLimit, 0.45),
  };
}

/** ACP 总开关（omp-desktop.json 的 acp.enabled）。缺省/非法值按开启处理，
 *  保持引入开关之前的行为——只有显式写 false 才关闭。 */
function readAcpEnabled(): boolean {
  const acp = readAcpRaw().acp as Record<string, unknown> | undefined;
  if (!acp || typeof acp !== "object") return true;
  return acp.enabled !== false;
}

/** 写回 acp.enabled：先读盘再覆盖，保留 omp-desktop.json 的其他键与 acp 段内其他字段。 */
async function writeAcpEnabled(enabled: boolean): Promise<void> {
  const raw = readAcpRaw();
  const acp = raw.acp && typeof raw.acp === "object" ? (raw.acp as Record<string, unknown>) : {};
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, acp: { ...acp, enabled } }, null, 2));
}

/** 设置帧 = 底座设置快照 + host 侧 ACP 开关（不下沉 models.ts，避免模块环）。 */
function settingsWithAcp() {
  return { ...settingsSnapshot(), acpEnabled: readAcpEnabled() };
}

async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[], initialModel?: any) {
  const acpState = new AcpSessionState();
  // 实验性功能页的总开关（omp-desktop.json 的 acp.enabled，默认开启）：只决定本会话
  // 是否注入 ACP 工具面与 context 视图改写；会话创建后无法热切换，故开关变更对新会话生效
  const acpEnabled = readAcpEnabled();
  // nudge 分母：omp-desktop.json 的 acp.contextWindow（固定值，如 2000000 / "1M"）
  // 优先于模型注册表窗口；两者皆未知则 nudge 整体禁用
  const sessionModel = (initialModel ?? H.modelOverride) as { contextWindow?: number; contextLength?: number } | undefined;
  acpState.modelContextWindow =
    parseAcpContextWindow((readAcpRaw()?.acp as Record<string, unknown> | undefined)?.contextWindow) ||
    Number(sessionModel?.contextWindow ?? sessionModel?.contextLength ?? 0) ||
    0;
  acpState.nudge = readAcpNudgeConfig();
  const result = await createAgentSession({
    cwd,
    authStorage: H.authStorage,
    modelRegistry: H.modelRegistry,
    settings: H.settings,
    model: initialModel ?? H.modelOverride,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager, // host 侧 manager 必须注入 SDK：否则 rename/compact/branch 走 entry.manager（孤儿实例）操作到另一个会话文件
    customTools: acpEnabled ? (createAcpCompressTools(acpState) as never) : [], // ACP 压缩工具（compress/decompress/search_context/acp_status/acp_context_recap），见 host/acp-tools.ts；omptype/ArkType schema 与包类型 TSchema 品牌不兼容，运行时一致
    extensions: acpEnabled ? [createAcpContextExtension(acpState)] : [], // context 事件视图变换：ref 注入 + 压缩块替换，见 host/acp-context.ts
    disableExtensionDiscovery: true,
    enableMCP: false,
    hasUI: true, // 审批 gate 的 fail-cold 判定走 runner.hasUI()：不开则非 yolo 模式下所有需审批工具直接报错
  });
  const { session } = result;
  const sessionId = crypto.randomUUID();
  const entry: PoolEntry = {
    session,
    sessionResult: result, // setToolUIContext 等宿主注入点
    unsubscribe: () => {},
    providerSessionId: sessionManager.getSessionId?.() ?? sessionId, // 请求侧 getApiKey 的粘性键
    transcript,
    assistantDraft: "", // 当前 turn 的流式文本累积，turn_end 时定稿
    thinkingDraft: "",
    thinkingStartedAt: null,
    activeMs: 0,
    activeStartedAt: null,
    path: session.sessionFile,
    cwd,
    isGit: isGitWorktree(cwd),
    queuedTexts: [], // 排队消息文本快照（turn_end 竞态兜底）
    consumedTexts: [],
    parkedFollowUp: [], // followUp 暂存区（见 state.ts 类型注释）
    manager: sessionManager, // rename/compact 等需要直接操作 SessionManager 的 RPC 用
    title: null,
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
      process.stderr.write(`[host] WS 客户端接入（前端加载与连接全链路 OK）\n`);
      ws.send(
        JSON.stringify({
          type: "ready",
          approvalMode: H.settings.get("tools.approvalMode"),
          models: modelsPayload(),
          ...modelsDefaults(),
          settings: settingsWithAcp(),
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
            await handleCreateSession(ws, msg.cwd, msg.model, msg.thinking);
            break;
          case "load_session":
            await handleLoadSession(ws, msg.path);
            break;
          case "list_sessions":
            await handleListSessions(ws);
            break;
          case "remove_project": {
            // 移出项目列表（会话仍保留在历史中，「最近」视图照常见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            if (!H.desktopProjects.removedProjects.includes(cwd)) H.desktopProjects.removedProjects.push(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "delete_session": {
            // 彻底删除会话（物理文件 + 对应 artifacts 目录 + 内存会话池与置顶记录）
            const p = String(msg.path ?? "").trim();
            if (!p) throw new Error("缺少 path");
            for (const [key, entry] of sessions.entries()) {
              if (entry.path === p) {
                try { entry.unsubscribe(); } catch {}
                sessions.delete(key);
              }
            }
            const pi = H.desktopProjects.pinnedSessions.indexOf(p);
            if (pi >= 0) {
              H.desktopProjects.pinnedSessions.splice(pi, 1);
              await saveDesktopProjects();
            }
            // 归档记录随会话一并清理
            const ai = H.desktopProjects.archivedSessions.indexOf(p);
            if (ai >= 0) {
              H.desktopProjects.archivedSessions.splice(ai, 1);
              await saveDesktopProjects();
            }
            try {
              await fs.promises.unlink(p);
            } catch (err: any) {
              if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话文件失败: ${err}\n`);
            }
            if (p.endsWith(".jsonl")) {
              const artifactsDir = p.slice(0, -6);
              try {
                await fs.promises.rm(artifactsDir, { recursive: true, force: true });
              } catch (err: any) {
                if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话产物目录失败: ${err}\n`);
              }
            }
            await handleListSessions(ws);
            break;
          }
          case "set_project_expanded": {
            // 项目展开态持久化：记录在 omp-desktop.json expandedProjects，未记录的默认收起
            const cwd = String(msg.cwd ?? "").trim();
            const on = !!msg.expanded;
            if (!cwd) throw new Error("缺少 cwd");
            const i = H.desktopProjects.expandedProjects.indexOf(cwd);
            if (on && i < 0) H.desktopProjects.expandedProjects.push(cwd);
            if (!on && i >= 0) H.desktopProjects.expandedProjects.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "set_session_pinned": {
            // 置顶会话持久化：记录在 omp-desktop.json pinnedSessions，重启保持
            const p = String(msg.path ?? "").trim();
            const on = !!msg.pinned;
            if (!p) throw new Error("缺少 path");
            const i = H.desktopProjects.pinnedSessions.indexOf(p);
            if (on && i < 0) H.desktopProjects.pinnedSessions.push(p);
            if (!on && i >= 0) H.desktopProjects.pinnedSessions.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "archive_session": {
            // 归档持久化：按会话文件路径记入 omp-desktop.json archivedSessions（与
            // pinnedSessions 同键，delete_session 同步清理）；归档同时取消置顶。
            // 未打开的历史会话（不在内存池）扫磁盘按底座会话 id 解析路径，同样可归档。
            const on = !!msg.archived;
            const entry = sessions.get(msg.sessionId);
            const p = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
            const ai = H.desktopProjects.archivedSessions.indexOf(p);
            if (on && ai < 0) H.desktopProjects.archivedSessions.push(p);
            if (!on && ai >= 0) H.desktopProjects.archivedSessions.splice(ai, 1);
            if (on) {
              const pi = H.desktopProjects.pinnedSessions.indexOf(p);
              if (pi >= 0) H.desktopProjects.pinnedSessions.splice(pi, 1);
            }
            await saveDesktopProjects();
            ws.send(JSON.stringify({ type: "session_archived", sessionId: msg.sessionId, ok: true, archived: on }));
            break;
          }
          case "add_project": {
            // 手动添加：命中已移除列表则移回所有项目列表，否则作为新项目并入（置顶，立即可见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            const ri = H.desktopProjects.removedProjects.indexOf(cwd);
            if (ri >= 0) H.desktopProjects.removedProjects.splice(ri, 1);
            if (!H.desktopProjects.allProjects.includes(cwd)) H.desktopProjects.allProjects.unshift(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "reorder_projects": {
            // 拖拽排序：以 UI 传来的完整顺序为准；未涵盖的既有项（并发变更兜底）保持原序追加尾部
            const order = Array.isArray(msg.order) ? msg.order.filter((x: unknown) => typeof x === "string") : [];
            if (order.length === 0) throw new Error("缺少 order");
            const set = new Set(order);
            const rest = H.desktopProjects.allProjects.filter((c) => !set.has(c));
            H.desktopProjects.allProjects = [...order, ...rest];
            await saveDesktopProjects();
            break;
          }
          case "abort_session": {
            // 流式中断当前生成：reason 用 USER_INTERRUPT_LABEL，transcript 能把该轮
            // assistant 消息标记为用户主动中断；空闲会话 abort 同样安全（底座 waitForIdle 立即返回）。
            // 中断后底座自然走到 agent_end/turn 事件，无需额外收尾。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
            ws.send(JSON.stringify({ type: "session_aborted", sessionId: msg.sessionId, ok: true }));
            break;
          }
          case "rename_session": {
            // 会话重命名：走底座 SessionManager.setSessionName(source:"user") 落盘
            // （title slot + history.db 标题索引），CLI 等其他入口读到同一标题。
            // 打开中的会话用池内 manager；未打开的历史会话 open 磁盘文件后同样
            // 落盘（title slot 插入/原位更新均由底座处理）。
            // 懒建未落盘的会话仅内存生效，list_sessions 兜底条目经 entry.title 呈现。
            const title = String(msg.title ?? "").trim();
            if (!title) throw new Error("缺少 title");
            const entry = sessions.get(msg.sessionId);
            if (entry) {
              if (!(await entry.manager.setSessionName(title, "user"))) {
                throw new Error("标题无效（清洗后为空或会话已释放）");
              }
              entry.title = title;
            } else {
              const manager = await SessionManager.open(await sessionPathFromDisk(msg.sessionId));
              if (!(await manager.setSessionName(title, "user"))) {
                throw new Error("标题无效（清洗后为空或会话已释放）");
              }
            }
            ws.send(JSON.stringify({ type: "session_renamed", sessionId: msg.sessionId, ok: true, title }));
            break;
          }
          case "compact_session": {
            // 手动压缩：底座 compact 重写会话历史（LLM 摘要）。空会话前置快速失败
            // （没有可压缩的历史，避免无谓的模型调用）；不可压缩/压缩失败时底座抛错，
            // 以 error 字段回包提示前端；成功则从磁盘 entries 重建 transcript 并推送，
            // 前端立即换压缩后视图。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            if (entry.transcript.length === 0) {
              ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: "会话为空，没有可压缩的历史" }));
              break;
            }
            try {
              await entry.session.compact();
              entry.transcript = entriesToTranscript(entry.manager.getEntries());
              ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
              ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, ok: true }));
            } catch (err) {
              ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: String(err) }));
            }
            break;
          }
          case "branch_session": {
            // 会话分叉：底座 branch(entryId) 以 user 消息条目为界生成新会话文件
            // （header.parentSession 指回源文件），同一 AgentSession 实例切换过去——
            // sessionId 与文件路径都变了。host 侧迁移池键（旧键删、新键建，事件订阅
            // 重建使转发帧带上新键），排队快照同步清空（底座 branch 已清 pending，
            // host 旧快照会让 turn_end 竞态兜底误判「被吞」而重发），transcript 从
            // 新文件 entries 重建，照 compact 模式推 messages 帧让前端立即换分叉后视图。
            // selectedText/selectedImages 是被分叉那条 user 消息的原文，供 UI 回填输入框。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const entryId = String(msg.entryId ?? "");
            if (!entryId) throw new Error("缺少 entryId");
            try {
              const { selectedText, selectedImages, cancelled } = await entry.session.branch(entryId);
              if (cancelled) {
                ws.send(JSON.stringify({ type: "session_branched", sessionId: msg.sessionId, ok: false, error: "分叉被会话扩展取消" }));
                break;
              }
              const newSessionId = crypto.randomUUID();
              const newPath = entry.session.sessionFile ?? "";
              entry.unsubscribe();
              sessions.delete(msg.sessionId);
              entry.path = newPath;
              entry.providerSessionId = entry.manager.getSessionId?.() ?? newSessionId; // 请求凭证粘性键随新会话
              entry.queuedTexts = [];
              entry.consumedTexts = [];
              entry.parkedFollowUp = [];
              entry.transcript = entriesToTranscript(entry.manager.getEntries());
              attachEntry(ws, newSessionId, entry, entry.sessionResult.eventBus);
              ws.send(JSON.stringify({ type: "messages", sessionId: newSessionId, messages: entry.transcript }));
              ws.send(
                JSON.stringify({
                  type: "session_branched",
                  sessionId: msg.sessionId,
                  ok: true,
                  newSessionId,
                  newPath,
                  selectedText,
                  selectedImages,
                }),
              );
              await handleListSessions(ws); // 列表刷新信号：session_list 帧（delete_session 同款机制）
            } catch (err) {
              ws.send(JSON.stringify({ type: "session_branched", sessionId: msg.sessionId, ok: false, error: String(err) }));
            }
            break;
          }
          case "get_session_tree": {
            // 跨文件分支家族：listAll 扫盘，按 header.parentSession（父文件路径）连图。
            // 从当前会话文件出发向上追根，再自根向下收集全部子孙；title 走 listAll 的
            // 底座解析（与 list_sessions 同源）。找不到会话（未落盘且不在池）回 error 字段。
            const entry = sessions.get(msg.sessionId);
            const curPath = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
            const all = await SessionManager.listAll();
            const byPath = new Map<string, any>(all.map((s: any) => [s.path, s]));
            const cur = byPath.get(curPath);
            if (!cur) {
              ws.send(JSON.stringify({ type: "session_tree", sessionId: msg.sessionId, ok: false, error: `会话文件不在磁盘上: ${curPath}` }));
              break;
            }
            // 向上追根（seenUp 防脏数据成环）
            let root = cur;
            const seenUp = new Set<string>([curPath]);
            while (root.parentSessionPath && byPath.has(root.parentSessionPath) && !seenUp.has(root.parentSessionPath)) {
              root = byPath.get(root.parentSessionPath);
              seenUp.add(root.path);
            }
            // 自根 BFS 收集家族（同层按修改时间升序，根在前）
            const family: any[] = [];
            const visited = new Set<string>([root.path]);
            const queue = [root];
            while (queue.length > 0) {
              const node = queue.shift()!;
              family.push(node);
              const children = all
                .filter((s: any) => s.parentSessionPath === node.path && !visited.has(s.path))
                .sort((a, b) => a.modified.getTime() - b.modified.getTime());
              for (const c of children) {
                visited.add(c.path);
                queue.push(c);
              }
            }
            ws.send(
              JSON.stringify({
                type: "session_tree",
                sessionId: msg.sessionId,
                ok: true,
                branches: family.map((s) => ({
                  sessionId: s.id,
                  path: s.path,
                  title: s.title ?? null,
                  modified: s.modified.toISOString(),
                  parentSession: s.parentSessionPath ?? null,
                  isCurrent: s.path === curPath,
                  messageCount: s.messageCount,
                })),
              }),
            );
            break;
          }
          case "prompt":
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""), msg.files);
            break;
          case "peek_queued":
            handlePeekQueued(ws, msg.sessionId);
            break;
          case "drop_queued":
            handleDropQueued(
              ws,
              msg.sessionId,
              msg.queue === "steering" ? "steering" : "followUp",
              msg.index === undefined ? undefined : Number(msg.index),
            );
            break;
          case "send_now":
            await handleSendNow(ws, msg.sessionId, Number(msg.index));
            break;
          case "requeue":
            handleRequeue(ws, msg.sessionId, Number(msg.index));
            break;
          case "get_messages":
            handleGetMessages(ws, msg.sessionId);
            break;
          case "get_file_diff": {
            // 单文件详细 diff：tracked 走 git diff HEAD，untracked/仓库外文件用 --no-index 生成纯新增。
            // cwd 外的文件（如 ~/.omp 全局配置）不拒绝：找它自己所在的 git 仓库；不在任何仓库就整文件当新增。
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const filePath = String(msg.path ?? "");
            if (!filePath) throw new Error("缺少 path");
            const abs = path.resolve(cwd, filePath);
            let repoCwd = cwd;
            if (!abs.startsWith(path.resolve(cwd) + path.sep)) {
              const top = Bun.spawnSync(["git", "-C", path.dirname(abs), "rev-parse", "--show-toplevel"], {
                stdout: "pipe",
                stderr: "ignore",
              });
              const topLevel = top.exitCode === 0 ? top.stdout.toString().trim() : "";
              if (topLevel && abs.startsWith(topLevel + path.sep)) repoCwd = topLevel;
            }
            const rel = path.relative(path.resolve(repoCwd), abs);
            // tracked 检查必须用 rel（相对 repoCwd）：工具调用常给绝对路径或仓库根相对路径，
            // 直接拿原始 filePath 当 pathspec 会让 git 报 outside repository——tracked 误判为
            // false 后走 --no-index 兜底，整个文件被渲染成纯新增（diff 显示与 +N-M 摘要不符的根因）
            const tracked = Bun.spawnSync(["git", "-C", repoCwd, "ls-files", "--error-unmatch", "--", rel], {
              stdout: "ignore",
              stderr: "ignore",
            });
            const args = tracked.exitCode === 0
              ? ["diff", "HEAD", "--", rel]
              : ["diff", "--no-index", "--", "/dev/null", abs];
            const p = Bun.spawnSync(["git", "-C", repoCwd, ...args], { stdout: "pipe", stderr: "pipe" });
            // --no-index 有差异时 exitCode=1 属正常
            if (p.exitCode > 1) throw new Error(`git diff 失败: ${p.stderr.toString().trim().slice(0, 200)}`);
            ws.send(
              JSON.stringify({
                type: "file_diff",
                cwd,
                path: filePath,
                diff: p.stdout.toString().slice(0, 500_000),
              }),
            );
            break;
          }
          case "read_file": {
            // 文件页全文件内容（读取行点击 / 文件树点击详情共用）；限 2MB 文本文件
            const p = String(msg.path ?? "");
            if (!p) throw new Error("缺少 path");
            const stat = fs.statSync(p, { throwIfNoEntry: false });
            if (!stat?.isFile()) throw new Error(`不是文件: ${p}`);
            if (stat.size > 2_000_000) {
              ws.send(JSON.stringify({ type: "file_content", path: p, error: `文件过大（${(stat.size / 1e6).toFixed(1)} MB），仅支持 2MB 内的文本文件` }));
              break;
            }
            const buf = await fs.promises.readFile(p);
            const head = buf.subarray(0, 8000);
            if (head.includes(0)) {
              ws.send(JSON.stringify({ type: "file_content", path: p, error: "二进制文件，不支持文本预览" }));
              break;
            }
            ws.send(JSON.stringify({ type: "file_content", path: p, text: buf.toString("utf8") }));
            break;
          }
          case "read_image": {
            // 图片二进制读取（对话附件预览等）：后缀白名单 + 8MB 上限，base64 回传；
            // 路径校验对齐 read_file 的宽松度（仅要求非空且是文件）
            const p = String(msg.path ?? "");
            if (!p) throw new Error("缺少 path");
            const MIME: Record<string, string> = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
              bmp: "image/bmp",
              svg: "image/svg+xml",
            };
            const ext = path.extname(p).slice(1).toLowerCase();
            if (!(ext in MIME)) {
              ws.send(JSON.stringify({ type: "image_content", path: p, error: `不支持的图片格式: ${ext || "无后缀"}（仅 png/jpg/jpeg/gif/webp/bmp/svg）` }));
              break;
            }
            const stat = fs.statSync(p, { throwIfNoEntry: false });
            if (!stat?.isFile()) {
              ws.send(JSON.stringify({ type: "image_content", path: p, error: `不是文件: ${p}` }));
              break;
            }
            if (stat.size > 8_000_000) {
              ws.send(JSON.stringify({ type: "image_content", path: p, error: `图片过大（${(stat.size / 1e6).toFixed(1)} MB），仅支持 8MB 内` }));
              break;
            }
            const buf = await fs.promises.readFile(p);
            ws.send(JSON.stringify({ type: "image_content", path: p, mime: MIME[ext], data: buf.toString("base64") }));
            break;
          }
          case "list_dir": {
            // 文件树单层列表：目录优先、字母序；隐藏 .git/.DS_Store
            const dir = String(msg.path ?? "");
            if (!dir) throw new Error("缺少 path");
            const stat = fs.statSync(dir, { throwIfNoEntry: false });
            if (!stat?.isDirectory()) throw new Error(`不是目录: ${dir}`);
            const entries: { name: string; dir: boolean }[] = [];
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.name === ".git" || e.name === ".DS_Store") continue;
              entries.push({ name: e.name, dir: e.isDirectory() });
            }
            entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
            ws.send(JSON.stringify({ type: "dir_list", path: dir, entries }));
            break;
          }
          case "get_todos": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            ws.send(JSON.stringify({ type: "todos", sessionId: msg.sessionId, phases: entry.session.getTodoPhases() }));
            break;
          }
          case "get_context_detail": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const b = entry.session.getContextBreakdown();
            const st = entry.session.getSessionStats();
            ws.send(
              JSON.stringify({
                type: "context_detail",
                sessionId: msg.sessionId,
                breakdown: b ? { ...b, mcpToolsTokens: estimateMcpToolsTokens(entry) } : null,
                stats: {
                  tokens: st.tokens,
                  userMessages: st.userMessages,
                  assistantMessages: st.assistantMessages,
                  toolCalls: st.toolCalls,
                  totalMessages: st.totalMessages,
                  premiumRequests: st.premiumRequests,
                  cost: st.cost,
                },
              }),
            );
            break;
          }
          case "get_limits": {
            // 会话当前供应商的套餐限额(token-monitor 移植逻辑,host/limits/)
            // 无会话时(UI 输入框空环 hover)允许按 msg.provider 查询,只显示配额段
            const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
            const ompProvider = entry?.session.model?.provider || String(msg.provider ?? "");
            if (!ompProvider) throw new Error("会话尚未选择模型");
            let baseUrl = "";
            try {
              baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            // 多账号对齐:与会话请求同参(providerSessionId 粘性 + modelId)解析凭证,
            // 明细卡配额即本会话实际命中的账号;key 反查凭证 id 后以 #id 为缓存键
            // (与模型页 accounts/后台预载共用同一缓存行),身份标签一并回填
            let keyOverride: string | null | undefined;
            let cacheTag: string | undefined;
            let accountLabel = "";
            if (entry) {
              const model = entry.session.model;
              keyOverride =
                (await H.authStorage.getApiKey(ompProvider, entry.providerSessionId, {
                  baseUrl,
                  modelId: model?.id,
                })) ?? null;
              const hit = (H.authStorage.listStoredCredentials?.(ompProvider) ?? []).find((c: any) => {
                const cred = c.credential;
                return cred?.type === "api_key" ? cred.key === keyOverride : cred?.access === keyOverride;
              });
              if (hit) cacheTag = `#${hit.id}`;
              const cred: any = hit?.credential;
              accountLabel = cred?.email ?? cred?.accountId ?? cred?.orgName ?? "";
            }
            const { vendor, label, row } = await fetchSessionLimits(H.authStorage, ompProvider, baseUrl, keyOverride, cacheTag);
            ws.send(
              JSON.stringify({
                type: "limits_result",
                sessionId: msg.sessionId,
                label: accountLabel ? `${label} · ${accountLabel}` : label,
                unsupported: vendor === null,
                status: row?.status ?? "unavailable",
                planLabel: row?.planLabel ?? "",
                accountLabel,
                balance: row?.balance ?? null,
                windows: row?.windows ?? [],
                updatedAt: row?.updatedAt ?? null,
              }),
            );
            break;
          }
          case "get_provider_limits": {
            // 模型管理页按供应商读配额(多账号逐凭证,命中 limits 60s 缓存)
            const ompProvider = String(msg.provider ?? "");
            if (!ompProvider) throw new Error("缺少 provider");
            let baseUrl = "";
            try {
              baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            const { vendor, label, accounts } = await fetchProviderAccountsLimits(H.authStorage, ompProvider, baseUrl);
            const first = accounts[0]?.row;
            ws.send(
              JSON.stringify({
                type: "provider_limits_result",
                provider: ompProvider,
                label,
                unsupported: vendor === null,
                // 顶层字段取首个账号(单账号消费方兼容);多账号时前端读 accounts 逐段渲染
                status: first?.status ?? "unavailable",
                planLabel: first?.planLabel ?? "",
                accountLabel: accounts[0]?.label || first?.accountLabel || "",
                balance: first?.balance ?? null,
                windows: first?.windows ?? [],
                updatedAt: first?.updatedAt ?? null,
                accounts: accounts.map((a) => ({
                  id: a.id,
                  label: a.label || a.row.accountLabel || "",
                  status: a.row.status ?? "unavailable",
                  planLabel: a.row.planLabel ?? "",
                  accountLabel: a.row.accountLabel ?? "",
                  balance: a.row.balance ?? null,
                  windows: a.row.windows ?? [],
                  updatedAt: a.row.updatedAt ?? null,
                })),
              }),
            );
            break;
          }
          case "git_stage": {
            // 暂存：git add -- <paths>（数组参数直传，-- 防路径注入）
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const paths = stringPaths(msg.paths);
            if (paths.length === 0) throw new Error("缺少 paths");
            const r = runGitChecked(cwd, ["add", "--", ...paths]);
            if (!r.ok) ws.send(JSON.stringify({ type: "git_staged", cwd, error: r.error }));
            else ws.send(JSON.stringify({ type: "git_staged", cwd, ok: true }));
            break;
          }
          case "git_unstage": {
            // 取消暂存：git reset HEAD -- <paths>
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const paths = stringPaths(msg.paths);
            if (paths.length === 0) throw new Error("缺少 paths");
            const r = runGitChecked(cwd, ["reset", "HEAD", "--", ...paths]);
            if (!r.ok) ws.send(JSON.stringify({ type: "git_unstaged", cwd, error: r.error }));
            else ws.send(JSON.stringify({ type: "git_unstaged", cwd, ok: true }));
            break;
          }
          case "git_discard": {
            // 丢弃工作区改动（破坏性，UI 侧已二次确认，host 直接执行）：
            // tracked 走 checkout -- 恢复，untracked 走 clean -f -- 精确路径删除；逐路径处理，任一失败即回错
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const paths = stringPaths(msg.paths);
            if (paths.length === 0) throw new Error("缺少 paths");
            let err = "";
            for (const p of paths) {
              const tracked = runGitChecked(cwd, ["ls-files", "--error-unmatch", "--", p]);
              const r = tracked.ok ? runGitChecked(cwd, ["checkout", "--", p]) : runGitChecked(cwd, ["clean", "-f", "--", p]);
              if (!r.ok) {
                err = r.error;
                break;
              }
            }
            if (err) ws.send(JSON.stringify({ type: "git_discarded", cwd, error: err }));
            else ws.send(JSON.stringify({ type: "git_discarded", cwd, ok: true }));
            break;
          }
          case "git_commit": {
            // 提交：message 经数组参数传（无 shell 拼接，防注入）；paths 省略 = 提交全部已暂存，
            // 给定 = pathspec 提交（git 自动暂存这些路径的改动并只提交它们）。回包带新提交 sha。
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const message = String(msg.message ?? "");
            if (!message.trim()) throw new Error("缺少 message");
            const paths = stringPaths(msg.paths);
            const args = ["commit", "-m", message, ...(paths.length > 0 ? ["--", ...paths] : [])];
            const r = runGitChecked(cwd, args);
            if (!r.ok) {
              ws.send(JSON.stringify({ type: "git_committed", cwd, error: r.error }));
              break;
            }
            const sha = runGitChecked(cwd, ["rev-parse", "HEAD"]);
            if (!sha.ok) {
              ws.send(JSON.stringify({ type: "git_committed", cwd, error: sha.error }));
              break;
            }
            ws.send(JSON.stringify({ type: "git_committed", cwd, ok: true, commit: sha.stdout.trim() }));
            break;
          }
          case "git_push": {
            // 推送当前分支（不自动 -u）：无 upstream 时 git 报错，stderr 透传为 error
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const r = runGitChecked(cwd, ["push"]);
            if (!r.ok) ws.send(JSON.stringify({ type: "git_pushed", cwd, error: r.error }));
            else {
              // push 的进度/结果输出（分支更新行）在 stderr，成功时取作 result
              ws.send(JSON.stringify({ type: "git_pushed", cwd, ok: true, result: r.stderr.trim() || r.stdout.trim() }));
            }
            break;
          }
          case "get_git_diff": {
            // 当前会话 project 的改动文件清单（树/平铺展示用）
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const p = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
            if (p.exitCode !== 0) throw new Error(`git status 失败: ${p.stderr.toString().trim().slice(0, 200) || "非 git 仓库"}`);
            const files = p.stdout
              .toString()
              .split("\n")
              .filter((l) => l.trim())
              .map((line) => {
                let path = line.slice(3);
                const arrow = path.indexOf(" -> "); // rename：R  old -> new
                if (arrow >= 0) path = path.slice(arrow + 4);
                // XY 两列拆开（X=暂存区/index 状态，Y=工作区状态），供 UI 行级暂存/取消暂存按钮判定；
                // untracked（??）本质是未暂存的新文件，归 unstaged、不给 staged
                const xy = line.slice(0, 2);
                return {
                  code: line.slice(0, 2).trim() || "?",
                  path,
                  staged: xy[0] === " " || xy[0] === "?" ? "" : xy[0],
                  unstaged: xy[1] === " " ? "" : xy[1],
                };
              });
            ws.send(JSON.stringify({ type: "git_status", cwd, files }));
            break;
          }
          case "get_git_branches": {
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const isGit = isGitWorktree(cwd);
            if (!isGit) {
              ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: false, current: null, branches: [] }));
              break;
            }
            const currP = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
            let current = currP.stdout.toString().trim();
            if (!current) {
              const headP = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
              current = headP.stdout.toString().trim() || "HEAD";
            }
            const bP = Bun.spawnSync(["git", "-C", cwd, "branch", "--format=%(refname:short)"], { stdout: "pipe", stderr: "ignore" });
            const branches = bP.stdout.toString().split("\n").map((b) => b.trim()).filter(Boolean);
            ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: true, current, branches }));
            break;
          }
          case "switch_git_branch": {
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const targetBranch = String(msg.branch ?? "").trim();
            if (!targetBranch) throw new Error("缺少 branch");
            const p = Bun.spawnSync(["git", "-C", cwd, "checkout", targetBranch], { stdout: "pipe", stderr: "pipe" });
            if (p.exitCode !== 0) {
              throw new Error(`切换分支失败: ${p.stderr.toString().trim().slice(0, 200)}`);
            }
            ws.send(JSON.stringify({ type: "git_branch_switched", cwd, branch: targetBranch }));
            break;
          }
          case "set_approval_mode": {
            const mode = msg.mode;
            if (mode !== "yolo" && mode !== "write" && mode !== "always-ask") {
              throw new Error(`非法审批模式: ${mode}`);
            }
            // execute-time 解析：无需重建会话，下一个工具调用即生效（对全部会话生效——settings 全进程共享）
            H.settings.override("tools.approvalMode", mode);
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
            process.stderr.write(`[host] set_model: ${msg.model} entry=${!!entry}\n`);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const target = H.scopedModels.find((m) => `${m.provider}/${m.id}` === msg.model);
            if (!target) throw new Error(`未知模型: ${msg.model}`);
            await entry.session.setModel(target); // persist 默认 false，仅本会话生效
            // enabledModels 条目带的 ":thinking" 默认级别与 CLI 行为一致地应用
            const defaultLevel = enabledDefaults.get(msg.model);
            if (defaultLevel) entry.session.setThinkingLevel(defaultLevel);
            const model = `${entry.session.model.provider}/${entry.session.model.id}`;
            // 模型切换后回传配置选择器（"auto" 或具体档位）：右下角显示用户配置的模式，
            // 能力钳制后的生效值属于发送参数细节，不进 UI
            ws.send(
              JSON.stringify({
                type: "session_model",
                sessionId: msg.sessionId,
                model,
                thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
              }),
            );
            break;
          }
          case "set_thinking": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            entry.session.setThinkingLevel(msg.level);
            // 回传配置选择器（"auto" 或具体档位）；钳制后的生效值不进 UI
            ws.send(
              JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.configuredThinkingLevel?.() ?? "auto" }),
            );
            break;
          }
          case "ui_error": {
            // 前端未捕获错误上报（WKWebView 无 console，dev 终端是唯一出口）
            process.stderr.write(`[ui] ${msg.message}\n`);
            break;
          }
          case "get_settings":
            ws.send(JSON.stringify({ type: "settings", settings: settingsWithAcp() }));
            break;
          case "get_settings_schema":
            ws.send(JSON.stringify({ type: "settings_schema", schema: SETTINGS_SCHEMA }));
            break;
          case "reload_settings": {
            // 本地 config 文件可能被手工修改：从磁盘重载（仅模型设置），并推送新模型列表
            try {
              await H.settings.reloadFromDisk();
              rebuildScopedModels();
              ws.send(JSON.stringify(modelsFrame()));
              ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            } catch (err) {
              process.stderr.write(`[host] reload_settings 失败: ${err}\n`);
            }
            break;
          }
          case "set_setting": {
            const key = String(msg.key ?? "");
            const value = msg.value;
            const def = SETTINGS_SCHEMA[key];
            if (!def) throw new Error(`未知设置项: ${key}`);
            const t = def.type;
            if (t === "boolean") {
              if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值`);
            } else if (t === "number") {
              if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`);
            } else if (t === "string") {
              if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
            } else if (t === "enum") {
              if (!def.values.includes(value)) throw new Error(`${key} 必须是 ${def.values.join("/")} 之一`);
            } else if (t === "array") {
              if (!Array.isArray(value)) throw new Error(`${key} 必须是数组`);
              const d = def.default;
              if (Array.isArray(d) && d.every((x) => typeof x === "string") && d.length > 0 && !value.every((x) => typeof x === "string"))
                throw new Error(`${key} 元素必须是字符串`);
            } else if (t === "record") {
              if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} 必须是对象`);
            }
            // 逐键附加校验：ask.timeout 必须非负
            if (key === "ask.timeout" && (typeof value !== "number" || value < 0)) throw new Error("ask.timeout 必须是非负秒数");
            H.settings.set(key, value);
            // 写后副作用：睡眠防止需立即应用到进程
            if (key === "power.sleepPrevention") applySleepPrevention(value);
            // 模型相关键：重建 scoped 目录并推送 models 帧
            const isModelKey = ["enabledModels", "enabledProviders", "disabledProviders", "modelRoleStorage", "modelTags", "modelProviderOrder", "cycleOrder"].includes(key);
            if (isModelKey) rebuildScopedModels();
            await H.settings.flush();
            if (isModelKey) ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "settings", settings: settingsWithAcp() }));
            break;
          }
          case "set_acp_enabled": {
            // 实验性功能页开关：写入 omp-desktop.json 的 acp.enabled（只影响此后创建的会话——
            // 工具面与 context 扩展在 createSessionCore 里注入，无法热插拔到已打开的会话）
            await writeAcpEnabled(!!msg.enabled);
            ws.send(JSON.stringify({ type: "settings", settings: settingsWithAcp() }));
            break;
          }
          case "set_desktop_env": {
            const next: DesktopEnv = {
              httpProxy: String(msg.httpProxy ?? "").trim(),
              noProxy: String(msg.noProxy ?? "").trim(),
              caCerts: String(msg.caCerts ?? "").trim(),
            };
            await writeFile(H.desktopEnvPath, JSON.stringify(next, null, 2));
            H.desktopEnv = next;
            H.desktopEnvFilePresent = true;
            applyDesktopEnv(next);
            ws.send(JSON.stringify({ type: "settings", settings: settingsWithAcp(), restartHint: true }));
            break;
          }
          case "get_models_catalog":
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          case "get_all_providers":
            ws.send(
              JSON.stringify({
                type: "all_providers",
                providers: listAllProviders().map((p) => {
                  let accounts = 0;
                  try {
                    accounts = (H.authStorage.listStoredCredentials?.(p.id) ?? []).length;
                  } catch {}
                  return {
                    ...p,
                    // 登录能力:OAuth/login 流存在即可(API key 对所有供应商可用)
                    login: !!getProviderDefinition(p.id)?.login,
                    // 已配置账号数:authStorage 活跃凭证数(models.yml/env 层配置不计入)
                    accounts,
                  };
                }),
              }),
            );
            break;
          case "provider_login": {
            // OMP 登录流程(AuthStorage.login):浏览器授权 + 需要粘贴码时经 UI 弹窗中转
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            if (H.loginInFlight) throw new Error("已有登录流程进行中，请完成或稍后再试");
            H.loginInFlight = true;
            H.loginAbort = new AbortController();
            const reqId = msg.reqId ?? null;
            const wsRef = ws;
            const reply = (obj: Record<string, unknown>) => {
              try {
                wsRef.send(JSON.stringify({ reqId, ...obj }));
              } catch {}
            };
            reply({ type: "login_progress", provider, message: "正在启动登录…" });
            let promptSeq = 0;
            try {
              const identity = await H.authStorage.login(provider, {
                signal: H.loginAbort.signal,
                onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
                  if (H.loginAbort?.signal.aborted) return;
                  const url = info.launchUrl ?? info.url;
                  if (url) {
                    try {
                      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
                    } catch {}
                  }
                  reply({
                    type: "login_progress",
                    provider,
                    message: info.instructions || "已在浏览器打开登录页面，请完成授权…",
                    url: url ?? "",
                  });
                },
                onProgress: (message: string) => reply({ type: "login_progress", provider, message: String(message) }),
                onPrompt: (prompt: { message?: string; secret?: boolean }) =>
                  new Promise<string>((resolve, reject) => {
                    const id = ++promptSeq;
                    loginPendingPrompts.set(id, resolve);
                    H.loginAbort?.signal.addEventListener(
                      "abort",
                      () => {
                        loginPendingPrompts.delete(id);
                        reject(new Error("aborted"));
                      },
                      { once: true },
                    );
                    reply({ type: "login_prompt", provider, id, message: String(prompt.message ?? ""), secret: !!prompt.secret });
                  }),
              });
              // 登录成功:重新拉取模型目录(新凭证使供应商可用),并推送最新列表
              await H.modelRegistry.refresh();
              H.availableModels = H.modelRegistry.getAvailable();
              rebuildScopedModels();
              reply(modelsFrame());
              reply({ type: "models_catalog", models: modelCatalog() });
              reply({ type: "login_done", provider, ok: true, identity: identity ?? null });
            } catch (err) {
              const aborted = H.loginAbort?.signal.aborted;
              reply({
                type: "login_done",
                provider,
                ok: false,
                cancelled: !!aborted,
                message: aborted ? "登录已取消" : String((err as any)?.message ?? err),
              });
            } finally {
              H.loginInFlight = false;
              H.loginAbort = null;
            }
            break;
          }
          case "provider_logout": {
            // 登出供应商：删除存储凭证（本地毫秒级）后立即本地过滤推送目录，UI 瞬时移除；
            // 完整的 modelRegistry.refresh()（逐供应商网络发现，秒级）随后收敛再推一版(幂等)。
            // models.yml 手写 apiKey 的优先级高于存储凭证，该类供应商 UI 不提供登出入口
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            await H.authStorage.remove(provider);
            H.availableModels = H.availableModels.filter((m) => m.provider !== provider);
            rebuildScopedModels();
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            try {
              await H.modelRegistry.refresh();
              H.availableModels = H.modelRegistry.getAvailable();
              rebuildScopedModels();
              ws.send(JSON.stringify(modelsFrame()));
              ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            } catch (err) {
              process.stderr.write(`[host] 登出后模型目录刷新失败: ${err}\n`);
            }
            break;
          }
          case "provider_login_cancel": {
            // 用户显式取消(如关闭了登录页):中断进行中的登录流程
            if (H.loginInFlight && H.loginAbort) H.loginAbort.abort();
            else throw new Error("当前没有进行中的登录流程");
            break;
          }
          case "provider_set_key": {
            // 配置 API key:写入 authStorage(api_key 凭证),随后刷新模型目录
            const provider = String(msg.provider ?? "");
            const key = String(msg.key ?? "").trim();
            if (!provider) throw new Error("缺少 provider");
            if (!key) throw new Error("API key 不能为空");
            H.authStorage.upsertCredential(provider, { type: "api_key", key });
            await H.modelRegistry.refresh();
            H.availableModels = H.modelRegistry.getAvailable();
            rebuildScopedModels();
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            ws.send(JSON.stringify({ type: "provider_key_done", provider, ok: true }));
            break;
          }
          case "login_prompt_reply": {
            const resolve = loginPendingPrompts.get(Number(msg.id));
            if (resolve) {
              loginPendingPrompts.delete(Number(msg.id));
              resolve(String(msg.text ?? ""));
            }
            break;
          }
          case "open_models_config": {
            // 「手动添加供应商」:打开配置层 models.yml(不存在则创建空文件)
            const modelsPath = path.join(H.agentDir, "models.yml");
            try {
              if (!fs.existsSync(modelsPath)) fs.writeFileSync(modelsPath, "# omp 供应商配置,参考文档编辑\n");
              Bun.spawn(["open", modelsPath], { stdout: "ignore", stderr: "ignore" });
            } catch {}
            ws.send(JSON.stringify({ type: "models_config_path", path: modelsPath }));
            break;
          }
          case "open_folder": {
            const raw = String(msg.path ?? "");
            if (raw) {
              try {
                if (!fs.existsSync(raw)) await mkdir(raw, { recursive: true });
                Bun.spawn(["open", raw], { stdout: "ignore", stderr: "ignore" });
              } catch {}
            }
            break;
          }
          case "set_enabled_model": {
            const id = String(msg.id ?? "");
            const on = !!msg.enabled;
            if (!H.availableModels.some((m) => `${m.provider}/${m.id}` === id)) throw new Error(`未知模型: ${id}`);
            let entries: string[] = (H.settings.get("enabledModels") ?? []).slice();
            if (entries.length === 0) {
              entries = H.availableModels.map((m) => `${m.provider}/${m.id}`);
            }
            const without = entries.filter((e) => e.split(":")[0] !== id);
            if (on) {
              const prev = entries.find((e) => e.split(":")[0] === id);
              without.push(prev ?? id);
            }
            if (without.length === 0) throw new Error("至少保留一个启用模型");
            H.settings.set("enabledModels", without);
            await H.settings.flush();
            rebuildScopedModels();
            if (H.scopedModels.length === 0) throw new Error("启用列表过滤后没有可用模型");
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          }
          case "get_model_roles":
            ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
            break;
          case "set_model_role": {
            // 合法名即可写入：既改已知角色，也从输入框菜单创建自定义角色（覆盖同名旧值）
            const role = String(msg.role ?? "");
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role)) throw new Error(`非法角色名: ${role}`);
            // UI 只写精确 "provider/model"（或 null 清除回默认链），别名/后缀交给 settings.json 手写
            const value = msg.value == null || msg.value === "" ? undefined : String(msg.value);
            if (value && !H.availableModels.some((m) => `${m.provider}/${m.id}` === value)) {
              throw new Error(`未知模型: ${value}`);
            }
            H.settings.setModelRole(role, value);
            await H.settings.flush();
            ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
            break;
          }
          case "get_usage_stats":
            ws.send(JSON.stringify({ type: "usage_stats", stats: await collectUsageStats() }));
            break;
          case "list_agent_assets": {
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_file_read": {
            const kind = String(msg.kind ?? "agent") as AssetKind;
            const file = resolveAssetFile(kind, msg.path);
            const content = await readFile(file, "utf8");
            ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
            break;
          }
          case "memory_file_read": {
            const raw = String(msg.path ?? "");
            const file = path.resolve(raw);
            const rel = path.relative(path.resolve(path.join(H.agentDir, "memories")), file);
            if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径不在允许的记忆目录内: ${raw}`);
            // 工作区记忆是目录：返回顶层 .md 清单（按修改时间新→旧）并默认读最新的一个
            let target = file;
            let files: string[] | undefined;
            let rollouts: string[] | undefined;
            if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
              const mtime = (dir: string, n: string) => {
                try {
                  return fs.statSync(path.join(dir, n)).mtimeMs;
                } catch {
                  return 0;
                }
              };
              files = (await readdir(file))
                .filter((n) => n.endsWith(".md") && !n.startsWith("."))
                .sort((a, b) => mtime(file, b) - mtime(file, a));
              if (!files.length) throw new Error(`记忆目录内没有 .md 文件: ${raw}`);
              target = path.join(file, files[0]);
              const rollDir = path.join(file, "rollout_summaries");
              rollouts = (await readdir(rollDir).catch(() => [] as string[]))
                .filter((n) => n.endsWith(".md") && !n.startsWith("."))
                .sort((a, b) => mtime(rollDir, b) - mtime(rollDir, a));
            }
            const content = await readFile(target, "utf8");
            ws.send(JSON.stringify({ type: "memory_file", path: file, file: path.basename(target), files, rollouts, content }));
            break;
          }
          case "asset_file_write": {
            const kind = String(msg.kind ?? "agent") as AssetKind;
            const file = resolveAssetFile(kind, msg.path);
            await writeFile(file, String(msg.content ?? ""), "utf8");
            ws.send(JSON.stringify({ type: "asset_file_saved", kind, path: file }));
            break;
          }
          case "asset_file_create": {
            // 按作用域与资产类型落位：agent=agents/<name>.md、skill=skills/<name>/SKILL.md、mcp=该级 mcp.json（幂等，已存在则直接返回内容）
            const kind = String(msg.kind ?? "agent") as AssetKind;
            if (kind === "mcp") {
              const file = mcpCandidates(assetOmpDir(kind, msg.scope, msg.cwd))[0];
              if (fs.existsSync(file)) {
                ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content: await readFile(file, "utf8") }));
                break;
              }
              await mkdir(path.dirname(file), { recursive: true });
              const content = `{\n  "mcpServers": {}\n}\n`;
              await writeFile(file, content, "utf8");
              ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
              break;
            }
            const name = String(msg.name ?? "").trim().toLowerCase();
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("名称仅允许小写字母、数字、-、_");
            const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), kind === "agent" ? "agents" : "skills");
            await mkdir(dir, { recursive: true });
            const file = kind === "agent" ? path.join(dir, `${name}.md`) : path.join(dir, name, "SKILL.md");
            if (fs.existsSync(file)) throw new Error(`${kind} 已存在: ${name}`);
            await mkdir(path.dirname(file), { recursive: true });
            const content =
              kind === "agent"
                ? `---\nname: ${name}\ndescription: \ntools: read, grep, glob\n---\n\n`
                : `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n`;
            await writeFile(file, content, "utf8");
            ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_skill_toggle": {
            const name = String(msg.name ?? "").trim();
            const enabled = Boolean(msg.enabled);
            if (!name) throw new Error("缺少技能名称");
            const disabled = new Set<string>(((H.settings.get("disabledExtensions") ?? []) as string[]));
            const ignored = new Set<string>(((H.settings.get("skills.ignoredSkills") ?? []) as string[]));
            const skillExtId = `skill:${name}`;
            if (enabled) {
              disabled.delete(skillExtId);
              ignored.delete(name);
            } else {
              disabled.add(skillExtId);
            }
            H.settings.set("disabledExtensions", Array.from(disabled));
            H.settings.set("skills.ignoredSkills", Array.from(ignored));
            await H.settings.flush();
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_skill_delete": {
            const rawPath = String(msg.path ?? "");
            const file = resolveAssetFile("skill", rawPath);
            if (!fs.existsSync(file)) throw new Error(`技能文件不存在: ${file}`);
            const skillDir = path.dirname(file);
            const parentDir = path.dirname(skillDir);
            // 如果是常规的 <skillName>/SKILL.md，安全删除整个技能目录
            if (path.basename(file).toLowerCase() === "skill.md" && parentDir && parentDir !== skillDir) {
              await rm(skillDir, { recursive: true, force: true });
            } else {
              await rm(file, { force: true });
            }
            ws.send(JSON.stringify({ type: "asset_file_deleted", kind: "skill", path: file }));
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "set_mcp_server_enabled": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const enabled = Boolean(msg.enabled);
            const userPath = path.join(H.agentDir, "mcp.json");
            const projectPath = msg.cwd
              ? (nearestProjectOmpDir(msg.cwd) ? path.join(nearestProjectOmpDir(msg.cwd)!, "mcp.json") : path.join(path.resolve(msg.cwd), ".omp", "mcp.json"))
              : undefined;
            await setMcpServerEnabled({
              userPath,
              projectPath: projectPath ?? userPath,
              sourcePath: msg.sourcePath ? String(msg.sourcePath) : undefined,
              name,
              enabled,
            });
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "test_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            mcpHealthCache.delete(name);
            const probe = await probeMcpServerHealth(msg.server || { name });
            ws.send(JSON.stringify({ type: "mcp_server_tested", name, status: probe.status, error: probe.error }));
            break;
          }
          case "save_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const cfg = msg.config || {};
            const scope = String(msg.scope ?? "profile");
            const targetDir = scope === "global"
              ? path.join(os.homedir(), ".omp", "agent")
              : scope === "profile"
              ? H.agentDir
              : scope.startsWith("project:")
              ? (nearestProjectOmpDir(scope.slice(8)) ?? path.join(path.resolve(scope.slice(8)), ".omp"))
              : H.agentDir;
            await mkdir(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, "mcp.json");
            await updateMCPServer(targetPath, name, cfg);
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "delete_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const src = msg.sourcePath ? String(msg.sourcePath) : undefined;
            const userPath = path.join(H.agentDir, "mcp.json");
            if (src && fs.existsSync(src) && (src.endsWith("mcp.json") || src.endsWith(".mcp.json"))) {
              await removeMCPServer(src, name);
            } else {
              await setMcpServerEnabled({
                userPath,
                projectPath: userPath,
                sourcePath: src,
                name,
                enabled: false,
              });
            }
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "switch_profile": {
            const p = String(msg.profile ?? "").trim();
            if (!p) throw new Error("Profile 名称不能为空");
            await applyProfile(p);
            ws.send(JSON.stringify({ type: "settings", settings: settingsWithAcp() }));
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            await handleListSessions(ws);
            try {
              ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            } catch {}
            ws.send(JSON.stringify({ type: "profile_switched", profile: H.currentProfile }));
            break;
          }
          case "terminal_create": {
            // 右栏终端：起真 PTY（pty.ts 的 pty-bridge 子进程），数据帧回推。
            // id 由前端生成（tab 级 persistentKey），create 前就可能收到 onData，故不能等返回值
            const id = String(msg.id ?? crypto.randomUUID());
            const cwd = String(msg.cwd ?? process.cwd()).trim() || process.cwd();
            const cols = Math.max(2, Math.min(500, Number(msg.cols) || 80));
            const rows = Math.max(2, Math.min(200, Number(msg.rows) || 24));
            const session = await createTerminal(
              ws,
              { id, cwd, cols, rows, shell: msg.shell ? String(msg.shell) : undefined },
              (data) => {
                try { ws.send(JSON.stringify({ type: "terminal_data", id, data })); } catch {}
              },
              (code) => {
                try { ws.send(JSON.stringify({ type: "terminal_exit", id, code })); } catch {}
              },
            );
            ws.send(JSON.stringify({ type: "terminal_created", id: session.id, shell: session.shell }));
            break;
          }
          case "terminal_write": {
            const t = terminalFor(ws, msg.id);
            if (t) t.send(String(msg.data ?? ""));
            break;
          }
          case "terminal_resize": {
            const t = terminalFor(ws, msg.id);
            if (t) t.resize(Math.max(2, Number(msg.cols) || 80), Math.max(2, Number(msg.rows) || 24));
            break;
          }
          case "terminal_dispose": {
            const t = terminalFor(ws, msg.id);
            if (t) t.dispose();
            break;
          }
          default:
            ws.send(JSON.stringify({ type: "error", message: `未知命令: ${msg.type}` }));
        }
      } catch (err) {
        // 单条命令失败不拖垮宿主，错误如实上报前端
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, kind: msg.kind ?? null, message: String(err) }));
        process.stderr.write(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
    close(ws) {
      // 前端断开：清理其名下终端 PTY，防孤儿 shell 进程
      disposeTerminalsOf(ws);
    },
  },
});

// ---------- 磁盘资产 ----------
// 取消 1s 指纹轮询自动推送:前端设置页(MCP/技能/子智能体)改用手动「刷新」按钮(list_agent_assets)

// 挂起的审批请求：requestId -> resolve（answer 为 undefined 即拒绝语义）
const pendingApprovals = new Map<string, { resolve: (v: string | undefined) => void }>();

function pushContext(ws: any, sessionId: string, entry: PoolEntry) {
  const u = entry.session.getContextUsage();
  if (u) {
    ws.send(
      JSON.stringify({
        type: "context",
        sessionId,
        tokens: u.tokens,
        window: u.contextWindow,
        percent: u.percent,
      }),
    );
  }
}

// 会话累计统计（TUI status-line 的 token/cache/cost/time 段汇总）：输入框下方状态行常驻显示。
// 与上下文明细卡（get_context_detail 的 breakdown/stats）不同，这里是「整会话」口径：
// tokens 含历史累加，时长含进行中窗口
function buildSessionStats(entry: PoolEntry) {
  const st = entry.session.getSessionStats();
  // 缓存利用率（TUI cache_hit 段同款公式）：cacheRead/(cacheRead+cacheWrite+input)。
  // 分母含未命中 input，Anthropic/OpenRouter（miss 记 input）与 DeepSeek（miss 记 input、
  // cacheWrite 为 0）都还原成 hit/(hit+miss)
  const promptTokens = st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite;
  return {
    tokens: st.tokens,
    cost: st.cost,
    cacheHitRate: promptTokens > 0 ? st.tokens.cacheRead / promptTokens : 0,
    // TUI cost 段同款：会话总成本 = 主会话成本 + advisor 成本（未启用 advisor 时为 0）
    advisorCost: entry.session.getAdvisorCost(),
    // 活跃时长含进行中窗口（与 TUI getActiveMs 一致：空闲墙钟不计）
    activeMs: entry.activeMs + (entry.activeStartedAt === null ? 0 : Date.now() - entry.activeStartedAt),
  };
}

function pushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  ws.send(JSON.stringify({ type: "session_stats", sessionId, ...buildSessionStats(entry) }));
}

function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify({ type: "event", sessionId, ...ui }));
    // todo 工具落盘后推送最新任务清单（TodoTracker 在工具结果后更新）
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      ws.send(JSON.stringify({ type: "todos", sessionId, phases: entry.session.getTodoPhases() }));
    }
    // 会话活跃时长计时（TUI status-line time_spent 同款）：agent_start 开窗（幂等，重入不双计），
    // 真正收尾的 agent_end 折窗；isTerminal === false 的中间 agent_end 之后还会续跑，不折
    if (ev.type === "agent_start") {
      if (entry.activeStartedAt === null) entry.activeStartedAt = Date.now();
    } else if (ev.type === "agent_end" && ev.isTerminal !== false && entry.activeStartedAt !== null) {
      entry.activeMs += Math.max(0, Date.now() - entry.activeStartedAt);
      entry.activeStartedAt = null;
    }
    // turn 真正结束后推送上下文占用（此时消息已定稿）；同时校准排队行（steer 已消费）
    if (ev.type === "agent_end" && ev.isTerminal !== false) {
      pushContext(ws, sessionId, entry);
      pushSessionStats(ws, sessionId, entry);
      // 收尾竞态兜底：底座在 run 收尾 abort 时，正在 claim 的队列消息会被丢弃且不回队
      // （agent.ts #prepareQueuedMessageBatch 的 dequeue-先移出 + abort-不 restore），表现为
      // 「上次快照里有、现在队列没有、dequeue hook 从未通知消费」。host 重新发送该消息。
      // parked 暂存的消息同样计入现存集合——它们不在底座队列是设计使然，不是被吞。
      const a = entry.session.agent as any;
      const cur = [...a.peekFollowUpQueue(), ...entry.parkedFollowUp, ...a.peekSteeringQueue()]
        .filter((m: any) => isUserQueuedMessage(m))
        .map((m: any) => toRestoredQueuedMessage(m).text);
      const curSet = new Set(cur);
      const lost = (entry.queuedTexts ?? []).filter(
        (t) => !curSet.has(t) && !(entry.consumedTexts ?? []).includes(t),
      );
      for (const t of lost) {
        process.stderr.write(`[host] 排队消息被收尾竞态吞掉，重新发送: ${t.slice(0, 60)}\n`);
        entry.consumedTexts.push(t);
        entry.session.prompt(t).catch((err: unknown) => {
          ws.send(JSON.stringify({ type: "error", sessionId, message: String(err) }));
        });
      }
      // 逐轮放回：parked 有剩余时放回 1 条并触发消费（每条独立 turn）。
      // 兜底重发刚起了新 run 的场合（lost 非空）本轮不放，等那个 run 的 agent_end 接续。
      if (lost.length === 0 && entry.parkedFollowUp.length > 0) {
        for (const m of releaseOneParked(entry)) a.followUp(m);
        // agent_end 事件先于 isStreaming 复位的窗口里 continue 会 busy：等 idle 后补一次
        a.continue().catch(() => {
          a.waitForIdle?.()
            .then(() => a.continue())
            .catch((err: unknown) => {
              process.stderr.write(`[host] 排队消息续轮触发失败: ${String(err)}\n`);
            });
        });
      }
      sendQueued(ws, sessionId, entry);
    }
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

  // 整棵 spawn 树共享根会话的 eventBus（sdk.ts:1341）：子代理 lifecycle/event/progress 帧都在上面。
  // host 侧补齐的派生数据（AgentProgress 本身没有的）：
  //   registeredAt —— lifecycle started 帧到达时刻（详情卡 Registered 时间戳）
  //   name / parent —— task 工具调用的 args 里带子代理名，toolCallId 记归属方
  //                   （根会话=Main，子代理流里=该子代理），parentToolCallId 反查「Spawned by X」
  const subRegistered = new Map<string, number>(); // subagentId -> started 时刻
  const subSpawnCall = new Map<string, string>(); // subagentId -> 父 task toolCallId
  const callOwner = new Map<string, { owner: string; names: string[] }>(); // task toolCallId -> 归属 + spawn 的子代理名
  const spawnTools: Record<string, true> = { task: true, agent: true };
  const spawnNames = (args: Record<string, unknown>): string[] => {
    const items = Array.isArray(args.tasks) ? args.tasks : [args];
    return items.map((t) => (t && typeof t === "object" && "name" in t && typeof t.name === "string" ? t.name : undefined)).filter((n): n is string => !!n);
  };
  const subName = (id: string, agent: string): string => {
    const call = callOwner.get(subSpawnCall.get(id) ?? "");
    return call?.names[0] ?? agent;
  };
  const subParent = (id: string): string => {
    const spawnCall = subSpawnCall.get(id);
    if (!spawnCall) return "Main";
    const owner = callOwner.get(spawnCall);
    return owner?.owner ?? "Main";
  };
  // 根会话里的 task 调用：归属 Main
  const unsubSpawnRoot = entry.session.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start" && spawnTools[ev.toolName]) {
      callOwner.set(ev.toolCallId, { owner: "Main", names: spawnNames(ev.args) });
    }
  });
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    if (p.parentToolCallId) subSpawnCall.set(p.id, p.parentToolCallId);
    if (p.status === "started") subRegistered.set(p.id, Date.now());
    ws.send(
      JSON.stringify({
        type: "subagent_lifecycle",
        sessionId,
        subagentId: p.id,
        agent: p.agent,
        description: p.description,
        status: p.status,
        name: subName(p.id, p.agent),
        parent: subParent(p.id),
        registeredAt: subRegistered.get(p.id),
        detached: p.detached ?? false,
      }),
    );
    // 终态帧后补发最后一帧 progress（节流可能压掉），保证结束时成本/token 落到最终值
    if (p.status !== "started") {
      const last = subLastProgress.get(p.id);
      if (last) ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, ...last }));
    }
  });
  // 聚合进度帧：成本/时长/请求/工具/token/上下文（高频且累积，500ms 节流；状态变化立即发）
  const subLastProgress = new Map<string, Record<string, unknown>>();
  const subSentAt = new Map<string, number>();
  const subSentStatus = new Map<string, string>();
  const unsubProgress = eventBus.on("task:subagent:progress", (p: any) => {
    const pr = p.progress ?? {};
    const payload = {
      agent: p.agent,
      status: pr.status,
      task: pr.task,
      cost: pr.cost,
      durationMs: pr.durationMs,
      requests: pr.requests,
      toolCount: pr.toolCount,
      tokens: pr.tokens,
      contextTokens: pr.contextTokens,
      contextWindow: pr.contextWindow,
      currentTool: pr.currentTool,
      currentToolArgs: pr.currentToolArgs,
      currentToolStartMs: pr.currentToolStartMs,
      lastIntent: pr.lastIntent,
      resolvedModel: pr.resolvedModel,
      resolvedThinkingLevel: pr.resolvedThinkingLevel,
      recentTools: pr.recentTools,
    };
    subLastProgress.set(p.id, payload);
    const now = Date.now();
    const statusChanged = subSentStatus.get(p.id) !== pr.status;
    if (!statusChanged && now - (subSentAt.get(p.id) ?? 0) < 500) return;
    subSentAt.set(p.id, now);
    subSentStatus.set(p.id, pr.status);
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, name: subName(p.id, p.agent), parent: subParent(p.id), registeredAt: subRegistered.get(p.id), ...payload }));
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    // 子代理流里的 task 调用：归属该子代理（嵌套 spawn）
    if (event.type === "tool_execution_start" && spawnTools[event.toolName]) {
      callOwner.set(event.toolCallId, { owner: subName(id, id), names: spawnNames(event.args) });
    }
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify({ type: "subagent_event", sessionId, subagentId: id, ...ui }));
  });
  // 消费前通知：即将注入的排队/steer 用户消息推给 UI（气泡转正）；同时记入已消费
  // 清单，供 turn_end 的收尾竞态兜底 diff 排除（hook 触发 ≠ 注入成功，但不重复重发）
  const detachDequeueHook = entry.session.agent.addBeforeQueuedMessageDequeueHook(() => {
    const texts = [...entry.session.agent.peekFollowUpQueue(), ...entry.session.agent.peekSteeringQueue()]
      .filter((m) => isUserQueuedMessage(m))
      .map((m) => toRestoredQueuedMessage(m).text);
    if (texts.length > 0) {
      entry.consumedTexts.push(...texts);
      ws.send(JSON.stringify({ type: "steer_consumed", sessionId, texts }));
    }
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubSpawnRoot();
    unsubLifecycle();
    unsubProgress();
    unsubEvents();
    detachDequeueHook();
  };
  sessions.set(sessionId, entry);
}

async function handleCreateSession(ws: any, cwd?: string, modelStr?: string, thinkingLevel?: string) {
  const workDir = typeof cwd === "string" && cwd ? cwd : defaultCwd;
  const targetModel = modelStr ? H.scopedModels.find((m) => `${m.provider}/${m.id}` === modelStr) : undefined;
  const { sessionId, entry, eventBus } = await createSessionCore(
    workDir,
    SessionManager.create(workDir),
    [],
    targetModel,
  );
  if (thinkingLevel) {
    try {
      entry.session.setThinkingLevel(thinkingLevel);
    } catch {}
  }
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: workDir,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
    }),
  );
  process.stderr.write(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir} model=${modelStr ?? "default"} thinking=${thinkingLevel ?? "default"}（活跃 ${sessions.size}）\n`);
}

async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error("缺少 path");
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // 会话原始 cwd：getEntries() 不含 session header，用 peekSessionInit 读
  // （open 内部同源；目录不可达时它返回 null，兜底 HOME）
  const peek = await SessionManager.peekSessionInit(sessionPath);
  const workCwd = peek?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  // 历史会话的活跃时长初值：内存计时器只覆盖本次打开后的时间，从磁盘条目按轮次累加补上存量
  entry.activeMs = sumRunDurationMs(entries);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
    }),
  );
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  // 恢复会话的存量任务清单（TodoTracker 构造时从 transcript 分支同步）
  const restored = entry.session.getTodoPhases();
  if (restored.length > 0) {
    ws.send(JSON.stringify({ type: "todos", sessionId, phases: restored }));
  }
  // 恢复会话的初始上下文占用（system prompt + 历史）
  pushContext(ws, sessionId, entry);
  // 恢复会话的整会话统计（tokens/cost 从磁盘 assistant 消息的 usage 累加；时长为内存态，重载后从 0 起算）
  pushSessionStats(ws, sessionId, entry);
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
  // 内存池兜底：底座懒建会话文件（首条内容才落盘），仅扫磁盘会漏掉刚建、还没写内容的
  // 会话——UI 的「活跃会话不在列表即弹回欢迎页」校验会误杀新建会话。
  // 已被用户移除的项目跳过：活跃会话不能把移除的项目顶回列表（否则 remove 永不生效）。
  const listed = new Set(all.map((s: any) => s.path));
  for (const [sid, entry] of sessions.entries()) {
    if (listed.has(entry.path)) continue;
    if (H.desktopProjects.removedProjects.includes(entry.cwd)) continue;
    const list = byProject.get(entry.cwd) ?? [];
    list.push({
      id: sid,
      path: entry.path,
      title: entry.title, // 懒建未落盘的会话走内存兜底（含 rename 后的标题）
      firstMessage: "",
      modified: new Date(),
      messageCount: 0,
      cwd: entry.cwd,
    });
    byProject.set(entry.cwd, list);
    listed.add(entry.path);
  }
  // 历史扫描：新出现的 project 并入所有项目列表（启动/UI 重连时都会走到这里）
  if (mergeHistoryProjects([...byProject.keys()])) await saveDesktopProjects();
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
          archived: H.desktopProjects.archivedSessions.includes(s.path),
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: H.desktopProjects.allProjects,
      removedProjects: H.desktopProjects.removedProjects,
      expandedProjects: H.desktopProjects.expandedProjects,
      pinnedSessions: H.desktopProjects.pinnedSessions,
    }),
  );
}

// 前端随 prompt 下发的附件：图片为 base64，文本类为文件内容
interface PromptAttachment {
  kind: "image" | "text";
  mime?: string;
  data?: string; // image：base64（无 data: 前缀）
  name?: string; // text：文件名
  text?: string; // text：文件内容
}

async function handlePrompt(
  ws: { send(data: string): unknown },
  sessionId: string,
  text: string,
  files?: PromptAttachment[],
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  // 附件：图片走 SDK ImageContent；文本类文件内容内联进 prompt（与 CLI 粘贴文件一致）
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const f of files ?? []) {
    if (f.kind === "image" && typeof f.data === "string") {
      images.push({ type: "image", data: f.data, mimeType: String(f.mime ?? "image/png") });
    }
  }
  const textBlocks = (files ?? [])
    .filter((f) => f.kind === "text" && typeof f.text === "string")
    .map((f) => {
      const name = String(f.name ?? "file").replace(/"/g, "&quot;");
      return `<attached-file name="${name}">\n${f.text}\n</attached-file>`;
    });
  let finalText = text;
  if (textBlocks.length > 0) {
    finalText = text ? `${textBlocks.join("\n\n")}\n\n${text}` : textBlocks.join("\n\n");
  }
  if (!finalText && images.length === 0) throw new Error("消息为空");
  if (!finalText) finalText = "请查看附件图片。";
  entry.transcript.push({ role: "user", text: finalText });
  // 命令立即返回；turn 产物全部走事件流。流式中经 streamingBehavior 排队为 followUp
  // （当前 loop 完全自动消费触发新 turn，不打断进行中的处理；idle 时该参数被底座忽略照常开 turn）
  entry.session
    .prompt(finalText, {
      ...(images.length > 0 ? { images } : {}),
      streamingBehavior: "followUp",
    })
    .then(() => {
      // 流式排队后立即修剪：底座队列只留最早 1 条，其余进 parked（本轮 run 的注入边界
      // 只能带走这 1 条，避免多条拼车；后续逐轮 agent_end 放回消费）
      parkFollowUpTail(entry);
      sendQueued(ws, sessionId, entry);
    }) // 入队/开 turn 后校准前端排队行
    .catch((err: unknown) => {
      ws.send(JSON.stringify({ type: "error", sessionId, message: String(err) }));
    });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}

// ---------- 排队消息 RPC ----------
// 队列语义（仿 ZCode）：流式中发送的消息默认排队（followUp，当前 loop 完全处理完
// 后自动消费第 1 条触发新 prompt）；「立即发送」把某条转为 steer（当前工具批次后注入）。
// 索引一律指「用户消息」在对应队列过滤序列中的下标（跳过系统 notice，与 queued 帧一致）；
// followUp 的索引基于完整视图 = 底座 followUp 队列 + parked 暂存区（顺序拼接）。
//
// 底座注入边界（工具批次后 / yield 边界）会把 followUp 队列 drain 到排空，多条排队会被
// 同一轮 run 拼车发出（实测一次模型回复同时答复多条）。因此 host 维持不变式：底座
// followUp 队列最多留 1 条用户消息（下一个待消费的），其余暂存 parkedFollowUp；每轮
// agent_end 放回 1 条并触发消费——排队消息逐轮 FIFO，每轮一条独立 turn。

function sendQueued(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const agent = entry.session.agent;
  const view = (list: readonly any[]) =>
    list.filter((m) => isUserQueuedMessage(m)).map((m) => toRestoredQueuedMessage(m));
  const followUp = [...view(agent.peekFollowUpQueue()), ...view(entry.parkedFollowUp)];
  const steering = view(agent.peekSteeringQueue());
  // 竞态兜底的快照：完整视图 + steering 用户消息全量（turn_end 时 diff「上次有/现在无/未通知消费」= 被吞）
  entry.queuedTexts = [...followUp, ...steering].map((m) => m.text);
  ws.send(JSON.stringify({ type: "queued", sessionId, followUp, steering }));
}

// 把底座 followUp 队列修剪为最多 1 条用户消息：第 2 条起（含各自前导隐藏伴随）移入
// parked 暂存，防止当前 run 的注入边界把整队消息一次性带走
function parkFollowUpTail(entry: PoolEntry) {
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  let n = 0;
  let cut = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === 2) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return;
  let start = cut;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  entry.parkedFollowUp.push(...queue.filter((_, i) => i >= start));
  agent.replaceQueues(agent.peekSteeringQueue(), queue.filter((_, i) => i < start));
}

// 从 parked 暂存摘出第 pi 条用户消息（含前导隐藏伴随），返回摘出的元素数组
function extractParkedAt(entry: PoolEntry, pi: number): any[] {
  const parked = entry.parkedFollowUp;
  let n = -1;
  let target = -1;
  for (let i = 0; i < parked.length; i++) {
    if (!isUserQueuedMessage(parked[i])) continue;
    if (++n === pi) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`暂存排队消息不存在: ${pi}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(parked[start - 1])) start--;
  const extracted = parked.slice(start, target + 1);
  entry.parkedFollowUp = parked.filter((_, i) => i < start || i > target);
  return extracted;
}

// 放回 parked 首条（含前导伴随）到 agent 队列。队列元素是入队时的原结构，直接回队即保留图片等
function releaseOneParked(entry: PoolEntry): any[] {
  const u = entry.parkedFollowUp.findIndex((m) => isUserQueuedMessage(m));
  if (u < 0) return [];
  const released = entry.parkedFollowUp.slice(0, u + 1);
  entry.parkedFollowUp = entry.parkedFollowUp.slice(u + 1);
  return released;
}

function handlePeekQueued(ws: { send(data: string): unknown }, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  sendQueued(ws, sessionId, entry);
}

// 移除第 index 条用户消息及其紧邻在前的隐藏伴随（图片描述等），返回过滤后的新数组
function removeUserMessage(queue: readonly any[], index: number): any[] {
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`排队消息不存在: ${index}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  return queue.filter((_, i) => i < start || i > target);
}

function handleDropQueued(
  ws: { send(data: string): unknown },
  sessionId: string,
  which: "followUp" | "steering",
  index?: number,
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = which === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
  let next: any[];
  if (index === undefined) {
    // 全清：只清用户消息及其隐藏伴随，保留系统 notice（goal/plan/budget 等）
    next = queue.filter((m) => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m));
    if (which === "followUp") entry.parkedFollowUp = [];
  } else if (which === "followUp" && index >= queue.filter((m) => isUserQueuedMessage(m)).length) {
    // 完整视图后半段：目标在 parked 暂存
    extractParkedAt(entry, index - queue.filter((m) => isUserQueuedMessage(m)).length);
    next = queue;
  } else {
    next = removeUserMessage(queue, index);
  }
  agent.replaceQueues(
    which === "steering" ? next : agent.peekSteeringQueue(),
    which === "steering" ? agent.peekFollowUpQueue() : next,
  );
  sendQueued(ws, sessionId, entry);
}

// 立即发送：把 followUp 第 index 条（完整视图，含 parked 暂存）转为 steer 注入；
// 剩余排队消息全部 park，本轮 run 只注入被点的这一条
async function handleSendNow(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  const queueUserCount = queue.filter((m) => isUserQueuedMessage(m)).length;
  let restored;
  if (index < queueUserCount) {
    let n = -1;
    let target = -1;
    for (let i = 0; i < queue.length; i++) {
      if (!isUserQueuedMessage(queue[i])) continue;
      if (++n === index) {
        target = i;
        break;
      }
    }
    if (target < 0) throw new Error(`排队消息不存在: ${index}`);
    restored = toRestoredQueuedMessage(queue[target]);
    agent.replaceQueues(agent.peekSteeringQueue(), removeUserMessage(queue, index));
  } else {
    // 目标在 parked 暂存：摘出后经 steer 重新入队（图片经 SDK 重建描述，罕见路径）
    const [msg] = extractParkedAt(entry, index - queueUserCount).filter((m) => isUserQueuedMessage(m));
    restored = toRestoredQueuedMessage(msg);
  }
  await entry.session.steer(restored.text, restored.images);
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
}

// 放回队列：把 steer 队列第 index 条挪回 followUp 顶端（去掉 steer 标记）
function handleRequeue(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = agent.peekSteeringQueue();
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`steer 消息不存在: ${index}`);
  const moved: any = { ...queue[target] };
  delete moved.steering;
  agent.replaceQueues(removeUserMessage(queue, index), [moved, ...agent.peekFollowUpQueue()]);
  // moved 成为底座队列唯一第 1 条，原队列首条退入 parked 头部（保持 FIFO 顺序）
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
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
runLimitsRefresh();
setInterval(runLimitsRefresh, LIMITS_REFRESH_INTERVAL_MS);
