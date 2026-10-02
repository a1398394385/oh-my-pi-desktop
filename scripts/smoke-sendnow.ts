// Reproduce: after clicking "Send now" on one queued message, do the remaining queued messages all get sent automatically?
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-sendnow.ts [host ws url]
// Observation points:
//   1. Enqueue 3 followUps while streaming (MSG-A/B/C); send_now clicks only item 0 (MSG-A)
//   2. Record each steer_consumed's texts and the turn_end count; check whether MSG-B/MSG-C also get consumed
// Frame semantics (after the BUG-007 fix): one turn_start/turn_end per model round (including continuation rounds from queued consumption),
// plus a final runEnd=true frame when the run is fully over (host mapping of agent_end; not a round; assertions filter by runEnd)
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];
const probeFile = `/tmp/omp-desktop-sendnow-${Date.now()}.txt`;

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
const failTimeout = setTimeout(() => fail("240s 内未完成观察"), 240_000);
const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
};

const state = {
  sessionId: null as string | null,
  streamingSeen: false,
  queuedSeen: false, // All 3 enqueued
  nowSent: false, // send_now sent
  deltasAtFirstConsume: null as number | null, // Number of completed rounds at the first steer_consumed (start index of injected rounds)
  sentTexts: [] as string[], // All injected texts received via steer_consumed (in order)
  consumedFrames: [] as number[], // Injection count per steer_consumed frame (for the one-per-frame assertion)
  turnEnds: 0,
  deltas: [] as string[], // Delta text per turn
  curDelta: "",
  done: false,
};

const MSG_A = "第一排队消息AAA-请只回复AAA-DONE";
const MSG_B = "第二排队消息BBB-请只回复BBB-DONE";
const MSG_C = "第三排队消息CCC-请只回复CCC-DONE";

ws.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created": {
      createdFiles.push(msg.path);
      console.log(`会话建立: ${msg.sessionId.slice(0, 8)}`);
      state.sessionId = msg.sessionId;
      await writeFile(probeFile, "SENDNOW-PROBE\n");
      ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: msg.sessionId,
          text: `用 read 工具读取 ${probeFile}，然后用 bash 执行 sleep 5，最后输出读取到的内容。按步骤调用工具，不要跳步。`,
        }),
      );
      break;
    }
    case "event":
      if (!state.streamingSeen) {
        state.streamingSeen = true;
        console.log("[t0] 流式开始，连排 3 条 followUp");
        for (const t of [MSG_A, MSG_B, MSG_C]) {
          ws.send(JSON.stringify({ type: "prompt", sessionId: state.sessionId, text: t }));
        }
      }
      if (msg.kind === "text_delta") state.curDelta += msg.text;
      else if (msg.kind === "turn_start") {
        console.log(`    [ev] turn_start`);
      } else if (msg.kind === "tool") {
        console.log(`    [ev] tool_start: ${msg.name} ${(msg.args?.cmd || JSON.stringify(msg.args) || "").toString().slice(0, 50)}`);
      } else if (msg.kind === "tool_update") {
        console.log(`    [ev] tool_end:   ${msg.name}`);
      } else if (msg.kind === "turn_end") {
        state.turnEnds++;
        if (msg.runEnd) {
          // Run-final frame (agent_end mapping): carries the whole run's usage/entryId backfill; no deltas; not a round
          console.log(`[turn_end #${state.turnEnds}] runEnd 收尾帧`);
        } else {
          state.deltas.push(state.curDelta);
          console.log(`[turn_end #${state.turnEnds}] 回复片段: ${state.curDelta.trim().slice(0, 80)}`);
        }
        state.curDelta = "";
        // All turns after A's injection (send_now) have arrived, or the observation window ends
        if (state.turnEnds >= 2) {
          // The first turn is the original task; each injected message gets one turn afterwards. Wait 3s of silence before wrapping up
          if (!state.done) {
            state.done = true;
            setTimeout(finish, 4000);
          }
        }
      }
      break;
    case "queued": {
      const f: string[] = (msg.followUp ?? []).map((m: any) => m.text);
      const st: string[] = (msg.steering ?? []).map((m: any) => m.text);
      if (!state.queuedSeen && f.includes(MSG_A) && f.includes(MSG_B) && f.includes(MSG_C)) {
        state.queuedSeen = true;
        console.log("[t1] 3 条已入 followUp:", JSON.stringify({ f }));
        ws.send(JSON.stringify({ type: "send_now", sessionId: state.sessionId, index: 0 }));
        console.log("[t2] 已点第 0 条（MSG-A）的立即发送");
      } else if (state.nowSent || state.queuedSeen) {
        console.log("    队列快照:", JSON.stringify({ f, st }));
      }
      if (state.queuedSeen && st.includes(MSG_A) && !f.includes(MSG_A)) {
        state.nowSent = true;
        console.log("[t3] MSG-A 已转 steer ✓");
      }
      break;
    }
    case "steer_consumed": {
      console.log(`[steer_consumed] 注入: ${JSON.stringify(msg.texts)}`);
      if (state.deltasAtFirstConsume == null) state.deltasAtFirstConsume = state.deltas.length;
      state.sentTexts.push(...(msg.texts ?? []));
      state.consumedFrames.push((msg.texts ?? []).length);
      break;
    }
    case "error":
      fail(`收到 error: ${msg.message}`);
  }
};

function finish() {
  console.log("\n===== 观察结果 =====");
  state.deltas.forEach((d, i) => console.log(`  turn #${i + 1} 回复: ${d.trim().slice(0, 40)}`));
  // Assertion 1: send_now clicked MSG-A; the first turn completed after the first consumption contains only AAA and must not splice in B/C
  // (send_now aborts the original round: its empty trailing round also completes after the click, so deltas[0] cannot be used)
  const aTurn = state.deltas[state.deltasAtFirstConsume ?? 0] ?? "";
  assert(aTurn.includes("AAA-DONE") && !aTurn.includes("BBB-DONE") && !aTurn.includes("CCC-DONE"),
    `立即发送的那条独立成轮（首个 turn 回复=${aTurn.trim().slice(0, 60)}），不得把其余排队消息拼进同一轮`);
  // Assertion 2: each injection is exactly 1 message (steer_consumed one per frame)
  const multi = state.consumedFrames.filter((n) => n > 1).length;
  assert(multi === 0, `存在一次注入多条的帧（拼车），共 ${multi} 帧`);
  // Assertion 3: B and C are consumed independently round by round, each taking one turn
  assert(state.deltas.some((d) => d.includes("BBB-DONE") && !d.includes("CCC-DONE")), "MSG-B 独立一轮");
  assert(state.deltas.some((d) => d.includes("CCC-DONE") && !d.includes("BBB-DONE")), "MSG-C 独立一轮");
  console.log("send_now 冒烟通过 ✓（点一条只发一条，其余逐轮 FIFO）");
  ws.close();
}

ws.onopen = () => console.log("WS 已连接");
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = async () => {
  clearTimeout(failTimeout);
  for (const f of createdFiles) await rm(f).catch(() => {});
  await rm(probeFile).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
};
