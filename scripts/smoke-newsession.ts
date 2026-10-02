// New-session contract smoke test: config defaults delivered + configured echoed back + the list fallback for lazily-created sessions.
// Usage: bun scripts/smoke-newsession.ts [host ws url]
// Assertions cover (the 2026-09-20 fix series; any regression fails):
//   1. The ready frame carries defaultModel/defaultThinking (the host-side config delivery contract)
//   2. create_session with thinking echoes the configured value (passing auto returns auto, not the effective high)
//   3. Immediately after creation, list_sessions must include the session (BUG-005: the base lazily creates the file; the in-memory pool is the fallback)
// No prompts sent, no real model calls; exits when done.
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

// list_sessions' history scan merges the temp cwd into omp-desktop.json's allProjects and persists it,
// so it must be restored before exit (including failure paths); otherwise every smoke run leaves a ghost project in the user config
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const cfgPath = path.join(homedir(), ".omp/agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const tmpDirs: string[] = [];

function restoreCfg() {
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    try { execSync("sleep 0.8"); } catch {} // Wait for the host to finish exiting before writing back, so an exit hook cannot write the test state back
  }
  try {
    if (cfgExisted) writeFileSync(cfgPath, cfgBackup!);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restoreCfg();
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
    child!.stdout!.on("data", function onLine(chunk) {
      const m = chunk.match(/READY (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        child!.stdout!.off("data", onLine);
        resolve(m[1]);
      }
    });
  }).catch((e) => fail(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("60s 内未完成全部断言"), 60_000);

const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
  console.log("✓ " + msg);
};

const frames: any[] = [];
const waitType = (t: string, after = 0, ms = 15_000) =>
  new Promise<any>((resolve, reject) => {
    const hit = () => frames.findIndex((f, i) => f.type === t && i >= after);
    if (hit() >= 0) return resolve(frames[hit()]);
    const timer = setTimeout(() => reject(new Error(`等待 ${t} 超时`)), ms);
    const iv = setInterval(() => {
      const i = hit();
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(iv);
        resolve(frames[i]);
      }
    }, 20);
  });

ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws 连接失败"));
}).catch((e) => fail(String(e)));

// ---- Assertion 1: ready frame delivers config defaults ----
const ready = await waitType("ready").catch((e) => fail(String(e)));
assert(ready.defaultModel != null, `ready 帧 defaultModel=${ready.defaultModel}`);
assert(ready.defaultThinking != null, `ready 帧 defaultThinking=${ready.defaultThinking}`);

const cwd = await mkdtemp(path.join(tmpdir(), "omp-smoke-ns-"));
tmpDirs.push(cwd);

// ---- Assertion 2: explicit thinking echoes the configured value ----
const mark1 = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd, thinking: "auto" }));
const created1 = await waitType("session_created", mark1).catch((e) => fail(String(e)));
assert(created1.thinking === "auto", `带 auto 建会话回推 configured=${created1.thinking}（应为 auto，不是生效值）`);

// ---- Assertion 3: immediate list_sessions includes the new session (BUG-005 regression) ----
const mark2 = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
const list = await waitType("session_list", mark2).catch((e) => fail(String(e)));
const inList = (l: any, p: string) =>
  (l.projects ?? []).flatMap((pr: any) => pr.sessions ?? []).some((s: any) => s.path === p);
assert(inList(list, created1.path), "新建后立即 list_sessions 含该会话（内存池兜底）");

// ---- Assertion 4: reload_settings' models frame also carries config defaults (the refetch path when clicking new) ----
const mark4 = frames.length;
ws.send(JSON.stringify({ type: "reload_settings" }));
const models = await waitType("models", mark4).catch((e) => fail(String(e)));
assert(
  models.defaultModel === ready.defaultModel && models.defaultThinking === ready.defaultThinking,
  "reload_settings → models 帧携带 defaultModel/defaultThinking",
);

clearTimeout(failTimeout);
ws.close();
restoreCfg();
for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
console.log("全部断言通过（omp-desktop.json 已还原）");
process.exit(0);
