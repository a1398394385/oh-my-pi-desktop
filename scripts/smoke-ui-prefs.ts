// UI-prefs smoke: the file-first persistence chain for desktop-owned settings.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-ui-prefs.ts
// Fails fast unless OMP_PROFILE points at a non-default profile — the smoke
// must never touch the user's default ~/.omp/agent.
// Asserts:
//   1. ready/settings frames carry a uiConfig read from omp-desktop.json
//      (empty prefs + no theme/motion when the ui section is absent)
//   2. set_ui_prefs merge-writes theme/motion/prefs and acks with a fresh
//      settings frame whose uiConfig reflects the landed values
//   3. invalid values are skipped (theme/motion enums, prefs types/ranges,
//      unknown keys) while other ui-section keys and file keys survive
//   4. set_locale still lands in uiConfig.locale (existing chain regression)
// Cleanup: omp-desktop.json is backed up before the host spawns and restored
// on every exit path (the host is killed first, so no exit hook rewrites it).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Narrowed view of the settings frame's uiConfig member (values compared literally; unknown keeps the boundary honest). */
interface UiCfgView {
  theme?: unknown;
  motion?: unknown;
  locale?: unknown;
  prefs?: Record<string, unknown>;
}

/** Loose frame shape: the smoke only reads type/settings members off the wire. */
interface SmokeFrame {
  type?: string;
  message?: unknown;
  settings?: { uiConfig?: UiCfgView } & Record<string, unknown>;
}

const profile = process.env.OMP_PROFILE?.trim();
if (!profile || profile === "default") {
  console.error("✗ 需要 OMP_PROFILE 指向非 default 的测试 profile（用法：OMP_PROFILE=omp-desktop-test bun scripts/smoke-ui-prefs.ts），严禁污染 default profile");
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;
const cfgDir = path.join(homedir(), ".omp", "profiles", profile, "agent");
const cfgPath = path.join(cfgDir, "omp-desktop.json");

mkdirSync(cfgDir, { recursive: true });
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;
// Known starting state: no ui section (both assertions and repeat runs rely on it)
if (cfgExisted) {
  try {
    const raw = JSON.parse(cfgBackup!) as Record<string, unknown>;
    delete raw.ui;
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  } catch {
    writeFileSync(cfgPath, "{}");
  }
}

let child: ChildProcess | null = null;

async function killHost(): Promise<void> {
  const dying = child;
  child = null;
  if (!dying?.pid) return;
  const exited = Promise.withResolvers<void>();
  dying.on("exit", () => exited.resolve());
  dying.kill("SIGTERM");
  await Promise.race([exited.promise, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (dying.pid) {
    try { dying.kill("SIGKILL"); } catch {}
  }
  await exited.promise;
}

async function cleanup(): Promise<void> {
  await killHost();
  if (cfgExisted) writeFileSync(cfgPath, cfgBackup!);
  else if (existsSync(cfgPath)) writeFileSync(cfgPath, "{}");
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
  console.log("✓ " + msg);
};

let exitCode = 0;
try {
  child = spawn("bun", ["host/host.ts"], {
    cwd: repoRoot,
    env: { ...process.env, OMP_PROFILE: profile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const wsReady = Promise.withResolvers<string>();
  const bootTimer = setTimeout(() => wsReady.reject(new Error("宿主 30s 未就绪")), 30_000);
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(bootTimer);
      child!.stdout!.off("data", onLine);
      wsReady.resolve(m[1]);
    }
  });
  const wsUrl = await wsReady.promise;
  console.log("宿主已就绪:", wsUrl);

  const ws = new WebSocket(wsUrl);
  const frames: SmokeFrame[] = [];
  ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)) as SmokeFrame);
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.reject(new Error("ws 连接失败"));
  await opened.promise;

  const waitFrame = (pred: (f: SmokeFrame) => boolean, what: string, after = 0, ms = 15_000) => {
    const found = Promise.withResolvers<SmokeFrame>();
    const find = () => frames.findIndex((f, i) => i >= after && pred(f));
    const hit = find();
    if (hit >= 0) found.resolve(frames[hit]);
    else {
      const timer = setTimeout(() => found.reject(new Error(`等待 ${what} 超时`)), ms);
      const iv = setInterval(() => {
        const i = find();
        if (i >= 0) {
          clearTimeout(timer);
          clearInterval(iv);
          found.resolve(frames[i]);
        }
      }, 20);
    }
    return found.promise;
  };

  // ---------- assertion 1: ready frame carries the (empty) ui-section projection ----------
  const ready = await waitFrame((f) => f.type === "ready", "ready 帧");
  const rc = ready.settings?.uiConfig;
  assert(rc !== undefined, "ready 帧 settings.uiConfig 存在");
  assert(!!rc.prefs && Object.keys(rc.prefs).length === 0, `空 ui 段投影 prefs 为空对象（实际 ${JSON.stringify(rc.prefs)}）`);
  assert(rc.theme === undefined && rc.motion === undefined && rc.locale === undefined, "空 ui 段投影 theme/motion/locale 均为 undefined");

  // ---------- assertion 2: set_ui_prefs lands + acks with a fresh settings frame ----------
  let mark = frames.length;
  ws.send(JSON.stringify({
    type: "set_ui_prefs",
    theme: "light",
    motion: "off",
    prefs: { uiFont: "pingfang", uiFontSize: 16, lineNumbers: false },
  }));
  const ack = await waitFrame((f) => f.type === "settings" && f.settings?.uiConfig?.theme === "light", "set_ui_prefs 的 settings 回执帧", mark);
  const ac = ack.settings!.uiConfig!;
  assert(ac.motion === "off", `回执 uiConfig.motion==="off"（实际 ${String(ac.motion)}）`);
  assert(ac.prefs?.uiFont === "pingfang" && ac.prefs?.uiFontSize === 16 && ac.prefs?.lineNumbers === false, `回执 uiConfig.prefs 落地（实际 ${JSON.stringify(ac.prefs)}）`);

  // ---------- assertion 3: invalid values are skipped, valid ones merge ----------
  mark = frames.length;
  ws.send(JSON.stringify({
    type: "set_ui_prefs",
    theme: "banana",
    motion: 42,
    prefs: { uiFontSize: 999, codeWrap: "yes", hackKey: "x", codeFontSize: 15 },
  }));
  const ack2 = await waitFrame((f) => f.type === "settings" && f.settings?.uiConfig?.prefs?.codeFontSize === 15, "非法混合值的 settings 回执帧", mark);
  const ac2 = ack2.settings!.uiConfig!;
  assert(ac2.theme === "light", `非法 theme 被跳过，保持 "light"（实际 ${String(ac2.theme)}）`);
  assert(ac2.motion === "off", `非法 motion 被跳过，保持 "off"（实际 ${String(ac2.motion)}）`);
  assert(ac2.prefs?.uiFontSize === 16, `越界 uiFontSize=999 被跳过，保持 16（实际 ${String(ac2.prefs?.uiFontSize)}）`);
  assert(ac2.prefs?.codeWrap === undefined, `类型不符 codeWrap="yes" 被跳过（实际 ${JSON.stringify(ac2.prefs?.codeWrap)}）`);
  assert(!ac2.prefs || !("hackKey" in ac2.prefs), "未知键 hackKey 被丢弃");

  // ---------- assertion 4: on-disk file holds the landed ui section ----------
  const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as { ui?: Record<string, unknown> };
  assert(onDisk.ui?.theme === "light" && onDisk.ui?.motion === "off", `文件 ui.theme/motion 落盘（实际 ${JSON.stringify(onDisk.ui)}）`);
  assert(onDisk.ui?.prefs?.uiFont === "pingfang" && onDisk.ui?.prefs?.codeFontSize === 15, "文件 ui.prefs 落盘且含两轮合并结果");

  // ---------- assertion 5: set_locale regression — locale shows up in uiConfig ----------
  mark = frames.length;
  ws.send(JSON.stringify({ type: "set_locale", lang: "en" }));
  ws.send(JSON.stringify({ type: "get_settings" }));
  await waitFrame((f) => f.type === "settings" && f.settings?.uiConfig?.locale === "en", "set_locale 后 uiConfig.locale===\"en\"", mark);
  assert(true, "set_locale 后 uiConfig.locale===\"en\"（既有链路回归）");

  ws.close();
  console.log("全部断言通过（omp-desktop.json 已还原，测试 host 已清理）");
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error("✗ 冒烟失败:", err);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
