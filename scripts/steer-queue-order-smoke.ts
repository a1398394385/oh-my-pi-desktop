// Steer/queue consumption-order smoke: a steer message sent mid-run plus a plain
// queued message must be announced by steer_consumed one at a time, in consumption
// order (steer first, followUp at turn end) — never as one merged frame with the
// still-queued text first. Regression for the live-view bug where a queued message
// was promoted to a consumed bubble ahead of the steer bubble it was sent after.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/steer-queue-order-smoke.ts [host ws url]
// Without an address the script spawns the host child process itself and cleans up
// the session files it created on exit.
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

interface WireMsg {
  type: string;
  kind?: unknown;
  sessionId?: unknown;
  path?: unknown;
  message?: unknown;
  texts?: unknown;
  followUp?: unknown;
  steering?: unknown;
}

function asWireMsg(raw: unknown): WireMsg | null {
  // Frame-boundary loose interface conversion: all fields unknown; narrowing happens at read sites
  if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string")
    return raw as WireMsg;
  return null;
}

function texts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    if (m && typeof m === "object" && "text" in m && typeof m.text === "string") return m.text;
    return "";
  });
}

function consumedTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
}
const sameTexts = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

const args = process.argv.slice(2);
let child: ChildProcess | null = null;
let wsUrl = args[0];
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
    env: { ...process.env },
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
    child!.once("exit", (code) => reject(new Error(`host exited early: ${code}`)));
    setTimeout(() => reject(new Error("host start timeout")), 30_000);
  }).catch((e) => fail(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("180s 内未完成全部断言"), 180_000);

// Distinguishable texts: S1 goes in as a steer (Ctrl+Enter path), Q1 as a plain
// queued message while the first turn is still running
const TXT_S1 = "引导一：收到后只回复「一」";
const TXT_Q1 = "排队一：收到后只回复「二」";

type Step = { name: string; match: (msg: WireMsg, ctx: string) => boolean };

const steps: Step[] = [
  {
    name: "首轮工具执行开始后发 steer + queue",
    match: (msg, ctx) => {
      // Send the queued message first so it is guaranteed to be in the base
      // followUp queue before the steer dequeue hook can fire; then the steer.
      if (msg.type !== "event" || msg.kind !== "tool") return false;
      ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: TXT_Q1 }));
      ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: TXT_S1, steer: true }));
      return true;
    },
  },
  {
    name: "queued 视图同时含 steer 与 queue",
    match: (msg, _ctx) => {
      if (msg.type !== "queued") return false;
      return sameTexts(texts(msg.steering), [TXT_S1]) && sameTexts(texts(msg.followUp), [TXT_Q1]);
    },
  },
  {
    name: "steer 消费帧恰为 [S1]",
    match: (msg, _ctx) => {
      if (msg.type !== "steer_consumed") return false;
      // The frame announces only what is about to be dequeued. Announcing the
      // still-queued Q1 as well would promote it to a consumed bubble immediately,
      // ahead of S1 — the reported live-view bug.
      assert(
        sameTexts(consumedTexts(msg.texts), [TXT_S1]),
        `steer 消费帧必须恰为[${TXT_S1}],实际: ${JSON.stringify(msg.texts)}`,
      );
      console.log("  steer_consumed 恰为 [S1] ✓");
      return true;
    },
  },
  {
    name: "followUp 消费帧恰为 [Q1]",
    match: (msg, _ctx) => {
      if (msg.type !== "steer_consumed") return false;
      assert(
        sameTexts(consumedTexts(msg.texts), [TXT_Q1]),
        `followUp 消费帧必须恰为[${TXT_Q1}],实际: ${JSON.stringify(msg.texts)}`,
      );
      console.log("  steer_consumed 恰为 [Q1] ✓");
      return true;
    },
  },
  {
    name: "队列排空",
    match: (msg, _ctx) => {
      if (msg.type !== "queued") return false;
      return texts(msg.followUp).length === 0 && texts(msg.steering).length === 0;
    },
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
    ws.send(
      JSON.stringify({
        type: "prompt",
        sessionId: ctx,
        // Tool-call turn with a slow command: the queue state must survive long
        // enough for the queued frame to be observed before the tool batch
        // completes and the loop poll dequeues the steer message
        text: "用 bash 工具执行 sleep 15，等它自然结束，然后只回复 DONE 四个字母。",
      }),
    );
  }
  const step = steps[0];
  if (!step) return;
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
  console.log(`steer/queue 消费顺序冒烟通过 ✓（${passed} 步，测试会话文件已清理）`);
  process.exit(0);
};
