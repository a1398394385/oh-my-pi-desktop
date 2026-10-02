// Host queueing smoke test: enqueue while streaming -> drop/send_now/requeue RPCs -> both consumption paths (steer and followUp).
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/queue-smoke.ts [host ws url]
// Without an address the script spawns the host child process itself and cleans up the session files it created on exit.
// Assertions cover: queued view order and add/remove, send_now converting to steering, requeue back to the top,
// steer and followUp consumption both emitting steer_consumed, the queue finally drained, and no error or frame flooding.
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

// Extract the user-message text sequence from queue snapshots/consumption frames (non-strings become empty strings, so assertions fail naturally on shape drift)
function texts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    if (m && typeof m === "object" && "text" in m && typeof m.text === "string") return m.text;
    return "";
  });
}
// steer_consumed.texts is a plain string array (unlike the queued snapshot's object array)
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
    cwd: new URL("..", import.meta.url).pathname,
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
  }).catch((e) => fail(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("180s 内未完成全部断言"), 180_000);

// The three queued messages use fixed distinguishable texts; each assertion matches by text
const TXT_A = "排队甲：只回复「甲」两个字";
const TXT_B = "排队乙：只回复「乙」两个字";
const TXT_C = "排队丙：只回复「丙」两个字";

type Step = { name: string; match: (msg: WireMsg, ctx: string) => boolean };

// Step machine: consume frames in order; a match on the current step advances it; irrelevant frames are ignored
const steps: Step[] = [
  {
    name: "首轮 turn_start 后连发三条排队",
    match: (msg, ctx) => {
      if (msg.type !== "event" || msg.kind !== "turn_start") return false;
      for (const t of [TXT_A, TXT_B, TXT_C])
        ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: t }));
      return true;
    },
  },
  {
    name: "三条全部入队（底座+暂存完整视图）",
    match: (msg, ctx) => {
      if (msg.type !== "queued" || !sameTexts(texts(msg.followUp), [TXT_A, TXT_B, TXT_C])) return false;
      console.log("  排队视图=[甲乙丙]");
      ws.send(JSON.stringify({ type: "drop_queued", sessionId: ctx, queue: "followUp", index: 2 }));
      return true;
    },
  },
  {
    name: "drop 丙后剩 [甲乙]",
    match: (msg, ctx) => {
      if (msg.type !== "queued" || !sameTexts(texts(msg.followUp), [TXT_A, TXT_B])) return false;
      console.log("  drop 丙 → 排队=[甲乙]");
      ws.send(JSON.stringify({ type: "send_now", sessionId: ctx, index: 0 }));
      return true;
    },
  },
  {
    name: "send_now 甲 → steering",
    match: (msg, ctx) => {
      if (msg.type !== "queued" || !sameTexts(texts(msg.steering), [TXT_A]) || !sameTexts(texts(msg.followUp), [TXT_B]))
        return false;
      console.log("  send_now 甲 → steering=[甲] 排队=[乙]");
      ws.send(JSON.stringify({ type: "requeue", sessionId: ctx, index: 0 }));
      return true;
    },
  },
  {
    name: "requeue 甲回排队顶端",
    match: (msg, ctx) => {
      if (msg.type !== "queued" || !sameTexts(texts(msg.steering), []) || !sameTexts(texts(msg.followUp), [TXT_A, TXT_B]))
        return false;
      console.log("  requeue 甲 → 排队=[甲乙]（甲在顶端）");
      ws.send(JSON.stringify({ type: "send_now", sessionId: ctx, index: 0 }));
      return true;
    },
  },
  {
    name: "再次 send_now 甲 → steering",
    match: (msg, _ctx) => {
      if (msg.type !== "queued" || !sameTexts(texts(msg.steering), [TXT_A])) return false;
      console.log("  再次 send_now 甲 → steering=[甲]");
      return true;
    },
  },
  {
    name: "steer 消费甲",
    match: (msg, _ctx) => {
      if (msg.type !== "steer_consumed") return false;
      assert(consumedTexts(msg.texts).includes(TXT_A), `首次消费应含甲: ${JSON.stringify(msg.texts)}`);
      console.log("  steer_consumed 甲 ✓");
      return true;
    },
  },
  {
    name: "followUp 自动消费乙",
    match: (msg, _ctx) => {
      if (msg.type !== "steer_consumed") return false;
      assert(consumedTexts(msg.texts).includes(TXT_B), `二次消费应含乙: ${JSON.stringify(msg.texts)}`);
      console.log("  steer_consumed 乙 ✓（loop 完自动消费）");
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

const frameCounts: Record<string, number> = {};
let ctx = "";
let passed = 0;

ws.onmessage = (ev) => {
  const msg = asWireMsg(JSON.parse(String(ev.data)));
  if (!msg) return;
  frameCounts[msg.type] = (frameCounts[msg.type] ?? 0) + 1;
  if (msg.type === "error") fail(`收到 error: ${String(msg.message)}`);
  if (msg.type === "session_created") {
    ctx = String(msg.sessionId ?? "");
    if (typeof msg.path === "string") createdFiles.push(msg.path);
    console.log(`会话建立: ${ctx.slice(0, 8)}`);
    ws.send(
      JSON.stringify({
        type: "prompt",
        sessionId: ctx,
        text: "从 1 数到 30，每个数字单独一行，不要输出其他内容。",
      }),
    );
  }
  const step = steps[0];
  if (!step) return;
  if (step.match(msg, ctx)) {
    console.log(`✓ ${step.name}`);
    steps.shift();
    passed++;
    if (steps.length === 0) {
      // Final assertions: no frame flooding (resend loops/duplicate pushes would blow up these two frame types)
      assert((frameCounts.event ?? 0) < 3000, `event 帧异常多: ${frameCounts.event}（疑似循环）`);
      assert((frameCounts.queued ?? 0) < 60, `queued 帧异常多: ${frameCounts.queued}（疑似循环）`);
      console.log(`帧统计: ${JSON.stringify(frameCounts)}`);
      ws.close();
    }
  }
};

ws.onopen = () => {
  console.log("WS 已连接");
  // Create a session (cheap model optional; defaults to the profile config)
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
  console.log(`排队链路冒烟通过 ✓（${passed} 步，测试会话文件已清理）`);
  process.exit(0);
};
