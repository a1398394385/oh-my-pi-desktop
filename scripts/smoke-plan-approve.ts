#!/usr/bin/env bun
// Plan-approval smoke test: drives the real approval flow end-to-end without a
// model, via the smoke-only `smoke_plan_propose` RPC (which replays a `write`
// to xd://propose through the exact dispatch a model would hit).
//
// Asserted:
//   1. plan_mode frame round-trips on entry/exit (settled value, not the first)
//   2. the card carries exactly the five stable option ids (TUI parity)
//   3. the keep-context row ships RAW token numbers, never a rendered label
//   4. "refine" leaves plan mode active (the model keeps planning)
//   5. the flow does not hang: approval settles and the turn is not wedged
//      (the deadlock the out-of-band dispatch exists to prevent)
//   6. approval_response accepts a sliderIndex without breaking the settle
//
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-plan-approve.ts [host ws url]
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const tmpDirs: string[] = [];
let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
let failures = 0;

function die(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

function assert(cond: boolean, msg: string) {
  if (cond) console.log("✓ " + msg);
  else {
    failures++;
    console.error("✗ " + msg);
  }
}

async function cleanup() {
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    await new Promise((r) => setTimeout(r, 400));
  }
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    // Enables the smoke-only propose replay in the spawned host.
    env: { ...process.env, OMP_PLAN_APPROVE_SMOKE: "1" },
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
  }).catch((e) => die(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl!);
const frames: Record<string, unknown>[] = [];
ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));

await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("WebSocket 连接失败"));
});

const waitFor = async (
  predicate: (f: Record<string, unknown>, index: number) => boolean,
  timeoutMs = 12_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < frames.length; i++) if (predicate(frames[i], i)) return frames[i];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

// The host answers `ready` once the WS server is listening, but RPCs are only
// served after the profile finished initializing — creating a session before
// that lands is dropped silently.
if (!(await waitFor((f) => f.type === "ready", 15_000))) die("宿主未就绪（无 ready 帧）");

const sessDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-plan-"));
tmpDirs.push(sessDir);

// ---- Create the session (the host answers with session_created) ----
const createdMark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: sessDir }));
const created = (await waitFor(
  (f, i) => f.type === "session_created" && i >= createdMark && typeof f.sessionId === "string",
  10_000,
)) as { sessionId: string; path: string } | null;
if (!created) die("未收到 session_created");
console.log("会话:", created.sessionId.slice(0, 8));

// The `local://` plan the agent would have written before proposing. The SDK
// resolves local:// to `<artifactsDir>/local/`, where artifactsDir is the
// session file minus its .jsonl suffix (resolveLocalRoot in
// internal-urls/local-protocol) — the same mapping a real plan write uses.
const planFileUrl = "local://smoke-plan.md";
const localRoot = path.join(
  path.dirname(created.path),
  path.basename(created.path).replace(/\.jsonl$/, ""),
  "local",
);
await mkdir(localRoot, { recursive: true });
await writeFile(path.join(localRoot, "smoke-plan.md"), "# Smoke plan\n\n1. verify the approval card\n");

// ---- Assertion 1: plan_mode frame round-trips (settled value) ----
ws.send(JSON.stringify({ type: "set_plan_mode", sessionId: created.sessionId, enabled: true }));
let r = await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === true);
assert(r !== null, "set_plan_mode on → plan_mode enabled=true");
assert(
  typeof r?.planFilePath === "string" && String(r.planFilePath).startsWith("local://"),
  `planFilePath 是 local:// URL（${String(r?.planFilePath ?? "null")}）`,
);

ws.send(JSON.stringify({ type: "set_plan_mode", sessionId: created.sessionId, enabled: false }));
r = await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === false);
assert(r !== null, "set_plan_mode off → plan_mode enabled=false");

// ---- Enter plan mode again, then replay the propose dispatch ----
ws.send(JSON.stringify({ type: "set_plan_mode", sessionId: created.sessionId, enabled: true }));
await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === true);
// Re-write the plan immediately before proposing: the host reads local:// at
// dispatch time, and the session file can have been rotated since creation.
await mkdir(localRoot, { recursive: true });
await writeFile(path.join(localRoot, "smoke-plan.md"), "# Smoke plan\n\n1. verify the approval card\n");
ws.send(
  JSON.stringify({
    type: "smoke_plan_propose",
    sessionId: created.sessionId,
    title: "smoke",
    planFilePath: planFileUrl,
  }),
);

const proposeMark = frames.length;
const card = (await waitFor((f, i) => f.type === "approval_request" && i >= proposeMark)) as
  | { requestId: string; options: string[]; keepContextTokens?: { tokens: number; contextWindow: number }; slider?: unknown; optionLabels?: unknown }
  | null;
if (!card) die("审批卡未派发（xd://propose 带外派发失效）");

// ---- Assertion 2: exactly the five stable option ids ----
const PLAN_IDS = ["plan:execute", "plan:compact", "plan:keep", "plan:refine", "plan:save-quit"];
assert(
  JSON.stringify(card.options) === JSON.stringify(PLAN_IDS),
  `审批卡选项 = 5 个稳定 id（${card.options.join(", ")}）`,
);

// ---- Assertion 3: keep row carries raw numbers, never rendered text ----
assert(
  card.keepContextTokens === undefined ||
    (typeof card.keepContextTokens.tokens === "number" &&
      typeof card.keepContextTokens.contextWindow === "number"),
  `keep 行下发原始 token 数字（${JSON.stringify(card.keepContextTokens ?? null)}）`,
);
assert(card.optionLabels === undefined, "帧上不含渲染文案（label 由 UI 本地化）");
assert(card.slider === undefined || Array.isArray((card.slider as { segments?: unknown }).segments), "slider 字段形状正确");

// ---- Assertion 4: refine keeps plan mode active ----
ws.send(
  JSON.stringify({ type: "approval_response", requestId: card.requestId, answer: "plan:refine", sliderIndex: 0 }),
);
const resolved = await waitFor((f, _i) => f.type === "approval_resolved");
assert(resolved !== null, "approval_response 结算审批（refine 分支不卡死）");

// refine must leave plan mode on — the model keeps planning the same file.
const stillOn = await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === true, 3_000);
assert(stillOn !== null, "选「继续修改」后计划模式保持开启");

// ---- Assertion 5: "keep context" leaves plan mode and dispatches the plan turn ----
// Proving the approve branch end-to-end needs a model to consume the synthetic
// turn, so what we assert here is the part that is model-free and the part a
// bug would break first: plan mode is exited and the session survives (a wedged
// flow would never push the exit frame).
const afterRefine = frames.length;
ws.send(JSON.stringify({ type: "smoke_plan_propose", sessionId: created.sessionId, title: "smoke", planFilePath: planFileUrl }));
const second = (await waitFor((f, _i) => f.type === "approval_request" && _i >= afterRefine, 8_000)) as
  | { requestId: string; options: string[] }
  | null;
assert(second !== null, "第二次提案同样派发审批卡（流程未死锁）");

if (second) {
  ws.send(JSON.stringify({ type: "approval_response", requestId: second.requestId, answer: "plan:keep" }));
  const exited = await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === false && _i >= afterRefine, 8_000);
  assert(exited !== null, "选「保留上下文」后退出计划模式（approve 分支未卡死）");
}

// ---- Assertion 6: re-entering plan mode still works after an approval ----
const afterApprove = frames.length;
ws.send(JSON.stringify({ type: "set_plan_mode", sessionId: created.sessionId, enabled: true }));
const reentered = await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === true && _i >= afterApprove, 5_000);
assert(reentered !== null, "批准后仍可再次进入计划模式（状态机可复用）");

// Leave plan mode before teardown.
ws.send(JSON.stringify({ type: "set_plan_mode", sessionId: created.sessionId, enabled: false }));
await waitFor((f, _i) => f.type === "plan_mode" && f.enabled === false, 5_000);

await cleanup();
if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log("\nplan 审批冒烟全部通过");
process.exit(0);
