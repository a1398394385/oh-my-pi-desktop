// Computer-use toggle regression smoke: the user's report is that computer use
// opened via `/computer on` cannot be closed by clicking the composer's screen
// icon. The icon sends set_computer_mode(enabled=false); this script drives the
// real host over WebSocket through the exact chain: open the master gate,
// create a session, run `/computer on` as a prompt (the dispatchSlashInput
// path), then fire the icon's RPC and assert the resulting computer_mode
// frame actually flips to false (and that the frame after `/computer on` is
// true — a stale frame there means the button never lit, which is the same
// bug from the other side).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-computer-toggle.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const cfgPath = path.join(agentDir, "omp-desktop.json");
const fixtureCwd = path.join(homedir(), ".omp/profiles", profile, "run/smoke-computer-toggle-fixture");

const cfgBackup = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : null;
// Deterministic start: default provider, so the kimi branch cannot mask the chain
try {
  const raw = cfgBackup ? (JSON.parse(cfgBackup) as Record<string, unknown>) : {};
  delete raw.computer;
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
} catch {}
mkdirSync(fixtureCwd, { recursive: true });

let child: ChildProcess | null = null;
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
  }
  try {
    rmSync(fixtureCwd, { recursive: true, force: true });
  } catch {}
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

process.on("SIGINT", () => {
  restore();
  process.exit(1);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(1);
});

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, OMP_PROFILE: profile },
  stdio: ["ignore", "pipe", "inherit"],
});

const { promise: readyPromise, resolve: resolveWsUrl } = Promise.withResolvers<string>();
const readyTimer = setTimeout(() => fail("host not READY in 30s"), 30_000);
child!.stdout!.setEncoding("utf8");
child!.stdout!.on("data", function onLine(chunk: string) {
  const m = chunk.match(/READY (ws:\/\/\S+)/);
  if (m) {
    clearTimeout(readyTimer);
    child!.stdout!.off("data", onLine);
    resolveWsUrl(m[1]);
  }
});
const wsUrl = await readyPromise;

console.log("host ready:", wsUrl);
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => fail("timeout before the toggle chain finished"), 60_000);

// stage 0: gate closed -> open gate -> create -> /computer on -> icon off
let stage = 0;
let sessionId = "";
// Frames for the current session only; the final computer_mode frame after
// each mutation is what the composer button displays.
const modeFrames: boolean[] = [];
// kimi round: /computer on must actually mount kimi-cu (the rerouted command
// drives the same provider logic as the icon), and the icon off must unmount it.
let kimiInstalled = false;
let kimiMounted = false;
let kimiUnmounted = false;

function send(obj: unknown) {
  ws.send(JSON.stringify(obj));
}

ws.onmessage = (ev: MessageEvent) => {
  const msg = JSON.parse(String(ev.data));

  if (msg.type === "settings" && stage === 0) {
    if (msg.settings?.computerProvider !== "default") fail(`provider should be default, got ${msg.settings?.computerProvider}`);
    stage = 1;
    console.log("step 1: open master gate (set_setting computer.enabled=true)");
    send({ type: "set_setting", key: "computer.enabled", value: true });
    return;
  }
  if (msg.type === "settings" && stage === 1) {
    stage = 2;
    console.log("step 2: create_session");
    send({ type: "create_session", cwd: fixtureCwd });
    return;
  }
  if (msg.type === "session_created" && stage === 2) {
    sessionId = msg.sessionId;
    stage = 3;
    console.log("step 3 (default provider): prompt '/computer on'");
    send({ type: "prompt", sessionId, text: "/computer on" });
    return;
  }
  // create_session's snapshot also pushes a computer_mode frame (false), so
  // the per-step assertion anchor is command_result: by then the post-command
  // frame (pushed just before command_result in dispatchSlashInput) landed.
  if (msg.type === "computer_mode" && msg.sessionId === sessionId && stage === 4) {
    if (msg.enabled === true) fail("default: icon click did not turn computer use off");
    console.log("✓ default provider: on via /computer, off via the icon — frames:", modeFrames.join(","));
    modeFrames.length = 0;
    stage = 5;
    console.log("step 5: switch provider to kimi (the user's dev configuration)");
    send({ type: "set_computer_provider", provider: "kimi" });
    return;
  }
  // The icon-off completes only after the unmount's capabilities_mcp lands
  // (unmount pushes it right before the closing computer_mode frame, but the
  // two frames race across awaits — settle both before asserting).
  if (msg.type === "computer_mode" && msg.sessionId === sessionId && stage === 7 && msg.enabled === false) {
    if (kimiInstalled && kimiMounted && !kimiUnmounted) return; // wait for the unmount frame
    clearTimeout(timer);
    console.log("kimi round frames:", modeFrames.join(","));
    restore();
    console.log("✓ kimi provider: /computer on mounts kimi-cu, the icon turns it off");
    process.exit(0);
  }
  if (msg.type === "computer_mode" && msg.sessionId === sessionId) {
    modeFrames.push(msg.enabled === true);
    return;
  }
  if (msg.type === "command_result" && msg.sessionId === sessionId && msg.text === "/computer on" && stage === 3) {
    const last = modeFrames[modeFrames.length - 1];
    if (last !== true) fail(`default: /computer on left the button dark (last frame=${last})`);
    stage = 4;
    console.log("step 4 (default): click the icon (set_computer_mode enabled=false)");
    send({ type: "set_computer_mode", sessionId, enabled: false });
    return;
  }
  if (msg.type === "settings" && stage === 5) {
    kimiInstalled = msg.settings?.kimiCuInstalled === true;
    stage = 6;
    console.log("step 6 (kimi provider): prompt '/computer on'");
    send({ type: "prompt", sessionId, text: "/computer on" });
    return;
  }
  if (msg.type === "capabilities_mcp" && msg.sessionId === sessionId && stage >= 6) {
    const servers = msg.mcp?.servers ?? [];
    if (servers.some((s: { name: string; status: string }) => s.name === "kimi-cu" && s.status === "connected")) kimiMounted = true;
    // unmount upserts kimi-cu as "disconnected" (it stays listed), so "gone" = no longer connected
    if (kimiMounted && stage >= 7 && !servers.some((s: { name: string; status: string }) => s.name === "kimi-cu" && s.status === "connected")) kimiUnmounted = true;
    return;
  }
  if (msg.type === "command_result" && msg.sessionId === sessionId && msg.text === "/computer on" && stage === 6) {
    const last = modeFrames[modeFrames.length - 1];
    if (last !== true) fail(`kimi: /computer on left the button dark (last frame=${last})`);
    if (kimiInstalled && !kimiMounted) fail("kimi: /computer on did not mount kimi-cu (command must drive the app toggle, not the base overlay)");
    stage = 7;
    console.log("step 7 (kimi): click the icon (set_computer_mode enabled=false)");
    send({ type: "set_computer_mode", sessionId, enabled: false });
    return;
  }
};

ws.onopen = () => {
  send({ type: "get_settings" });
};
ws.onerror = () => fail("websocket error");
