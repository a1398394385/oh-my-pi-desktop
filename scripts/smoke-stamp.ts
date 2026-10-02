// Stamping smoke test: verify the position-stamp (hi/seq) contract of host-initiated pushes.
// Assertions: ready carries hi; host-initiated frames (event/queued/context etc.) share one hi with a strictly increasing seq;
// RPC responses (session_created/messages etc.) carry no hi.
// Usage: bun scripts/smoke-stamp.ts [host ws url] (spawns the host itself when omitted)
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const state = { readyHi: "", lastSeq: 0, stampedFrames: 0, sawContext: false, sawQueued: false };
let tmpCwd = "";

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "inherit"],
  });
  wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
    child!.stdout!.setEncoding("utf8");
    child!.stdout!.on("data", function onLine(chunk) {
      const m = chunk.match(/READY (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        child!.stdout!.off("data", onLine);
        resolve(m[1]);
      }
    });
  }).catch((e) => fail(String(e)));
}

const STAMPED = new Set(["event", "subagent_event", "subagent_lifecycle", "todos", "context", "approval_request", "queued", "steer_consumed"]);
const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("90s 内未完成全部断言"), 90_000);

// Uniform per-frame check: stamped frames agree on hi + strictly increasing seq; RPC response frames must not carry hi
// (ready is the exception: the handshake frame carries hi for UI instance alignment but takes no seq)
function checkFrame(msg: any) {
  if (msg.type === "ready") {
    if (msg.seq !== undefined) fail("ready 不应占事件序号");
    return;
  }
  if (STAMPED.has(msg.type)) {
    if (msg.hi !== state.readyHi) fail(`${msg.type} 帧 hi 不一致: ${msg.hi} ≠ ${state.readyHi}`);
    if (!(typeof msg.seq === "number" && msg.seq > state.lastSeq)) fail(`${msg.type} 帧 seq 未严格递增: ${msg.seq} ≤ ${state.lastSeq}`);
    state.lastSeq = msg.seq;
    state.stampedFrames++;
    return;
  }
  if (msg.hi !== undefined) fail(`RPC 响应 ${msg.type} 不应带 hi`);
}

ws.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data));
  checkFrame(msg);
  switch (msg.type) {
    case "ready": {
      if (typeof msg.hi !== "string" || msg.hi.length < 8) fail("ready 应带非空 hi");
      state.readyHi = msg.hi;
      tmpCwd = await mkdtemp(`${tmpdir()}/omp-stamp-smoke-`);
      ws.send(JSON.stringify({ type: "create_session", cwd: tmpCwd }));
      break;
    }
    case "session_created":
      // Reply with something very short, completing a turn so the event stream actually produces output
      ws.send(JSON.stringify({ type: "prompt", sessionId: msg.sessionId, text: "只回复两个字：完成" }));
      break;
    case "event":
      if (msg.kind === "turn_end") {
        // After turn_end the host pushes the context frame synchronously; the queued frame was pushed when the prompt was enqueued.
        // Wait a short beat to wrap up; pass once both frames have been seen
        setTimeout(() => {
          if (!state.sawContext) fail("turn_end 后应收到盖戳的 context 帧");
          if (!state.sawQueued) fail("prompt 后应收到盖戳的 queued 帧");
          console.log(`盖戳冒烟通过 ✓（${state.stampedFrames} 帧盖戳推送，seq ${1}..${state.lastSeq} 连续，hi=${state.readyHi.slice(0, 8)}…）`);
          clearTimeout(failTimeout);
          ws.close();
          if (child?.pid) child.kill("SIGTERM");
          if (tmpCwd) rm(tmpCwd, { recursive: true, force: true }).catch(() => {});
        }, 600);
      }
      break;
    case "context":
      state.sawContext = true;
      break;
    case "queued":
      state.sawQueued = true;
      break;
  }
};
ws.onerror = () => fail("WS 连接错误");
