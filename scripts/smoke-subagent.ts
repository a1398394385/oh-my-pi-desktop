// Subagent passthrough smoke test: induce the main session to call the task tool and assert subagent_lifecycle + subagent_event frames arrive.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-subagent.ts
// Frame semantics (after the BUG-007 fix): one turn_end per model round, and the lifecycle frame may arrive later than the first round frame --
// assertions filter by the runEnd=true final frame (same as smoke-sendnow); in-round frames are waited on, not judged.
import type { SubagentLifecyclePayload } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { smokeEnv } from "./smoke-profile.ts";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

// Base life cycle vocabulary, forwarded verbatim by the host. An unknown value means the base
// renamed a state and this smoke would be asserting on frames the app no longer understands.
type LifecycleStatus = SubagentLifecyclePayload["status"];
const LIFECYCLE_STATUSES: Record<LifecycleStatus, true> = { started: true, completed: true, failed: true, aborted: true };
const isLifecycleStatus = (s: unknown): s is LifecycleStatus =>
  typeof s === "string" && Object.hasOwn(LIFECYCLE_STATUSES, s);

let child: ReturnType<typeof spawn> | null = null;
let createdFile: string | null = null;

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
const state = { sessionId: null as string | null, lifecycle: 0, events: 0, text: "", settled: false, sessionFile: null as string | null };

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created":
      createdFile = msg.path;
      state.sessionId = msg.sessionId;
      ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: msg.sessionId,
          text: "请用 task 工具派一个子代理去计算 123*456，把子代理返回的结果直接告诉我。",
        }),
      );
      break;
    case "subagent_lifecycle":
      if (!isLifecycleStatus(msg.status)) fail(`未知的子代理生命周期状态 ${String(msg.status)}`);
      // The run this smoke induces must succeed: failed/aborted used to slip through as "passed"
      if (msg.status !== "started" && msg.status !== "completed") fail(`子代理终态为 ${msg.status}（冒烟要求 completed）`);
      state.lifecycle++;
      console.log(`lifecycle: ${msg.agent} → ${msg.status}（${msg.description?.slice(0, 40)}）`);
      if (typeof msg.sessionFile === "string") state.sessionFile = msg.sessionFile;
      break;
    case "subagent_progress":
      if (typeof msg.sessionFile === "string") state.sessionFile = msg.sessionFile;
      break;
    case "subagent_event":
      state.events++;
      if (msg.kind === "text_delta") state.text += msg.text;
      break;
    case "event":
      if (msg.kind === "turn_end" && msg.runEnd) {
        console.log(`主会话完成：subagent lifecycle×${state.lifecycle} event×${state.events}`);
        if (state.lifecycle > 0) {
          if (state.events > 0 && state.text.trim()) console.log(`子代理流文本: ${state.text.trim().slice(0, 60)}`);
          ws.close();
        } else {
          fail("未收到任何 subagent_lifecycle 帧（模型可能没调 task 工具，重试一次）");
        }
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
  if (state.lifecycle === 0) fail("无 lifecycle 帧");
  if (state.events === 0) fail("无 subagent_event 帧");
  // Regression guard: live roster rows without a sessionFile made Agent Hub's Enter fall
  // back to the right-panel tab instead of opening the child session (host dropped the
  // field when forwarding; the history-replay path always carried it).
  if (!state.sessionFile) fail("live subagent 帧全程未带 sessionFile（Agent Hub 回车将回退右栏详情页而非打开子会话）");
  console.log(`sessionFile: ${state.sessionFile}`);
  console.log("子代理透传冒烟通过 ✓");
  if (createdFile) await rm(createdFile).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
};
