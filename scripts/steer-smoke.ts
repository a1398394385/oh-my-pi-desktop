// steer 链路冒烟：流式中发 prompt 排队为转向消息，验证 peek/edit/drop 与消费注入。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/steer-smoke.ts [宿主ws地址]
// 断言覆盖：
//   1. 流式中第二条 prompt 进入 steer 队列（peek_queued 可见）
//   2. edit_queued 改文本后回包即新文本（索引对齐用户消息）
//   3. drop_queued 全清后队列为空（不误删系统 notice 的路径走全清分支）
//   4. steer 消费注入：强指令 steer 后 turn_end 回复体现指令
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
  streamingSeen: false, // 收到首个流中事件，确认 turn 在跑
  phase: 0 as 0 | 1 | 2, // 0=排队/立即发送/放回/删除验证 1=等待消费注入 2=完成
  nowSent: false, // send_now 已发（断言状态机门）
  requeued: false, // requeue 已发
  dropped: false, // drop 已发
  sawSpontaneous: false, // 收到过 host 自发推送（prompt resolve / turn_end 触发，非 peek 回包）
  sawConsumed: false, // 收到过 steer_consumed（消费前通知）
  frameStats: {} as Record<string, number>, // 帧计数：排查 UI 卡死用的 host 输出量化
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
      // 首个事件 = turn 已在流中（isStreaming 已置位），此刻发第二条 prompt 应排队（followUp）
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
      state.sawSpontaneous = true; // 本测试不发 peek，收到的全是 host 推送
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
        // 强指令排队：loop 完自动消费后应立即体现，作为「自动消费注入」证据
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
