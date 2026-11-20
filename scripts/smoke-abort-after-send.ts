// Abort-after-send smoke: send a prompt, then hit abort N ms later (what Esc does
// in the composer) and check that the SESSION LIST stops showing the run.
//
// This drives the real frontend store (happy-dom) against a real host, so the
// assertion covers both surfaces the user sees:
//   - `openSessions.get(path).streaming` — the working row / stop button state
//   - `busyPaths.has(path)`             — the sidebar row spinner
//
// The known returner: the sidebar reads `streaming || busyPaths`; the UI clears
// `streaming` from `prompt_dropped` (or from the abort receipt's 2s fallback),
// but `busyPaths` only changes when the host pushes a `pool_sessions` frame —
// and the host publishes that frame only from agent_start/agent_end. An abort
// that lands during prompt setup (the base's `isStreaming` also covers
// `#promptInFlightCount`) produces no agent lifecycle event at all, so a
// `busy=true` snapshot taken inside that window is never corrected.
//
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-abort-after-send.ts
//          [--delays=0,30,100,300] [--settle=4000]
//   OMP_DESKTOP_MODEL=<provider/model> overrides the created session's model.
// Exit codes: 0 every scenario settled, 1 a run was still shown after the settle
// window, 2 nothing could be judged (session creation failed).
import { smokeEnv } from "./smoke-profile.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Window } from "happy-dom";
import type { HostFrame } from "../ui-src/types/frames";

const PROMPT_TEXT = "只回复 OK";

const argv = process.argv.slice(2);
const delaysArg = argv.find((a) => a.startsWith("--delays="));
const settleArg = argv.find((a) => a.startsWith("--settle="));
const delays = (delaysArg ? delaysArg.slice("--delays=".length) : "0,50,100,200,400,800")
  .split(",")
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n) && n >= 0);
const SETTLE_MS = settleArg ? Number(settleArg.slice("--settle=".length)) : 4000;
const model = process.env.OMP_DESKTOP_MODEL?.trim() || undefined;

// ---- happy-dom: the frontend store imports browser globals at module scope ----
// ?preview=1: a desktop-like client, not a remote browser (same as scripts/ui-smoke-env.ts)
const win = new Window({ url: "http://localhost/index.html?preview=1" });
globalThis.window = win as unknown as Window & typeof globalThis;
globalThis.location = win.location;
globalThis.document = win.document as unknown as Document;
globalThis.localStorage = win.localStorage;
globalThis.navigator = win.navigator as unknown as Navigator;
globalThis.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof globalThis.matchMedia;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;

// index first: it evaluates the ws slice module before the latter's circular import back
// (dynamic on purpose: the store modules read browser globals at module scope, so the
// happy-dom shims above must exist first — same constraint as smoke-subagent-subview)
const { useAppStore } = await import("../ui-src/store/index");
const { onMessage } = await import("../ui-src/store/ws");
const { dispatchPrompt } = await import("../ui-src/store/session");

let child: ChildProcess | null = null;
const tmpDirs: string[] = [];
const createdSessions: Array<{ path: string; sessionId: string }> = [];

function fail(msg: string): never {
  console.error("✗ " + msg);
  child?.kill("SIGTERM");
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: smokeEnv(),
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = Promise.withResolvers<string>();
const readyTimer = setTimeout(() => ready.reject(new Error("宿主 30s 未就绪")), 30_000);
const onLine = (chunk: string) => {
  const m = chunk.match(/READY (ws:\/\/\S+)/);
  if (!m) return;
  clearTimeout(readyTimer);
  child!.stdout!.off("data", onLine);
  ready.resolve(m[1]);
};
child.stdout!.setEncoding("utf8");
child.stdout!.on("data", onLine);
const wsUrl = await ready.promise.catch((e) => fail(String(e)));
console.log("宿主已就绪:", wsUrl);

const ws = new WebSocket(wsUrl);
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as HostFrame & Record<string, unknown>;
  onMessage(msg);
  if (msg.type === "session_created" && typeof msg.path === "string" && typeof msg.sessionId === "string") {
    createdSessions.push({ path: msg.path, sessionId: msg.sessionId });
  }
  if (msg.type === "error") fail(`收到 error: ${String(msg.message)}`);
};
ws.onerror = () => fail("WS 错误");
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("10s 内未连上宿主")), 10_000);
  ws.onopen = () => {
    clearTimeout(timer);
    resolve();
  };
}).catch((e) => fail(String(e)));
useAppStore.setState({ ws: ws as unknown as WebSocket });

interface ScenarioResult {
  label: string;
  streamingAfter: boolean;
  busyAfter: boolean;
  /** The sidebar spinner was actually observed on during this scenario. */
  sawBusy: boolean;
}

async function runScenario(delay: number): Promise<ScenarioResult> {
  const label = `delay=${delay}ms`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-abort-send-"));
  tmpDirs.push(cwd);
  const before = createdSessions.length;
  ws.send(JSON.stringify({ type: "create_session", cwd, ...(model ? { model } : {}) }));
  let created = createdSessions[before];
  for (let i = 0; i < 500 && !created; i++) {
    await sleep(20);
    created = createdSessions[before];
  }
  if (!created) fail(`${label}: 20s 内没有 session_created`);
  const filePath = created.path;
  const session = useAppStore.getState().openSessions.get(filePath);
  if (!session) fail(`${label}: store 未建立该会话的 openSession`);

  // Exactly the composer path: optimistic run start + prompt RPC.
  dispatchPrompt(session.sessionId, PROMPT_TEXT, []);
  // Whatever list refresh the UI would do next (another session's turn_end,
  // switching views, …): this is what lands a busy=true snapshot on the client.
  useAppStore.getState().send({ type: "list_sessions" });

  let sawBusy = false;
  const sampler = setInterval(() => {
    if (useAppStore.getState().busyPaths.has(filePath)) sawBusy = true;
  }, 10);

  if (delay > 0) await sleep(delay);
  // Esc with an empty composer: the only thing the keybinding sends.
  useAppStore.getState().send({ type: "abort_session", sessionId: session.sessionId });
  await sleep(SETTLE_MS);
  clearInterval(sampler);

  const st = useAppStore.getState();
  return {
    label,
    streamingAfter: st.openSessions.get(filePath)?.streaming === true,
    busyAfter: st.busyPaths.has(filePath),
    sawBusy,
  };
}

const results: ScenarioResult[] = [];
try {
  for (const delay of delays) results.push(await runScenario(delay));
} finally {
  // Clean the sessions this run created (a busy session refuses deletion; the
  // failure is the bug itself, so nothing is retried here).
  for (const s of createdSessions) ws.send(JSON.stringify({ type: "delete_session", path: s.path }));
  await sleep(300);
  ws.close();
  child?.kill("SIGTERM");
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
}

let failures = 0;
for (const r of results) {
  const ok = !r.streamingAfter && !r.busyAfter;
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${r.label}: streaming=${r.streamingAfter} busyPaths=${r.busyAfter}（本场景期间侧栏是否亮过运行中: ${r.sawBusy}）`,
  );
}

if (failures > 0) {
  console.error(
    `ESC 之后会话仍被显示为运行中：streaming 与 busyPaths 必须在 ${SETTLE_MS}ms 内都回落。busyPaths 卡 true 说明宿主没有广播 busy=false（见 host/state.ts publishPoolIfBusyChanged）。`,
  );
  process.exit(1);
}
if (!results.some((r) => r.sawBusy)) {
  console.error(
    "没有任何场景让侧栏亮过运行中（宿主在 abort 前一直自称空闲），本次无法判定 busyPaths 是否会被清。加大 --delays（例如 800,1500）再跑。",
  );
  process.exit(2);
}
console.log("smoke-abort-after-send: OK（每个场景在 ESC 后都回到空闲）");
