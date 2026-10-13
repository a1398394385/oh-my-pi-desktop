// Subagent session-view smoke: opening a RUNNING subagent's transcript page must light up the
// "working Ns" row + spinner immediately — the frame-driven path alone (syncSubViewStream) misses
// long tool runs, which emit no progress events — and the terminal lifecycle must clear it again.
// The subagent store state is driven through the real frontend store against a real host.
// Run: bun run smoke:subagent-subview  (OMP_DESKTOP_MODEL=<provider/model> to override the model)
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { Window } from "happy-dom";
import type { HostFrame } from "../ui-src/types/frames";

let child: ChildProcess | null = null;
let createdFile: string | null = null;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (createdFile) void rm(createdFile).catch(() => {});
  child?.kill("SIGTERM");
  process.exit(1);
}

// ---- happy-dom environment so the frontend store can be imported headlessly ----
const win = new Window({ url: "http://localhost/index.html" });
globalThis.window = win as unknown as Window & typeof globalThis;
globalThis.document = win.document as unknown as Document;
globalThis.localStorage = win.localStorage;
globalThis.navigator = win.navigator as unknown as Navigator;
globalThis.matchMedia = ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as unknown as typeof globalThis.matchMedia;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;

// index first: it evaluates the ws slice module before the latter's circular import back
const { useAppStore } = await import("../ui-src/store/index");
const { onMessage } = await import("../ui-src/store/ws");

child = spawn("bun", ["host/host.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "inherit"],
});
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("宿主 40s 未就绪")), 40_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolve(m[1]);
    }
  });
}).catch((e) => fail(String(e)));

const ws = new WebSocket(wsUrl);
const hardTimeout = setTimeout(() => fail("120s 内未完成断言"), 120_000);

let parentPath = "";
let childPath: string | null = null;
let litChecked = false;
let clearedChecked = false;

/** The child transcript view's stream state (what WorkSec/ChatLoading read) */
function childView() {
  const v = childPath ? useAppStore.getState().openSessions.get(childPath) : undefined;
  return { isSubagent: v?.isSubagent, streaming: v?.streaming, turnStartAt: v?.turnStartAt ?? null };
}

function done(): void {
  clearTimeout(hardTimeout);
  console.log("子代理会话页流式状态冒烟通过 ✓");
  ws.close();
  child?.kill("SIGTERM");
  void (async () => {
    if (createdFile) await rm(createdFile).catch(() => {});
    process.exit(0);
  })();
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as HostFrame & Record<string, unknown>;
  if (msg.type === "ready") {
    ws.send(JSON.stringify({ type: "create_session" }));
    return;
  }
  onMessage(msg);
  if (msg.type === "error") fail(`收到 error: ${String(msg.message)}`);
  if (msg.type === "session_created" && !parentPath) {
    parentPath = String(msg.path);
    createdFile = parentPath;
    useAppStore.setState({ ws: ws as unknown as WebSocket });
    ws.send(
      JSON.stringify({
        type: "prompt",
        sessionId: msg.sessionId,
        text: "用 task 工具派一个子代理执行 `sleep 45` 命令（等它执行完），然后只回答 done。",
      }),
    );
    return;
  }
  if (msg.type === "subagent_lifecycle") {
    const sessionFile = typeof msg.sessionFile === "string" ? msg.sessionFile : null;
    if (msg.status === "started" && sessionFile && !childPath) {
      childPath = sessionFile;
      // Enter the page mid-run, i.e. while the child sits inside its long `sleep` tool call —
      // the case where no progress event (and thus no lighting frame) is produced.
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "load_session", path: childPath }));
        // 3s: the load_session reply must land and the page must already read as running
        setTimeout(() => {
          const v = childView();
          if (!v.isSubagent) fail("load_session 后 store 中无该子会话条目（isSubagent 未置位）");
          if (!v.streaming || !v.turnStartAt) {
            fail(`运行中打开子会话页未点亮：streaming=${v.streaming} turnStartAt=${v.turnStartAt}（长工具期无 progress 帧，必须由父会话记录种子点亮）`);
          }
          litChecked = true;
          console.log("运行中打开 → streaming=true, turnStartAt 已设 ✓");
        }, 3000);
      }, 10_000);
    }
    if (msg.status === "completed" && litChecked) {
      // Terminal lifecycle must retract the running state on the opened child view
      setTimeout(() => {
        const v = childView();
        if (v.streaming || v.turnStartAt) fail(`终态 lifecycle 未清除子会话页运行态：streaming=${v.streaming}`);
        clearedChecked = true;
        console.log("终态 lifecycle → streaming=false ✓");
        done();
      }, 1500);
    }
    return;
  }
};

ws.onerror = () => fail("WS 错误");
