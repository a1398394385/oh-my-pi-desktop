// Plan mode smoke test: enter/exit frames, mode_change persisted, restored on session reopen, and no double-entry on restore.
// Usage: bun scripts/smoke-plan.ts [host ws url]
// Without an address the script spawns the host child process itself and deletes the session files it created on exit. Zero model calls.
// Assertions cover:
//   1. Creating a session immediately pushes a plan_mode=false frame (the UI's initial state)
//   2. set_plan_mode true -> frame enabled=true + planFilePath=local://PLAN.md
//   3. The persisted session contains mode_change(plan, {planFilePath})
//   4. set_plan_mode false -> frame enabled=false + mode_change(none)
//   5. After enabling again, load_session restores enabled=true from the persisted mode_change (reconcile)
//   6. Restoring does not append mode_change (persist=false; the count is unchanged)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const args = process.argv.slice(2);
let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  for (const f of createdFiles) rm(f).catch(() => {});
  process.exit(1);
}

function launchHost(): Promise<string> {
  child = spawn("bun", ["host/host.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
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
  return promise.catch((e) => fail(String(e)));
}
if (!wsUrl) wsUrl = await launchHost();

interface WireFrame {
  type: string;
  sessionId?: string;
  path?: string;
  enabled?: boolean;
  planFilePath?: string | null;
  text?: string;
  consumed?: boolean;
}

const seen: WireFrame[] = [];
const waiters: Array<{ pred: (f: WireFrame) => boolean; resolve: (f: WireFrame) => void; timer: NodeJS.Timeout }> = [];
function waitFor(pred: (f: WireFrame) => boolean, label: string, ms = 20_000): Promise<WireFrame> {
  const hit = seen.find(pred);
  if (hit) return Promise.resolve(hit);
  const { promise, resolve, reject } = Promise.withResolvers<WireFrame>();
  const timer = setTimeout(() => reject(new Error(`等待超时: ${label}`)), ms);
  waiters.push({
    pred,
    resolve: (f) => {
      clearTimeout(timer);
      resolve(f);
    },
    timer,
  });
  return promise;
}

let ws: WebSocket;
function attachWs(url: string) {
  ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    const f = JSON.parse(String(ev.data)) as WireFrame;
    seen.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  };
}
attachWs(wsUrl);
const send = (msg: unknown) => ws.send(JSON.stringify(msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function modeChanges(path: string): Array<{ mode?: string; data?: { planFilePath?: string } }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; mode?: string; data?: { planFilePath?: string } })
    .filter((e) => e.type === "mode_change");
}

await waitFor((f) => f.type === "ready", "ready");
send({ type: "create_session" });
const created = await waitFor((f) => f.type === "session_created", "session_created");
const sessionId = created.sessionId!;
const sessionPath = created.path!;
createdFiles.push(sessionPath);

// 1) Creating a session immediately pushes plan_mode=false
const initial = await waitFor((f) => f.type === "plan_mode" && f.sessionId === sessionId, "新建会话的 plan_mode 帧");
if (initial.enabled !== false) fail("新建会话的 plan_mode 帧应为 enabled=false");
console.log("✓ 新建会话推送 plan_mode=false");

// 2) Force the lazily-created session to disk first (ensureOnDisk inside bash_exec); otherwise mode_change only lives in the in-memory buffer
send({ type: "bash_exec", sessionId, command: "true", excludeFromContext: true });
await waitFor((f) => f.type === "bash_done" && f.sessionId === sessionId, "bash_done");

// 3) Enter plan mode
send({ type: "set_plan_mode", sessionId, enabled: true });
const on = await waitFor((f) => f.type === "plan_mode" && f.enabled === true, "plan_mode=true 帧");
if (on.planFilePath !== "local://PLAN.md") fail(`默认计划文件应为 local://PLAN.md，实际 ${on.planFilePath}`);
await sleep(300);
const afterEnter = modeChanges(sessionPath);
if (afterEnter.length !== 1 || afterEnter[0].mode !== "plan") fail(`mode_change 落盘不符：${JSON.stringify(afterEnter)}`);
if (afterEnter[0].data?.planFilePath !== "local://PLAN.md") fail("mode_change 未带 planFilePath");
console.log("✓ 进入计划模式：帧 enabled=true + mode_change(plan) 落盘");

// 4) Exit plan mode
send({ type: "set_plan_mode", sessionId, enabled: false });
await waitFor((f) => f.type === "plan_mode" && f.enabled === false, "plan_mode=false 帧");
await sleep(300);
const afterExit = modeChanges(sessionPath);
if (afterExit.at(-1)?.mode !== "none") fail(`退出未落 mode_change=none：${JSON.stringify(afterExit.at(-1))}`);
console.log("✓ 退出计划模式：帧 enabled=false + mode_change(none)");

// 5) Restart the host to clear the pool, then reopen the session -> restore from the persisted mode_change (an in-pool hit would reuse the snapshot and never exercise reconcile)
let activeSessionId = sessionId; // After the host restart in step 5 the session id changes; step 7's /plan must use the current id
send({ type: "set_plan_mode", sessionId, enabled: true });
await waitFor((f) => f.type === "plan_mode" && f.enabled === true, "二次进入帧");
await sleep(300);
if (!child?.pid) {
  console.log("⊘ 外部宿主无法重启清池，跳过重开恢复断言（步骤 5/6）");
} else {
  child.kill("SIGTERM");
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  child.once("exit", markExited);
  await exited;
  wsUrl = await launchHost();
  seen.length = 0; // Frames on the old connection are void; prevents a spurious ready hit
  attachWs(wsUrl);
  await waitFor((f) => f.type === "ready", "重启后 ready");
  send({ type: "load_session", path: sessionPath });
  const reloaded = await waitFor(
    (f) => f.type === "session_created" && f.path === sessionPath && f.sessionId !== sessionId,
    "重开会话",
  );
  activeSessionId = reloaded.sessionId!;
  const restored = await waitFor(
    (f) => f.type === "plan_mode" && f.sessionId === reloaded.sessionId && f.enabled === true,
    "重开会话的 plan_mode=true 恢复帧",
  );
  if (restored.planFilePath !== "local://PLAN.md") fail(`恢复的计划文件路径不符：${restored.planFilePath}`);
  console.log(`✓ 重开会话恢复计划模式（sessionId=${reloaded.sessionId!.slice(0, 8)}）`);

  // 6) Restoring does not double-entry
  const planEntries = modeChanges(sessionPath).filter((e) => e.mode === "plan");
  if (planEntries.length !== 2) fail(`恢复不应追加 mode_change：plan 条目数=${planEntries.length}`);
  console.log("✓ 恢复不重复记账（mode_change 仍为 2 条 plan）");
}

// 7) The /plan slash command: same route as the "Plan" button right of the permission capsule (no args = invert the current state).
// At this point the state is always enabled=true (entered in step 3 / restored in step 5), so exit first, then enter. Zero model calls.
seen.length = 0; // The assertions below only count frames newly produced on this path
send({ type: "prompt", sessionId: activeSessionId, text: "/plan", images: [] });
await waitFor(
  (f) => f.type === "plan_mode" && f.sessionId === activeSessionId && f.enabled === false,
  "/plan 退出计划模式的帧",
);
await waitFor((f) => f.type === "command_output" && String(f.text).includes("计划模式已退出"), "/plan 退出提示");
await waitFor(
  (f) => f.type === "command_result" && f.text === "/plan" && f.consumed === true,
  "/plan 的 command_result(consumed)",
);
send({ type: "prompt", sessionId: activeSessionId, text: "/plan", images: [] });
await waitFor(
  (f) => f.type === "plan_mode" && f.sessionId === activeSessionId && f.enabled === true,
  "/plan 再进计划模式的帧",
);
await waitFor((f) => f.type === "command_output" && String(f.text).includes("计划模式已开启"), "/plan 进入提示");
console.log("✓ /plan 命令 toggle：退出 → 进入，均以 command_result 消费（不落 prompt）");

console.log("\n全部断言通过");
if (child?.pid) child.kill("SIGTERM");
for (const f of createdFiles) await rm(f).catch(() => {});
process.exit(0);
