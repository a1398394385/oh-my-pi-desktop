// UI store layer send-path repro: pinpoint where the React state machine breaks on "cannot send in a historical session / on the second round".
// Run: bun scripts/smoke-ui-send.ts
// Approach: install happy-dom globals + a mock WebSocket playing the host (frame routing goes through the real onMessage),
// replay the full frame sequence of "two rounds in a new session + load_session historical session" and assert stage by stage
// The preconditions for sendPrompt's direct-send branch (activePath / openSessions entry / streaming / ws).
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const win = new Window({ url: "http://localhost/" });
globalThis.window = win as unknown as typeof globalThis.window;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.navigator = win.navigator;
globalThis.location = win.location;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
globalThis.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);

// ---- mock WebSocket: capture every message the UI sends; host replies go through hostFrame() ----
const sent: Array<Record<string, any>> = [];
let mockWs: {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
} | null = null;

class MockWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    mockWs = this;
  }
  send(data: string) {
    sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}
(globalThis as any).WebSocket = MockWebSocket;
(globalThis.window as any).__TAURI__ = {
  core: { invoke: async (cmd: string) => (cmd === "ws_url" ? "ws://mock-host" : null) },
};

const store = await import("../ui-src/store");
const { useAppStore } = store;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("✗ " + msg);
    console.error("  当前 store 关键态:", JSON.stringify({
      activePath: useAppStore.getState().activePath,
      isCreatingNew: useAppStore.getState().isCreatingNew,
      openSessionsKeys: [...useAppStore.getState().openSessions.keys()],
      wsReadyState: useAppStore.getState().ws?.readyState,
    }));
    process.exit(1);
  }
}

let seq = 0;
/** Host reply frame: routes through the real onmessage path (events stamped with hi/seq) */
function hostFrame(frame: Record<string, any>) {
  if (frame.type === "event") {
    frame.hi = "mock-host";
    frame.seq = ++seq;
  }
  mockWs!.onmessage!({ data: JSON.stringify(frame) });
}

const SESSION_PATH = "/tmp/omp-ui-send-probe.jsonl";
const sentTypes = () => sent.map((m) => m.type);

// ---------- Connect ----------
await useAppStore.getState().connect();
mockWs!.onopen!();
await sleep(50);
hostFrame({ type: "ready", hi: "mock-host", approvalMode: "normal" });
// list_sessions reply triggered by onopen: an empty project list
hostFrame({
  type: "session_list",
  projects: [],
  allProjects: [],
  removedProjects: [],
  expandedProjects: [],
  pinnedSessions: [],
});
assert(sentTypes().includes("list_sessions"), "连接建立后应发 list_sessions");

// ---------- Scenario 1: two rounds in a new session ----------
console.log("—— 场景 1：新会话（create_session → prompt → turn_end → 第二轮前置态）——");
useAppStore.setState({ isCreatingNew: true });
useAppStore.setState({ pendingNewPrompt: { text: "第一条", files: [] } });
useAppStore.getState().send({ type: "create_session", cwd: "/tmp" });
assert(sent.some((m) => m.type === "create_session"), "应发出 create_session");

hostFrame({
  type: "session_created",
  sessionId: "sess-1",
  path: SESSION_PATH,
  cwd: "/tmp",
  model: null,
  thinking: "auto",
  isGit: false,
  title: null,
});
const st1 = useAppStore.getState();
assert(st1.activePath === SESSION_PATH, `session_created 后 activePath 应指向会话（实际 ${st1.activePath}）`);
assert(st1.openSessions.has(SESSION_PATH), "openSessions 应建条目");
assert(st1.isCreatingNew === false, "session_created 应清新建态");
assert(sent.some((m) => m.type === "prompt" && m.text === "第一条"), "pendingNewPrompt 应由 session_created 回执代发");

// Reply with turn_end (run final): the handler will send list_sessions
hostFrame({ type: "event", kind: "turn_end", sessionId: "sess-1", runEnd: true, usage: null });
await sleep(20);
assert(sentTypes().slice(-3).includes("list_sessions"), "turn_end 后应重拉 list_sessions");
// The key reply: the session is in the list (host smoke tests proved a real host always includes it)
hostFrame({
  type: "session_list",
  projects: [
    {
      cwd: "/tmp",
      sessions: [
        { id: "sess-1", path: SESSION_PATH, title: "测试", firstMessage: "第一条", modified: new Date().toISOString(), messageCount: 1, cwd: "/tmp" },
      ],
    },
  ],
  allProjects: ["/tmp"],
  removedProjects: [],
  expandedProjects: [],
  pinnedSessions: [],
});
await sleep(20);

// ==== All preconditions for the second-round send (the guard chain of the direct-send branch in Composer.tsx:353-365) ====
const st2 = useAppStore.getState();
assert(st2.ws && st2.ws.readyState === 1, "ws 应就绪");
assert(st2.isCreatingNew === false, "不应处于新建态");
const s2 = st2.activePath ? st2.openSessions.get(st2.activePath) : undefined;
assert(!!s2, "activeOpen() 应存在（s 为空则 sendPrompt 走 create 分支）");
assert(s2!.streaming === false, `streaming 应为 false（卡 true 会进排队不直发，实际 ${s2!.streaming}）`);
console.log("✓ 新会话第二轮直发前置态全部满足");

// ---------- Scenario 2: load_session historical session ----------
console.log("—— 场景 2：load_session 历史会话 → 续发前置态 ——");
// First simulate LRU eviction/reopen: clear openSessions then go through openSessionByPath (equivalent to clicking a history row in the sidebar)
useAppStore.setState({ openSessions: new Map(), activePath: null });
sent.length = 0;
store.openSessionByPath(SESSION_PATH);
assert(sent.some((m) => m.type === "load_session"), "openSessionByPath 未命中池应发 load_session");
hostFrame({
  type: "session_created",
  sessionId: "sess-2",
  path: SESSION_PATH,
  cwd: "/tmp",
  model: null,
  thinking: "auto",
  isGit: false,
  title: "测试",
});
hostFrame({
  type: "messages",
  sessionId: "sess-2",
  messages: [
    { role: "user", text: "第一条" },
    { role: "assistant", text: "OK" },
  ],
});
await sleep(20);
const st3 = useAppStore.getState();
assert(st3.activePath === SESSION_PATH, `load 后 activePath 应指向会话（实际 ${st3.activePath}）`);
const s3 = st3.openSessions.get(SESSION_PATH);
assert(!!s3, "load 后 openSessions 应建条目");
assert(s3!.items.length === 2, `messages 重建条目数应为 2（实际 ${s3!.items.length}）`);
assert(s3!.streaming === false, "load 后 streaming 应为 false");
assert(st3.ws && st3.ws.readyState === 1 && st3.isCreatingNew === false, "ws/新建态正常");
console.log("✓ 历史会话续发前置态全部满足");

// ---------- Regression assertion: sendPrompt must pass draftKey to read the draft slot ----------
// P7 Lexical migration dropped the param (getDraftText() with no args reads the welcome slot): the welcome page writes and reads the same slot so the first message sends,
// but after switching to the session view, writing the path slot while reading welcome always yields empty -> session view / historical sessions all silently fail to send
const composerSrc = readFileSync(join(import.meta.dir, "../ui-src/components/Composer.tsx"), "utf8");
assert(/\bgetDraftText\(draftKey\)/.test(composerSrc), "sendPrompt 须以 getDraftText(draftKey) 读草稿槽");
assert(!/\bgetDraftText\(\)/.test(composerSrc), "禁止无参 getDraftText()（默认 welcome 槽，会话视图读错槽）");
console.log("✓ 回归断言：sendPrompt 草稿槽读键与写键一致");

console.log("UI store 层冒烟通过 ✓（若真机仍不能发，断点在 Composer 组件层：Lexical Enter → sendPrompt 触发链）");
process.exit(0);
