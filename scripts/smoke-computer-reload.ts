// Computer-use pool-eviction smoke: the per-session opt-in lives in the session
// settings overlay, whose writes are never persisted, so a pool eviction used
// to drop it (user report: "default on" sessions came back with computer use
// off). This script drives the real host and asserts the three cases:
//   1. desktop default on -> fresh session pushes computer_mode=true
//   2. host restart (pool cleared) -> load_session restores true from the default
//   3. toggle off -> second restart -> load_session restores false (explicit choice wins)
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-computer-reload.ts
// Zero model calls.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { smokeEnv, profileAgentPath } from "./smoke-profile.ts";

const cfgPath = profileAgentPath("omp-desktop.json");
const cfgBackup = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : null;
const createdFiles: string[] = [];
let child: ChildProcess | null = null;
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
  }
  for (const f of createdFiles) rm(f, { force: true }).catch(() => {});
  try {
    if (cfgBackup) writeFileSync(cfgPath, cfgBackup);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restore();
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    restore();
    process.exit(1);
  });
}

/** Desktop-owned default-on switch (omp-desktop.json computer.defaultEnabled). */
function writeDefaultEnabled(enabled: boolean) {
  const raw = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>) : {};
  const computer = raw.computer && typeof raw.computer === "object" ? (raw.computer as Record<string, unknown>) : {};
  writeFileSync(cfgPath, JSON.stringify({ ...raw, computer: { ...computer, defaultEnabled: enabled } }, null, 2));
}
writeDefaultEnabled(true);

function launchHost(): Promise<string> {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: smokeEnv(),
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

/** Kill the child (clears the in-memory pool) and wait for the process to leave. */
async function restartHost(): Promise<string> {
  if (!child?.pid) fail("无法重启宿主：child 已不存在");
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill("SIGTERM");
  await promise;
  return launchHost();
}

interface WireFrame {
  type: string;
  sessionId?: string;
  path?: string;
  enabled?: boolean;
  settings?: { computerEnabled?: boolean };
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
const send = (msg: unknown) => ws.send(JSON.stringify(msg));

let wsUrl = await launchHost();
attachWs(wsUrl);
await waitFor((f) => f.type === "ready", "ready");

// Master gate: the desktop default never opens a session while the settings-page
// computer.enabled switch is closed.
send({ type: "set_setting", key: "computer.enabled", value: true });
await waitFor((f) => f.type === "settings" && f.settings?.computerEnabled === true, "主开关打开");

// 1) Fresh session follows the desktop default
send({ type: "create_session" });
const created = await waitFor((f) => f.type === "session_created", "session_created");
const firstId = created.sessionId!;
const sessionPath = created.path!;
createdFiles.push(sessionPath);
await waitFor((f) => f.type === "computer_mode" && f.sessionId === firstId, "新建会话的 computer_mode 帧");
const freshOn = await waitFor((f) => f.type === "computer_mode" && f.sessionId === firstId && f.enabled === true, "新建会话 computer_mode=true");
if (!freshOn) fail("默认开启未落到新建会话");
console.log("✓ 默认开启：新建会话 computer_mode=true");

// Force the lazily-created session to disk so its path is the recorded key and reload can find it
send({ type: "bash_exec", sessionId: firstId, command: "true", excludeFromContext: true });
await waitFor((f) => f.type === "bash_done" && f.sessionId === firstId, "bash_done");

// 2) Pool cleared (host restart) -> the default is re-applied on load
wsUrl = await restartHost();
seen.length = 0;
attachWs(wsUrl);
await waitFor((f) => f.type === "ready", "重启后 ready");
send({ type: "get_settings" });
await waitFor((f) => f.type === "settings", "重启后 settings");
send({ type: "load_session", path: sessionPath });
const reloaded = await waitFor((f) => f.type === "session_created" && f.path === sessionPath, "重开会话");
const secondId = reloaded.sessionId!;
await waitFor((f) => f.type === "computer_mode" && f.sessionId === secondId && f.enabled === true, "重开后 computer_mode=true");
console.log("✓ 驱逐重载：默认开启被恢复（computer_mode=true）");

// 3) Explicit off is remembered across the next eviction
send({ type: "set_computer_mode", sessionId: secondId, enabled: false });
await waitFor((f) => f.type === "computer_mode" && f.sessionId === secondId && f.enabled === false, "点击关闭");
seen.length = 0;
wsUrl = await restartHost();
attachWs(wsUrl);
await waitFor((f) => f.type === "ready", "重启后 ready");
send({ type: "load_session", path: sessionPath });
const third = await waitFor((f) => f.type === "session_created" && f.path === sessionPath, "二次重开会话");
const thirdId = third.sessionId!;
await waitFor((f) => f.type === "computer_mode" && f.sessionId === thirdId, "二次重开的 computer_mode 帧");
// A stale true would land in this window; the frame above is the last snapshot push.
const settle = Promise.withResolvers<void>();
setTimeout(settle.resolve, 500);
await settle.promise;
if (seen.some((f) => f.type === "computer_mode" && f.sessionId === thirdId && f.enabled === true)) {
  fail("显式关闭未持久化：二次重载又变回开启");
}
console.log("✓ 显式关闭：二次驱逐重载后仍为 computer_mode=false");

// 4) delete_session sweeps the record: a rebuilt file at the same path starts clean
send({ type: "delete_session", path: sessionPath });
await waitFor((f) => f.type === "session_unloaded" && f.path === sessionPath, "删除会话广播");
// omp-desktop.json shape is host-owned (host/computer-mode.ts readComputerSessions)
const doc = JSON.parse(readFileSync(cfgPath, "utf8")) as { computer?: { sessions?: Record<string, unknown> } };
const kept = doc.computer?.sessions?.[sessionPath];
if (kept !== undefined) fail(`删除会话未清理 computer.sessions：${JSON.stringify(kept)}`);
console.log("✓ 删除会话清理 computer.sessions 记录");

restore();
console.log("✓ computer use 池驱逐恢复链全部通过");
process.exit(0);
