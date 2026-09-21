// 复现：点击一条排队消息的「立即发送」后，剩余排队消息是否被全部自动发出。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-sendnow.ts [宿主ws地址]
// 观察点：
//   1. 流式中连排 3 条 followUp（MSG-A/B/C），send_now 只点第 0 条（MSG-A）
//   2. 记录每次 steer_consumed 的 texts 与 turn_end 次数，看 MSG-B/MSG-C 是否也被消费
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
  queuedSeen: false, // 3 条都已入队
  nowSent: false, // send_now 已发
  sentTexts: [] as string[], // steer_consumed 收到的全部注入文本（按顺序）
  consumedFrames: [] as number[], // 每次 steer_consumed 帧的注入条数（逐帧单条断言用）
  turnEnds: 0,
  deltas: [] as string[], // 每个 turn 的 delta 文本
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
        state.deltas.push(state.curDelta);
        console.log(`[turn_end #${state.turnEnds}] 回复片段: ${state.curDelta.trim().slice(0, 80)}`);
        state.curDelta = "";
        // A 的注入（send_now）之后的 turn 全部到齐，或观察窗口结束
        if (state.turnEnds >= 2) {
          // 首个 turn 是原任务；其后每个注入消息各一个 turn。等 3s 静默再收尾
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
  // 断言 1：send_now 点的是 MSG-A，第一个注入 turn 的回复只含 AAA，不得拼进 B/C
  const aTurn = state.deltas[0] ?? "";
  assert(aTurn.includes("AAA-DONE") && !aTurn.includes("BBB-DONE") && !aTurn.includes("CCC-DONE"),
    `立即发送的那条独立成轮（首个 turn 回复=${aTurn.trim().slice(0, 60)}），不得把其余排队消息拼进同一轮`);
  // 断言 2：每次注入恰好 1 条（steer_consumed 逐帧单条）
  const multi = state.consumedFrames.filter((n) => n > 1).length;
  assert(multi === 0, `存在一次注入多条的帧（拼车），共 ${multi} 帧`);
  // 断言 3：B、C 逐轮独立消费，各占一个 turn
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
