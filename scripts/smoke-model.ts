// Model/thinking-level switch smoke test: create -> set_model(deepseek) -> set_thinking(low) -> one chat round to confirm it works.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-model.ts
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

let child: ReturnType<typeof spawn> | null = null;
let createdFile: string | null = null;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
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
  modelSet: false,
  thinkingSet: false,
  delta: "",
  turnEnded: false,
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      if (!msg.models?.some((m: any) => m.id === "deepseek/deepseek-flash")) fail("ready 未带模型列表或缺 deepseek-flash");
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created":
      createdFile = msg.path;
      state.sessionId = msg.sessionId;
      console.log(`会话: model=${msg.model} thinking=${msg.thinking}`);
      ws.send(JSON.stringify({ type: "set_model", sessionId: msg.sessionId, model: "deepseek/deepseek-flash" }));
      break;
    case "session_model":
      if (msg.model !== "deepseek/deepseek-flash") fail(`模型切换失败: ${msg.model}`);
      state.modelSet = true;
      ws.send(JSON.stringify({ type: "set_thinking", sessionId: state.sessionId, level: "low" }));
      break;
    case "session_thinking":
      console.log(`切换回执: model ✓ thinking=${msg.level}`);
      if (msg.level !== "low") fail(`思考级别应为 low（钳制后）, got ${msg.level}`);
      state.thinkingSet = true;
      ws.send(JSON.stringify({ type: "prompt", sessionId: state.sessionId, text: "只回一个字：好" }));
      break;
    case "event":
      if (msg.kind === "text_delta") state.delta += msg.text;
      if (msg.kind === "turn_end") {
        state.turnEnded = true;
        console.log(`切换后对话回复: ${state.delta.trim().slice(0, 20)}`);
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
  assert(state.modelSet, "模型切换未确认");
  assert(state.thinkingSet, "思考级别切换未确认");
  assert(state.turnEnded && state.delta.trim().length > 0, "切换后对话无回复");
  console.log("模型/思考切换冒烟通过 ✓");
  if (createdFile) await rm(createdFile).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
};
