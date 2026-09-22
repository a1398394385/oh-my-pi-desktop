// 盖戳冒烟：验证 host 主动推送的位置标识（hi/seq）契约。
// 断言：ready 带 hi；event/queued/context 等主动推送帧 hi 一致且 seq 严格递增；
// RPC 响应（session_created/messages 等）不带 hi。
// 用法：bun scripts/smoke-stamp.ts [宿主ws地址]（不传则自行拉起宿主）
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

// 每帧统一检查：盖戳帧 hi 一致 + seq 严格递增；RPC 响应帧不得带 hi
//（ready 例外：握手帧带 hi 供 UI 对齐实例身份，但不占 seq）
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
      // 回一句极短的，走完一个 turn 让事件流真实产出
      ws.send(JSON.stringify({ type: "prompt", sessionId: msg.sessionId, text: "只回复两个字：完成" }));
      break;
    case "event":
      if (msg.kind === "turn_end") {
        // turn_end 后 host 同步推 context 帧；queued 帧在 prompt 入队时已推。
        // 等一小拍收尾，两条帧都见过即通过
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
