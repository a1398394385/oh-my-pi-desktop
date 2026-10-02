// Approval flow smoke test: switch to always-ask -> induce a write tool -> assert approval_request arrives ->
// reply Approve -> assert tool execution + turn_end. Cleans up artifacts afterwards.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-approval.ts
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";

let child: ReturnType<typeof spawn> | null = null;
let createdFile: string | null = null;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

child = spawn("bun", ["host/host.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "inherit"],
});
const wsUrl = await new Promise<string>((resolve, reject) => {
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

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("120s 内未完成断言"), 120_000);
const state = {
  sessionId: null as string | null,
  modeAcked: false,
  approvalSeen: false,
  approvalTitle: "",
  answered: false,
  resolvedAck: false,
  turnEnded: false,
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (["ready", "session_created", "approval_mode", "approval_request", "approval_resolved"].includes(msg.type)) {
    console.log(`<< ${msg.type}${msg.kind ? " " + msg.kind : ""}${msg.title ? " | " + msg.title.split("\n")[0] : ""}`);
  }
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "set_approval_mode", mode: "always-ask" }));
      break;
    case "approval_mode":
      if (msg.mode !== "always-ask") fail(`模式切换失败: ${msg.mode}`);
      state.modeAcked = true;
      console.log("审批模式 → always-ask ✓");
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created":
      createdFile = msg.path;
      state.sessionId = msg.sessionId;
      ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: msg.sessionId,
          text: "用 write 工具在当前目录创建 omp-approval-test.txt，内容为 approved。完成后告诉我文件已创建。",
        }),
      );
      break;
    case "approval_request":
      state.approvalSeen = true;
      state.approvalTitle = msg.title;
      console.log(`审批请求: ${msg.title.split("\n")[0]} options=${JSON.stringify(msg.options)}`);
      // Deny once (pick a non-first option/undefined) then wait for a second round? No -- approve directly and exercise the happy path
      ws.send(JSON.stringify({ type: "approval_response", requestId: msg.requestId, answer: msg.options[0] }));
      state.answered = true;
      break;
    case "approval_resolved":
      state.resolvedAck = true;
      break;
    case "event":
      if (msg.sessionId !== state.sessionId) break;
      if (msg.kind === "turn_end") {
        state.turnEnded = true;
        ws.close();
      }
      break;
    case "error":
      fail(`收到 error: ${msg.message}`);
  }
};
ws.onopen = () => console.log("WS 已连接");
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = async () => {
  clearTimeout(failTimeout);
  const assert = (c: boolean, m: string) => {
    if (!c) fail(m);
  };
  assert(state.modeAcked, "未确认模式切换");
  assert(state.approvalSeen, "未收到 approval_request（审批 gate 可能没走 ExtensionUIContext.select）");
  assert(state.answered && state.resolvedAck, "审批应答/回执链路未闭合");
  assert(state.turnEnded, "未完成 turn_end");
  // tool_execution_start is emitted before approval (the gate sits inside execute), so event order cannot be asserted;
  // use the test file landing on disk as hard evidence that write really executed after approval
  const testFile = os.homedir() + "/omp-approval-test.txt";
  const exists = await Bun.file(testFile).exists();
  assert(exists, "批准后 write 未落盘（批准未生效）");
  console.log("批准生效：write 落盘 ✓，turn 完成");
  console.log("审批冒烟通过 ✓");
  await rm(testFile).catch(() => {});
  await rm(os.homedir() + "/omp-approval-test.txt").catch(() => {});
  if (createdFile) await rm(createdFile).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
};
