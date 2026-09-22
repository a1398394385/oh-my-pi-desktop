// 计划模式（plan）冒烟：进出模式帧、mode_change 落盘、重开会话恢复、恢复不重复记账。
// 用法：bun scripts/smoke-plan.ts [宿主ws地址]
// 不传地址时本脚本自行拉起宿主子进程，退出时删除测试产生的会话文件。零模型调用。
// 断言覆盖：
//   1. 新建会话即推 plan_mode=false 帧（UI 初始态）
//   2. set_plan_mode true → 帧 enabled=true + planFilePath=local://PLAN.md
//   3. 会话落盘后含 mode_change(plan, {planFilePath})
//   4. set_plan_mode false → 帧 enabled=false + mode_change(none)
//   5. 再次开启后 load_session → 从落盘 mode_change 恢复 enabled=true（reconcile）
//   6. 恢复不追加 mode_change（persist=false，条数不变）
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

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  wsUrl = await new Promise<string>((resolve, reject) => {
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
}

interface WireFrame {
  type: string;
  sessionId?: string;
  path?: string;
  enabled?: boolean;
  planFilePath?: string | null;
  text?: string;
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

const ws = new WebSocket(wsUrl);
ws.onmessage = (ev) => {
  const f = JSON.parse(String(ev.data)) as WireFrame;
  seen.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(f)) waiters.splice(i, 1)[0].resolve(f);
  }
};
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

// 1) 新建会话即推 plan_mode=false
const initial = await waitFor((f) => f.type === "plan_mode" && f.sessionId === sessionId, "新建会话的 plan_mode 帧");
if (initial.enabled !== false) fail("新建会话的 plan_mode 帧应为 enabled=false");
console.log("✓ 新建会话推送 plan_mode=false");

// 2) 先让懒建会话落盘（bash_exec 内部 ensureOnDisk）：否则 mode_change 只在内存缓冲
send({ type: "bash_exec", sessionId, command: "true", excludeFromContext: true });
await waitFor((f) => f.type === "bash_done" && f.sessionId === sessionId, "bash_done");

// 3) 进计划模式
send({ type: "set_plan_mode", sessionId, enabled: true });
const on = await waitFor((f) => f.type === "plan_mode" && f.enabled === true, "plan_mode=true 帧");
if (on.planFilePath !== "local://PLAN.md") fail(`默认计划文件应为 local://PLAN.md，实际 ${on.planFilePath}`);
await sleep(300);
const afterEnter = modeChanges(sessionPath);
if (afterEnter.length !== 1 || afterEnter[0].mode !== "plan") fail(`mode_change 落盘不符：${JSON.stringify(afterEnter)}`);
if (afterEnter[0].data?.planFilePath !== "local://PLAN.md") fail("mode_change 未带 planFilePath");
console.log("✓ 进入计划模式：帧 enabled=true + mode_change(plan) 落盘");

// 4) 退出计划模式
send({ type: "set_plan_mode", sessionId, enabled: false });
await waitFor((f) => f.type === "plan_mode" && f.enabled === false, "plan_mode=false 帧");
await sleep(300);
const afterExit = modeChanges(sessionPath);
if (afterExit.at(-1)?.mode !== "none") fail(`退出未落 mode_change=none：${JSON.stringify(afterExit.at(-1))}`);
console.log("✓ 退出计划模式：帧 enabled=false + mode_change(none)");

// 5) 再次开启后重开会话 → 从落盘 mode_change 恢复
send({ type: "set_plan_mode", sessionId, enabled: true });
await waitFor((f) => f.type === "plan_mode" && f.enabled === true, "二次进入帧");
await sleep(300);
send({ type: "load_session", path: sessionPath });
const reloaded = await waitFor(
  (f) => f.type === "session_created" && f.path === sessionPath && f.sessionId !== sessionId,
  "重开会话",
);
const restored = await waitFor(
  (f) => f.type === "plan_mode" && f.sessionId === reloaded.sessionId && f.enabled === true,
  "重开会话的 plan_mode=true 恢复帧",
);
if (restored.planFilePath !== "local://PLAN.md") fail(`恢复的计划文件路径不符：${restored.planFilePath}`);
console.log(`✓ 重开会话恢复计划模式（sessionId=${reloaded.sessionId!.slice(0, 8)}）`);

// 6) 恢复不重复记账
const planEntries = modeChanges(sessionPath).filter((e) => e.mode === "plan");
if (planEntries.length !== 2) fail(`恢复不应追加 mode_change：plan 条目数=${planEntries.length}`);
console.log("✓ 恢复不重复记账（mode_change 仍为 2 条 plan）");

console.log("\n全部断言通过");
if (child?.pid) child.kill("SIGTERM");
for (const f of createdFiles) await rm(f).catch(() => {});
process.exit(0);
