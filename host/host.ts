// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话不落盘（SessionManager.inMemory()），关进程即丢，持久化后置
// - UI 壳通过 WebSocket 连入：命令（create_session/prompt/get_messages）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
import {
  createAgentSession,
  SessionManager,
  Settings,
  discoverAuthStorage,
  ModelRegistry,
  AgentRegistry,
} from "@oh-my-pi/pi-coding-agent";
import os from "node:os";
import path from "node:path";

const cwd = os.homedir();
const agentDir = path.join(cwd, ".omp", "agent");

// ---------- 进程级底座（全进程一份，逐 session 共享） ----------
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd, agentDir });

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
  unsubscribe: () => void;
  transcript: TranscriptItem[];
  assistantDraft: string; // 当前 turn 的流式文本累积，turn_end 时定稿
};
const sessions = new Map<string, PoolEntry>();

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

// ---------- WebSocket 服务 ----------
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // 动态端口：多 workspace 并行开同名应用时固定端口会撞
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "ready" }));
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
            await handleCreateSession(ws);
            break;
          case "prompt":
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""));
            break;
          case "get_messages":
            handleGetMessages(ws, msg.sessionId);
            break;
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

async function handleCreateSession(ws: any) {
  const sessionId = crypto.randomUUID();
  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings,
    model: modelOverride,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager: SessionManager.inMemory(),
    disableExtensionDiscovery: true,
    enableMCP: false,
  });
  const entry: PoolEntry = { session, unsubscribe: () => {}, transcript: [], assistantDraft: "" };
  entry.unsubscribe = session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify({ type: "event", sessionId, ...ui }));
  });
  sessions.set(sessionId, entry);
  const model = modelOverride ? `${modelOverride.provider}/${modelOverride.id}` : "默认";
  ws.send(JSON.stringify({ type: "session_created", sessionId, model }));
  process.stderr.write(`[host] 会话建立 ${sessionId.slice(0, 8)}（共 ${sessions.size} 个）\n`);
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
  // Tauri 壳退出兜底；inMemory 无落盘，尽力 dispose 后即退
  await Promise.allSettled([...sessions.values()].map((e) => e.session.dispose()));
  process.exit(0);
});

console.log(`READY ws://127.0.0.1:${server.port}`);
