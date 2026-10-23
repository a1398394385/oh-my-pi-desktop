// Cross-channel session-list broadcast smoke: a session created on ONE channel
// (local desktop vs remote control) must appear in the OTHER channel's sidebar
// without a reconnect. Before this, every list-mutating RPC pushed
// session_list back to the requesting socket only, so a session born on the
// phone stayed invisible on the desktop until it reconnected.
// Run: bun scripts/smoke-cross-ui-list.ts
// Spawns the real host under omp-desktop-test with the LAN remote server on a
// throwaway port, then drives both channels over real WebSockets. No prompts,
// no model calls; the created session file is deleted before exit.
import { profileAgentPath, smokeEnv } from "./smoke-profile.ts";

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REMOTE_PORT = 16899;
const REMOTE_KEY = randomBytes(16).toString("hex");

const cfgPath = profileAgentPath("omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;
// Remote must be on for this smoke; restore the exact previous bytes on exit so
// the shared test profile keeps whatever the last run left behind.
const cfg = cfgExisted ? JSON.parse(cfgBackup!) : {};
cfg.remote = { ...(cfg.remote ?? {}), enabled: true, port: REMOTE_PORT, accessKey: REMOTE_KEY };
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// The test profile carries no provider credentials, and create_session needs a
// model to build the session. Declare a config-layer mock provider (auth: none,
// endpoint never contacted — this smoke sends no prompt) and restore the file after.
const modelsPath = profileAgentPath("models.yml");
const modelsExisted = existsSync(modelsPath);
const modelsBackup = modelsExisted ? readFileSync(modelsPath, "utf8") : null;
if (!modelsExisted) {
  writeFileSync(
    modelsPath,
    [
      "providers:",
      "  smoke-mock:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    api: openai-completions",
      "    apiKey: smoke-key",
      "    models:",
      "      - id: smoke-model",
      "        name: Smoke Model",
      "        contextWindow: 32000",
      "        maxTokens: 4096",
      "",
    ].join("\n"),
  );
}

let child: ReturnType<ChildProcess> | null = null;
const tmpDirs: string[] = [];

function restoreCfg() {
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    try {
      execSync("sleep 0.8");
    } catch {
      /* best effort */
    }
  }
  try {
    if (cfgExisted) writeFileSync(cfgPath, cfgBackup!);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
    if (modelsExisted) writeFileSync(modelsPath, modelsBackup!);
    else if (existsSync(modelsPath)) unlinkSync(modelsPath);
  } catch {
    /* best effort */
  }
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restoreCfg();
  process.exit(1);
}

const cwdRepo = Bun.fileURLToPath(new URL("..", import.meta.url));
child = spawn("bun", ["host/host.ts"], { cwd: cwdRepo, env: smokeEnv(), stdio: ["ignore", "pipe", "inherit"] });
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (!m) return;
    clearTimeout(timer);
    child!.stdout!.off("data", onLine);
    resolve(m[1]);
  });
}).catch((e) => fail(String(e)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = { type?: string; path?: string; projects?: Array<{ sessions: Array<{ path: string; pending?: boolean }> }> };

async function connect(url: string, label: string) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 10s 未连接`)), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => reject(new Error(`${label} 连接失败`));
  });
  const waitType = (t: string, after: number, ms = 15_000) =>
    new Promise<Frame>((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const hit = frames.slice(after).find((f) => f.type === t);
        if (hit) {
          clearInterval(tick);
          resolve(hit);
        } else if (Date.now() - started > ms) {
          clearInterval(tick);
          reject(new Error(`${label} ${ms / 1000}s 内未收到 ${t}`));
        }
      }, 50);
    });
  const mark = () => frames.length;
  return { ws, frames, waitType, mark, label };
}

const rowOf = (frames: Frame[], p: string) =>
  frames
    .filter((f) => f.type === "session_list")
    .flatMap((f) => f.projects ?? [])
    .flatMap((pr) => pr.sessions ?? [])
    .find((s) => s.path === p);

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failures++;
};

const desktop = await connect(wsUrl, "desktop");
// The LAN server comes up after the primary WS: retry until it answers.
let phone: Awaited<ReturnType<typeof connect>> | null = null;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    phone = await connect(`ws://127.0.0.1:${REMOTE_PORT}/ws?t=${REMOTE_KEY}`, "phone");
    break;
  } catch {
    await sleep(250);
  }
}
if (!phone) fail(`phone channel did not listen on ${REMOTE_PORT}`);
await desktop.waitType("ready", 0).catch((e) => fail(String(e)));
await phone.waitType("ready", 0).catch((e) => fail(String(e)));

const createdPaths: string[] = [];
for (const [who, other] of [
  [phone, desktop],
  [desktop, phone],
] as const) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-smoke-cross-ui-"));
  tmpDirs.push(cwd);
  const otherMark = other.mark();
  const ownMark = who.mark();
  who.ws.send(JSON.stringify({ type: "create_session", cwd }));
  const created = await who.waitType("session_created", ownMark).catch((e) => fail(String(e)));
  ok(`${who.label}建会话收到 session_created`, typeof created.path === "string");
  createdPaths.push(created.path!);
  const list = await other
    .waitType("session_list", otherMark)
    .catch(() => fail(`${who.label}建会话后另一端未收到 session_list（跨端不实时）`));
  const row = rowOf([list], created.path!);
  ok(`${who.label}建会话 → other channel lists the row`, !!row);
  ok(`row carries pending:true`, row?.pending === true);
}

for (const p of createdPaths) {
  desktop.ws.send(JSON.stringify({ type: "delete_session", sessionId: p }));
  await desktop.waitType("session_deleted", desktop.frames.length - 1, 5_000).catch(() => {});
}

desktop.ws.close();
phone.ws.close();
await sleep(200);
restoreCfg();
for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
console.log(failures > 0 ? `失败 ${failures} 项` : "全部通过");
process.exit(failures > 0 ? 1 : 0);
