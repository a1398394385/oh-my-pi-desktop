// Host-level smoke for the approval-mode write path (18.12.3 added
// "always-ask-cached"). The host validates the incoming mode against the
// base's registry entry (tools.approvalMode.enumValues) instead of a
// hardcoded list, then writes it to the settings override layer and
// broadcasts it to every UI socket. A broken lookup would reject every mode
// (silently breaking all approvals) — this asserts the real RPC path.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-approval-mode.ts
import { smokeEnv } from "./smoke-profile.ts";
import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | null = null;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: smokeEnv(),
  stdio: ["ignore", "pipe", "inherit"],
});
const { promise: wsUrlPromise, resolve: resolveWsUrl, reject: rejectWsUrl } = Promise.withResolvers<string>();
{
  const timer = setTimeout(() => rejectWsUrl(new Error("宿主 30s 未就绪")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolveWsUrl(m[1]);
    }
  });
}
const wsUrl = await wsUrlPromise.catch((e) => fail(String(e)));

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("60s 内未完成断言"), 60_000);
const accepted: string[] = [];
const want = ["always-ask", "always-ask-cached", "write", "yolo"];
let rejected = false;

function finish(snapshotMode: unknown) {
  clearTimeout(failTimeout);
  for (const mode of want) {
    if (!accepted.includes(mode)) fail(`模式 ${mode} 未被接受（已接受: ${accepted.join(",") || "无"}）`);
  }
  if (!rejected) fail("未知模式未被拒绝");
  if (snapshotMode !== "yolo") fail(`settings 快照的审批模式应为最后一次写入的 yolo，实际 ${String(snapshotMode)}`);
  console.log(`✓ 宿主接受底座全部模式: ${accepted.join(", ")}`);
  console.log("✓ 未知模式被拒绝");
  console.log("✓ 审批模式冒烟通过");
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      // Every mode the base knows must be accepted; an unknown one rejected.
      ws.send(JSON.stringify({ type: "set_approval_mode", mode: "always-ask" }));
      ws.send(JSON.stringify({ type: "set_approval_mode", mode: "always-ask-cached" }));
      ws.send(JSON.stringify({ type: "set_approval_mode", mode: "write" }));
      ws.send(JSON.stringify({ type: "set_approval_mode", mode: "yolo" }));
      ws.send(JSON.stringify({ type: "set_approval_mode", mode: "not-a-mode" }));
      break;
    case "approval_mode":
      accepted.push(String(msg.mode));
      break;
    case "error":
      if (String(msg.message).includes("not-a-mode")) rejected = true;
      else fail(`意外错误: ${msg.message}`);
      // The writes are done — pull the snapshot to confirm the value stuck.
      if (rejected && want.every((m) => accepted.includes(m))) ws.send(JSON.stringify({ type: "get_settings" }));
      break;
    case "settings":
      finish(msg.settings?.approvalMode);
      break;
  }
};
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onopen = () => console.log("WS 已连接");
