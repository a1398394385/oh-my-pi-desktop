// Slash-command queue smoke: a command consumed locally by the host must never
// survive in the client's optimistic queue.
// A mid-stream send is optimistically enqueued by the UI (it cannot tell a
// consumed command from a queued prompt), but a consumed command never touches
// the agent queue and fires no onQueueChange — without a calibration frame the
// queue card kept the command row forever (reported with /advisor on).
// Assertions:
//   1. A plain mid-stream prompt lands in the queued view (baseline row).
//   2. The consumed command's own text never appears in any queued frame.
//   3. Sending the command mid-stream pushes a queued calibration frame whose
//      followUp is exactly the baseline row (command row dropped).
// Usage: OMP_DESKTOP_MODEL=<working provider/model> bun scripts/slash-queue-smoke.ts [host ws url]
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

const TXT_QUEUED = "排队基线：只回复「基线」两个字";
const TXT_COMMAND = "/advisor on";

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

let queuedSent = false;
let slashSent = false;

const steps: Step[] = [
  {
    name: "基线排队消息进入队列视图",
    match: (msg) => {
      if (!queuedSent || msg.type !== "queued") return false;
      if (texts(msg.followUp).length === 0) return false; // run-start calibration, not ours
      assert(texts(msg.followUp).join("|") === TXT_QUEUED, `基线排队视图应恰为[${TXT_QUEUED}]，实际: ${JSON.stringify(msg.followUp)}`);
      console.log("  基线排队视图=[基线] ✓");
      // The prompt handler's own post-enqueue calibration can land a second
      // frame with the same content; wait for the wire to go quiet so the only
      // queued frame left to observe belongs to the command below.
      setTimeout(() => {
        if (turnEnded) fail("turn 在发送命令前就结束了，冒烟不成立（会话已 idle，退化路径会自己校准）");
        slashSent = true;
        ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: TXT_COMMAND }));
      }, 1200);
      return true;
    },
  },
  {
    name: "被消费的命令回推队列校准帧（不含命令本身）",
    match: (msg) => {
      if (!slashSent || msg.type !== "queued") return false;
      assert(
        texts(msg.followUp).join("|") === TXT_QUEUED,
        `命令后校准帧 followUp 应只剩基线排队行，实际: ${JSON.stringify(msg.followUp)}`,
      );
      assert(texts(msg.steering).length === 0, `校准帧 steering 应为空，实际: ${JSON.stringify(msg.steering)}`);
      console.log("  命令后校准帧=[基线]（命令行已清除）✓");
      return true;
    },
  },
];

let ctx = "";
let passed = 0;
let turnEnded = false;

ws.onmessage = (ev) => {
  const msg = asWireMsg(JSON.parse(String(ev.data)));
  if (!msg) return;
  if (msg.type === "error") fail(`收到 error: ${String(msg.message)}`);
  if (msg.type === "session_created") {
    ctx = String(msg.sessionId ?? "");
    if (typeof msg.path === "string") createdFiles.push(msg.path);
    console.log(`会话建立: ${ctx.slice(0, 8)}`);
    ws.send(
      JSON.stringify({
        type: "prompt",
        sessionId: ctx,
        text: "运行 bash 命令 sleep 25，然后只回复 ok。",
      }),
    );
    return;
  }
  // The bug window is the live turn: an idle host recalibrates anyway
  // (degenerate-idle path), so a turn_end before our calibration would make
  // this smoke pass without the fix.
  if (msg.type === "event" && msg.kind === "turn_end") {
    turnEnded = true;
    if (slashSent && steps.length === 1) {
      fail("命令后的队列校准帧直到 turn 结束都没来（命令行会滞留在队列卡片里，本冒烟必须先红）");
    }
  }
  // Invariant: a locally consumed command must never show up in the queue view
  if (msg.type === "queued") {
    const all = [...texts(msg.followUp), ...texts(msg.steering)];
    assert(!all.some((t) => t.startsWith("/")), `命令不应出现在队列视图，实际: ${JSON.stringify(all)}`);
  }
  const step = steps[0];
  if (!step) return;
  if (msg.type === "event" && msg.kind === "turn_start" && !queuedSent) {
    // Send while the (long) turn is still streaming; the short delay only lets
    // the run-start calibration frame go first, so the two are distinguishable
    setTimeout(() => {
      queuedSent = true;
      ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: TXT_QUEUED }));
    }, 300);
  }
  if (step.match(msg, ctx)) {
    console.log(`✓ ${step.name}`);
    steps.shift();
    passed++;
    if (steps.length === 0) ws.close();
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
  console.log(`斜杠命令队列冒烟通过 ✓（${passed} 步，测试会话文件已清理）`);
  process.exit(0);
};
