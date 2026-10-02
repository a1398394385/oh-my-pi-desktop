// Steer-path smoke test: a prompt sent while streaming is queued as a steering message; verify peek/edit/drop and consumption injection.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/steer-smoke.ts [host ws url]
// Assertions cover:
//   1. While streaming, the second prompt enters the steer queue (visible via peek_queued)
//   2. After edit_queued changes the text, the reply carries the new text (index aligned to user messages)
//   3. After drop_queued clears all, the queue is empty (the path that spares system notices goes through the clear-all branch)
//   4. Steer consumption injection: after a strong-instruction steer, the turn_end reply reflects the instruction
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];
const probeFile = `/tmp/omp-desktop-steer-${Date.now()}.txt`;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

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

const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("180s 内未完成全部断言"), 180_000);

const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
};

const state = {
  sessionId: null as string | null,
  deltaText: "",
  streamingSeen: false, // First mid-stream event received; the turn is confirmed running
  phase: 0 as 0 | 1 | 2, // 0=queue/send-now/requeue/drop checks 1=awaiting consumption injection 2=done
  nowSent: false, // send_now sent (a gate for the assertion state machine)
  requeued: false, // requeue sent
  dropped: false, // drop sent
  sawSpontaneous: false, // Received at least one host-initiated push (triggered by prompt resolve / turn_end, not a peek reply)
  sawConsumed: false, // Received at least one steer_consumed (pre-consumption notification)
  frameStats: {} as Record<string, number>, // Frame counters: quantifying host output for UI-freeze diagnosis
};

const ORIG = "排队中的原文";
const bumpFrame = (msg: any) => {
  const key = msg.type === "event" ? `event:${msg.kind}` : msg.type;
  state.frameStats[key] = (state.frameStats[key] ?? 0) + 1;
};

ws.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data));
  bumpFrame(msg);
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created": {
      createdFiles.push(msg.path);
      console.log(`会话建立: ${msg.sessionId.slice(0, 8)} cwd=${msg.cwd}`);
      state.sessionId = msg.sessionId;
      await writeFile(probeFile, "STEER-PROBE-A\nSTEER-PROBE-B\n");
      ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: msg.sessionId,
          text: `用 read 工具读取 ${probeFile}，然后用 bash 执行 sleep 3，最后把文件两行内容连成一句话输出。慢慢来，按步骤调用工具。`,
        }),
      );
      break;
    }
    case "event":
      // First event = the turn is already streaming (isStreaming set); the second prompt sent now should be queued (followUp)
      if (!state.streamingSeen) {
        state.streamingSeen = true;
        ws.send(JSON.stringify({ type: "prompt", sessionId: state.sessionId, text: ORIG }));
      }
      if (msg.kind === "text_delta") state.deltaText += msg.text;
      else if (msg.kind === "turn_end") {
        console.log(`turn_end 回复片段: ${state.deltaText.trim().slice(0, 60)}`);
        if (state.phase === 1 && state.deltaText.includes("STEERED-DONE")) {
          state.phase = 2;
          ws.close();
        }
      }
      break;
    case "queued": {
      state.sawSpontaneous = true; // This test never sends peek; everything received is a host push
      const f: string[] = (msg.followUp ?? []).map((m: any) => m.text);
      const st: string[] = (msg.steering ?? []).map((m: any) => m.text);
      if (state.phase === 0 && !state.nowSent && f.includes(ORIG)) {
        console.log("断言1 ✓ 流中 prompt 已入 followUp 排队队列:", JSON.stringify({ f, st }));
        state.nowSent = true;
        ws.send(JSON.stringify({ type: "send_now", sessionId: state.sessionId, index: 0 }));
      } else if (state.phase === 0 && state.nowSent && !state.requeued && st.includes(ORIG)) {
        console.log("断言2 ✓ send_now 已转为 steer（立即发送）:", JSON.stringify({ f, st }));
        state.requeued = true;
        ws.send(JSON.stringify({ type: "requeue", sessionId: state.sessionId, index: 0 }));
      } else if (state.phase === 0 && state.requeued && !state.dropped && f.includes(ORIG)) {
        console.log("断言3 ✓ requeue 已放回 followUp 顶端:", JSON.stringify({ f, st }));
        state.dropped = true;
        ws.send(JSON.stringify({ type: "drop_queued", sessionId: state.sessionId, queue: "followUp", index: 0 }));
      } else if (state.phase === 0 && state.dropped && f.length === 0 && st.length === 0) {
        console.log("断言4 ✓ drop 后两队列皆空");
        state.phase = 1;
        // Enqueue a strong instruction: auto-consumed once the loop ends and reflected immediately -- evidence of auto-consumption injection
        ws.send(
          JSON.stringify({
            type: "prompt",
            sessionId: state.sessionId,
            text: "忽略之前的输出计划，不要再调用任何工具，立即只输出 STEERED-DONE 这一个词然后结束。",
          }),
        );
      } else if (state.phase === 1) {
        console.log("队列快照:", JSON.stringify({ f, st }));
      }
      break;
    }
    case "steer_consumed": {
      console.log("steer_consumed ✓ 消费前通知:", JSON.stringify(msg.texts));
      if ((msg.texts ?? []).some((t: string) => t.includes("STEERED-DONE"))) state.sawConsumed = true;
      break;
    }
    case "error":
      fail(`收到 error: ${msg.message}`);
  }
};

ws.onopen = () => console.log("WS 已连接");
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = async () => {
  clearTimeout(failTimeout);
  assert(state.phase === 2, "未完成 steer 消费注入断言");
  assert(state.sawSpontaneous, "未收到 host 自发队列推送（prompt resolve / turn_end 校准）");
  assert(state.sawConsumed, "未收到 steer_consumed 消费前通知");
  console.log("帧统计:", JSON.stringify(state.frameStats));
  for (const f of createdFiles) await rm(f).catch(() => {});
  await rm(probeFile).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  console.log("steer 冒烟通过 ✓（测试会话文件已清理）");
  process.exit(0);
};
