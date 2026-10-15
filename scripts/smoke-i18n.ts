// i18n wave-1 smoke: host-side locale preference chain.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-i18n.ts
// Fails fast unless OMP_PROFILE points at a non-default profile — the smoke
// must never touch the user's default ~/.omp/agent.
// Asserts:
//   1. zh default: set_setting with an unknown key -> error frame carries the
//      Chinese unknown-setting message
//   2. set_locale en (fire-and-forget, no ack frame) -> set_setting with an
//      unknown key -> error frame contains "Unknown setting key" (host i18n
//      switched live)
//   3. the test profile's omp-desktop.json has ui.locale === "en" (persisted)
// Cleanup: the spawned host is killed (SIGTERM, SIGKILL fallback) on every
// exit path. The ui section is cleared BEFORE the host spawns so assertion 1
// always starts from the zh default (repeatable runs); it is intentionally
// NOT restored afterwards — test-profile state may stay.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE?.trim();
if (!profile || profile === "default") {
  console.error("✗ 需要 OMP_PROFILE 指向非 default 的测试 profile（用法：OMP_PROFILE=omp-desktop-test bun scripts/smoke-i18n.ts），严禁污染 default profile");
  process.exit(1);
}

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const cfgDir = path.join(homedir(), ".omp", "profiles", profile, "agent");
const cfgPath = path.join(cfgDir, "omp-desktop.json");

// The profile dir and a known ui-section state must exist BEFORE the host
// spawns: a previous smoke run leaves locale=en behind (allowed to persist),
// which would otherwise break the zh-default assertion on re-runs.
mkdirSync(cfgDir, { recursive: true });
if (existsSync(cfgPath)) {
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    if (raw.ui !== undefined) {
      delete raw.ui;
      writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
    }
  } catch {
    // unreadable/corrupt file: reset to a known empty state
    writeFileSync(cfgPath, "{}");
  }
}

let child: ReturnType<typeof spawn> | null = null;

/** Kill the spawned host and wait for it to actually exit (SIGKILL after 3s). */
async function killHost(): Promise<void> {
  const dying = child;
  child = null;
  if (!dying?.pid) return;
  const exited = new Promise<void>((resolve) => dying.on("exit", () => resolve()));
  dying.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  if (dying.pid) {
    try { dying.kill("SIGKILL"); } catch {}
  }
  await exited;
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
  console.log("✓ " + msg);
};

let exitCode = 0;
try {
  // ---------- spawn host ----------
  child = spawn("bun", ["host/host.ts"], {
    cwd: repoRoot,
    env: { ...process.env, OMP_PROFILE: profile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const wsUrl = await new Promise<string>((resolve, reject) => {
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
  });
  console.log("宿主已就绪:", wsUrl);

  // ---------- connect ----------
  const ws = new WebSocket(wsUrl);
  const frames: any[] = [];
  ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ws 连接失败"));
  });

  /** Poll frames for the first one after `after` matching `pred`. */
  const waitFrame = (pred: (f: any) => boolean, what: string, after = 0, ms = 15_000) =>
    new Promise<any>((resolve, reject) => {
      const find = () => frames.findIndex((f, i) => i >= after && pred(f));
      const hit = find();
      if (hit >= 0) return resolve(frames[hit]);
      const timer = setTimeout(() => reject(new Error(`等待 ${what} 超时`)), ms);
      const iv = setInterval(() => {
        const i = find();
        if (i >= 0) {
          clearTimeout(timer);
          clearInterval(iv);
          resolve(frames[i]);
        }
      }, 20);
    });

  // ---------- ready frame = profile assembled = host i18n initialized ----------
  await waitFrame((f) => f.type === "ready", "ready 帧");
  assert(true, "收到 ready 帧（profile 装配完成，宿主 i18n 已按持久化 locale 初始化）");

  // ---------- assertion 1: zh default error message ----------
  let mark = frames.length;
  ws.send(JSON.stringify({ type: "set_setting", key: "__i18n_smoke_unknown__", value: 1 }));
  const err1 = await waitFrame(
    (f) => f.type === "error" && String(f.message).includes("未知设置项"),
    "zh 未知设置项 error 帧",
    mark,
  );
  assert(String(err1.message).includes("__i18n_smoke_unknown__"), `默认 zh：未知设置项 error 帧为中文文案（${err1.message}）`);

  // ---------- assertion 2: set_locale en switches host messages live ----------
  ws.send(JSON.stringify({ type: "set_locale", lang: "en" })); // fire-and-forget: no ack frame
  mark = frames.length;
  ws.send(JSON.stringify({ type: "set_setting", key: "__i18n_smoke_unknown__", value: 1 }));
  const err2 = await waitFrame(
    (f) => f.type === "error" && String(f.message).includes("Unknown setting key"),
    "en Unknown setting key error 帧",
    mark,
  );
  assert(String(err2.message).includes("__i18n_smoke_unknown__"), `set_locale en 后：未知设置项 error 帧为英文文案（${err2.message}）`);

  // ---------- assertion 3: locale persisted to the test profile ----------
  const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as { ui?: { locale?: unknown } };
  assert(persisted?.ui?.locale === "en", `omp-desktop.json ui.locale 已落盘为 "en"（实际 ${JSON.stringify(persisted?.ui)}）`);

  ws.close();
  console.log("全部断言通过（ui.locale=en 保留在测试 profile，宿主已杀干净）");
} catch (err) {
  console.error("✗ " + (err instanceof Error ? err.message : String(err)));
  exitCode = 1;
} finally {
  await killHost();
}
process.exit(exitCode);
