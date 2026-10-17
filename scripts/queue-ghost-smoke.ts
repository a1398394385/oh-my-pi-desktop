// Queue-ghost smoke: the degenerate-idle race (BUG-080, the BUG-071 residual).
// A plain send whose prompt RPC lands on an idle host (the UI's streaming flag
// lagged by a frame) degenerates into a direct new turn: the message is
// consumed with NO queue mutation and NO steer_consumed, so the client's
// optimistic QueueCard row could never be cleared, and editing it later hit
// "parkedNotFound: 0" (the drop landed in the parked staging half of the view).
// Assertions:
//   1. drop_queued with a stale ghost index on empty queues is IDEMPOTENT — a
//      fresh queued frame, never an error frame (was: parkedNotFound: 0).
//   2. An idle-host prompt pushes a queued calibration frame BEFORE the turn's
//      first event frame, so the stale row is gone before any turn output.
//   3. The degenerated turn still runs to completion (no regression on the
//      direct-turn path itself).
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/queue-ghost-smoke.ts [host ws url]
import { smokeEnv } from "./smoke-profile.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

interface WireMsg {
  type: string;
  kind?: unknown;
  sessionId?: unknown;
  path?: unknown;
  message?: unknown;
  followUp?: unknown;
  steering?: unknown;
}

function asWireMsg(raw: unknown): WireMsg | null {
  if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string") return raw as WireMsg;
  return null;
}

function texts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((m) => (m && typeof m === "object" && "text" in m ? String(m.text ?? "") : ""));
}

const TXT_DIRECT = "直通校验：只回复「直通」两个字";

let child: ChildProcess | null = null;
const args = process.argv.slice(2);
let wsUrl = args.find((a) => a.startsWith("ws://"));
const createdFiles: string[] = [];

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}
const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
};

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: smokeEnv(),
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
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("120s 内未完成全部断言"), 120_000);

type Step = { name: string; match: (msg: WireMsg, ctx: string) => boolean };

// Attach snapshots race the create_session receipt: ignore queued frames that
// arrive before the ghost-drop is actually sent, so the calibration assertions
// below only see frames caused by our own RPCs.
let ghostDropSent = false;
let directPromptSent = false;

const steps: Step[] = [
  {
    name: "幽灵索引 drop_queued 幂等（不再报 parkedNotFound）",
    match: (msg) => {
      if (!ghostDropSent) return false;
      if (msg.type === "error") fail(`幽灵索引 drop 不应报错，实际: ${String(msg.message)}`);
      if (msg.type !== "queued") return false;
      // The recalibration frame for the stale drop: both queues empty
      assert(texts(msg.followUp).length === 0, `drop 校准帧 followUp 应为空，实际: ${JSON.stringify(msg.followUp)}`);
      assert(texts(msg.steering).length === 0, `drop 校准帧 steering 应为空，实际: ${JSON.stringify(msg.steering)}`);
      console.log("  drop 幽灵索引 → 幂等成功，队列校准帧为空 ✓");
      // Fire the degenerate-idle prompt: host is idle here (fresh session, no
      // run), exactly what a lagging UI streaming flag races into
      directPromptSent = true;
      ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: TXT_DIRECT }));
      return true;
    },
  },
  {
    name: "idle 直通的 prompt 先推 queued 校准帧（幽灵在轮输出前清除）",
    match: (msg) => {
      if (!directPromptSent) return false;
      // Wire order: the handler's synchronous calibration precedes every turn
      // frame on the same socket
      assert(msg.type === "queued", `prompt 后第一帧应为 queued 校准帧，实际: ${msg.type}${msg.kind ? "/" + String(msg.kind) : ""}`);
      assert(texts(msg.followUp).length === 0, `直通校准帧 followUp 应为空，实际: ${JSON.stringify(msg.followUp)}`);
      console.log("  prompt 后第一帧 = queued 空校准 ✓");
      return true;
    },
  },
  {
    name: "直通轮正常开跑（turn_start）",
    match: (msg) => msg.type === "event" && msg.kind === "turn_start",
  },
  {
    name: "直通轮正常收尾（turn_end）",
    match: (msg) => msg.type === "event" && msg.kind === "turn_end",
  },
];

let ctx = "";
let passed = 0;

ws.onmessage = (ev) => {
  const msg = asWireMsg(JSON.parse(String(ev.data)));
  if (!msg) return;
  if (msg.type === "error") fail(`收到 error: ${String(msg.message)}`);
  if (msg.type === "session_created") {
    ctx = String(msg.sessionId ?? "");
    if (typeof msg.path === "string") createdFiles.push(msg.path);
    console.log(`会话建立: ${ctx.slice(0, 8)}`);
    // Let the attach snapshots drain before the ghost drop
    setTimeout(() => {
      ghostDropSent = true;
      ws.send(JSON.stringify({ type: "drop_queued", sessionId: ctx, queue: "followUp", index: 0 }));
    }, 500);
    return;
  }
  if (!ghostDropSent && msg.type === "queued") return; // pre-test attach snapshot
  const step = steps[0];
  if (!step) return;
  if (step.match(msg, ctx)) {
    console.log(`✓ ${step.name}`);
    steps.shift();
    passed++;
    if (steps.length === 0) {
      ws.close();
    }
  }
};

ws.onopen = () => {
  console.log("WS 已连接");
  ws.send(
    JSON.stringify({
      type: "create_session",
      ...(process.env.OMP_DESKTOP_MODEL ? { model: process.env.OMP_DESKTOP_MODEL } : {}),
    }),
  );
};
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = async () => {
  clearTimeout(failTimeout);
  assert(steps.length === 0, `未完成全部步骤，停在: ${steps[0]?.name}`);
  for (const f of createdFiles) await rm(f).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  console.log(`排队幽灵冒烟通过 ✓（${passed} 步，测试会话文件已清理）`);
  process.exit(0);
};
