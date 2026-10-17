// Steer-at-output-tail smoke: a steer sent during the FINAL stage of a plain
// text output (no tools left, so no further tool-batch injection boundary)
// must still be announced via steer_consumed and consumed — either at the yield
// boundary inside the same run or by the post-settle stranded-queue drain —
// and the steering queue must end up empty. Regression for the bug where the
// bubble vanished after the run ended.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/steer-tail-smoke.ts [host ws url] [early|late|after]
//   early — steer at delta#2 (mid first paragraph)
//   late  — steer once 600+ chars streamed (near the tail)
//   after — steer on the runEnd frame tick: host-side the session is already
//           idle, exactly what a real UI steer races into when the UI's
//           streaming flag lags the run state by one ws frame. Expected: the
//           prompt degenerates into a plain new run with NO steer_consumed —
//           the reported vanishing-bubble root cause.
import { smokeEnv } from "./smoke-profile.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

interface WireMsg {
  type: string;
  sessionId?: string;
  kind?: string;
  runEnd?: boolean;
  text?: string;
  texts?: unknown;
  steering?: unknown;
  followUp?: unknown;
  message?: string;
  path?: string;
}

function asWireMsg(raw: unknown): WireMsg | null {
  return raw && typeof raw === "object" ? (raw as WireMsg) : null;
}

function consumedTexts(raw: unknown): string[] {
  // steer_consumed.texts is a plain string array (unlike the queued snapshot's object array)
  return Array.isArray(raw) ? raw.map((t) => String(t)) : [];
}

function queuedTexts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const m of list) {
    if (m && typeof m === "object" && "text" in m) out.push(String(m.text ?? ""));
  }
  return out;
}

const mode = (["early", "late", "after"].find((m) => process.argv.includes(m)) ?? "early") as "early" | "late" | "after";
const TXT_STEER = "补充指令：请在你当前回答的末尾另起一行，只输出 PONG 两个字符。";

let child: ChildProcess | null = null;
let wsUrl = process.argv.find((a) => a.startsWith("ws://"));

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: smokeEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  });
  wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
    child!.stdout!.setEncoding("utf8");
    child!.stdout!.on("data", function onLine(chunk: string) {
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
const failTimeout = setTimeout(() => fail("240s 内未完成全部断言"), 240_000);
const createdFiles: string[] = [];

let ctx = "";
let deltaCount = 0;
let draftChars = 0;
let steerSent = false;
let steerConsumed = false;
let sawRunEnd = false;
let sawNewTurnAfterRunEnd = false;
let consumedBeforeRunEnd = false;
let verdictTimer: ReturnType<typeof setTimeout> | null = null;
let queueSnapshot: { steering: string[]; followUp: string[] } | null = null;
const log: string[] = [];

function sendSteer(note: string): void {
  steerSent = true;
  log.push(note);
  console.log(note);
  ws.send(JSON.stringify({ type: "prompt", sessionId: ctx, text: TXT_STEER, steer: true }));
}

function verdict(): void {
  console.log("--- 帧序 ---");
  for (const l of log) console.log(l);
  if (!steerSent) fail("steer 从未发出");
  if (mode === "after") {
    // The steer degenerated into a plain prompt (new run, no steer_consumed):
    // the UI's pending bubble is sealed into the collapsed loop group by the
    // runEnd frame and never promoted — the reported vanishing message.
    if (steerConsumed) fail("after 变体不应出现 steer_consumed（时序未命中 idle 窗口）");
    if (!sawNewTurnAfterRunEnd) fail("after 变体：steer 未触发新 run（prompt 丢失？）");
    console.log(`steer 尾段冒烟通过 ✓（mode=after：无 steer_consumed，退化为直接开 turn —— 复现消失根因）`);
    ws.close();
    return;
  }
  if (!steerConsumed) fail("run 结束后 steer 从未被消费（steer_consumed 未出现）—— 气泡会卡在收起的 loop 组里消失");
  if (queueSnapshot && queueSnapshot.steering.length > 0) fail(`steering 队列未排空: ${JSON.stringify(queueSnapshot.steering)}`);
  console.log(
    `steer 尾段冒烟通过 ✓（mode=${mode} consumedBeforeRunEnd=${consumedBeforeRunEnd} drainTurn=${sawNewTurnAfterRunEnd}）`,
  );
  ws.close();
}

function scheduleVerdict(): void {
  verdictTimer = setTimeout(
    verdict,
    steerConsumed ? 2000 : 20000, // stranded path: give the settle drain time to fire
  );
}

ws.onmessage = (ev) => {
  const msg = asWireMsg(JSON.parse(String(ev.data)));
  if (!msg) return;
  if (msg.type === "error") fail(`收到 error: ${String(msg.message)}`);
  if (msg.type === "session_created") {
    ctx = String(msg.sessionId ?? "");
    if (typeof msg.path === "string") createdFiles.push(msg.path);
    console.log(`会话建立: ${ctx.slice(0, 8)} (mode=${mode})`);
    ws.send(
      JSON.stringify({
        type: "prompt",
        sessionId: ctx,
        // Long plain-text answer, explicitly no tools: the steer lands while the
        // model is mid-paragraph, with no remaining tool-batch boundary ahead
        text: "请写一篇约八百字的关于灯塔的短文，分四段，不要调用任何工具，直接输出正文。",
      }),
    );
    return;
  }
  if (msg.sessionId !== ctx) return;

  if (msg.type === "event") {
    if (msg.kind === "text_delta") {
      deltaCount++;
      draftChars += typeof msg.text === "string" ? msg.text.length : 0;
      if (!steerSent && mode !== "after" && (mode === "early" ? deltaCount === 2 : draftChars >= 600)) {
        sendSteer(`>> 注入 steer（delta#${deltaCount}, draft=${draftChars}字）`);
      }
    } else if (msg.kind === "turn_end") {
      if (msg.runEnd) {
        sawRunEnd = true;
        log.push(`<< turn_end runEnd=true（此时 steerConsumed=${steerConsumed}）`);
        console.log(log[log.length - 1]);
        if (mode === "after" && !steerSent) sendSteer(">> 注入 steer（runEnd 帧 tick，host 侧已 idle）");
        scheduleVerdict();
      } else {
        log.push("<< turn_end runEnd=false（run 内续轮）");
        console.log(log[log.length - 1]);
      }
    } else if (msg.kind === "turn_start") {
      const tag = sawRunEnd ? ", runEnd后" : "";
      log.push(`<< turn_start（delta=${deltaCount}, sent=${steerSent}, consumed=${steerConsumed}${tag}）`);
      console.log(log[log.length - 1]);
      if (sawRunEnd) sawNewTurnAfterRunEnd = true;
    }
  } else if (msg.type === "steer_consumed") {
    const t = consumedTexts(msg.texts);
    log.push(`<< steer_consumed ${JSON.stringify(t)}（runEnd已到=${sawRunEnd}）`);
    console.log(log[log.length - 1]);
    if (t.includes(TXT_STEER)) {
      steerConsumed = true;
      if (!sawRunEnd) consumedBeforeRunEnd = true;
      else if (verdictTimer) {
        // drain arrived inside the observation window: settle the verdict shortly
        clearTimeout(verdictTimer);
        verdictTimer = setTimeout(verdict, 3000);
      }
    }
  } else if (msg.type === "queued") {
    queueSnapshot = { steering: queuedTexts(msg.steering), followUp: queuedTexts(msg.followUp) };
    log.push(`<< queued steering=${JSON.stringify(queueSnapshot.steering)} followUp=${JSON.stringify(queueSnapshot.followUp)}`);
    console.log(log[log.length - 1]);
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
  clearTimeout(verdictTimer!);
  for (const f of createdFiles) await rm(f).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
};
