// 宿主冒烟：真模型驱动完整链路（create_session → prompt → 流式回复 → turn_end → get_messages）。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke.ts [宿主ws地址]
// 不传地址时本脚本自行拉起宿主子进程，退出时一并清理。
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];

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
  const firstLine = await new Promise<string>((resolve, reject) => {
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
  }).catch((e) => fail(String(e)));
  wsUrl = firstLine;
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("60s 内未完成全部断言"), 60_000);

let gotReady = false;
let sessionId: string | null = null;
let deltaCount = 0;
let deltaText = "";
let gotTurnEnd = false;
let transcriptChecked = false;

const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      gotReady = true;
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created":
      sessionId = msg.sessionId;
      console.log(`会话建立: ${sessionId!.slice(0, 8)} 模型: ${msg.model}`);
      ws.send(JSON.stringify({ type: "prompt", sessionId, text: "1+1 等于几？只回答阿拉伯数字。" }));
      break;
    case "event":
      if (msg.kind === "text_delta") {
        deltaCount++;
        deltaText += msg.text;
      } else if (msg.kind === "turn_end") {
        gotTurnEnd = true;
        console.log(`收到 ${deltaCount} 个 delta，回复: ${deltaText.trim()}`);
        assert(deltaCount > 0, "没有任何 text_delta");
        ws.send(JSON.stringify({ type: "get_messages", sessionId }));
      }
      break;
    case "messages":
      transcriptChecked = true;
      console.log("transcript 快照:", JSON.stringify(msg.messages));
      assert(
        msg.messages.length >= 2 && msg.messages[0].role === "user" && msg.messages.at(-1).role === "assistant",
        "transcript 应以 user 开头 assistant 结尾",
      );
      ws.close();
      break;
    case "error":
      fail(`收到 error: ${msg.message}`);
  }
};

ws.onopen = () => console.log("WS 已连接");
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = () => {
  clearTimeout(failTimeout);
  assert(gotReady, "未收到 ready");
  assert(sessionId !== null, "未建立会话");
  assert(gotTurnEnd, "未收到 turn_end");
  assert(transcriptChecked, "未校验 transcript");
  if (child?.pid) child.kill("SIGTERM");
  console.log("冒烟通过 ✓");
  process.exit(0);
};
