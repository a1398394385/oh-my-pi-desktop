// Profile / desktop env / desktop project list: config domains dynamically
// reloaded with activeProfile. applyProfile is the reload entry: clear the
// session pool, rebuild the base (authStorage/modelRegistry/settings), re-read
// env and the project list, refresh the model catalog.
import { setProfile, getAgentDir, normalizeProfileName } from "@oh-my-pi/pi-utils";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { H, DesktopEnv, DesktopProjects, defaultCwd, defaultWorkspaceDir, ensureDefaultWorkspaceDir, sessions, activeWs } from "./state.ts";
import { Settings, ModelRegistry, discoverAuthStorage, saveProfileToDisk, initializeWithSettings, lookupSetting } from "./bootstrap.ts";
import { initVoiceMode } from "./voice.ts";
import { rebuildScopedModels, syncAvailableModels } from "./models.ts";
import { reloadAutomationScheduler, setAutomationNotify } from "./automations/scheduler.ts";
import { handleListSessions } from "./rpc/session.ts";
import { readUiLocale } from "./ui-config.ts";
import { applyExternalBrowserSetting, readExternalBrowserEnabled } from "./browser-config.ts";
import { reconcileComputerDisplay } from "./computer-display.ts";
import { warmKimiCu } from "./computer-mode.ts";
import { hostI18n, initHostI18n } from "./i18n/host.ts";
import { settingsGet } from "./settings-compat.ts";
import { readDesktopJson, readDesktopSection, writeDesktopSection, writeDesktopSections } from "./desktop-json.ts";
import type * as BunFfi from "bun:ffi";
import { safeStderr } from "./stderr.ts";

// ---------- desktop env (desktop-env.json under agentDir: proxy / CA certs) ----------
export function defaultDesktopEnv(): DesktopEnv {
  return { httpProxy: "", noProxy: "", caCerts: "" };
}

export function readDesktopEnv(): DesktopEnv {
  try {
    const raw = JSON.parse(fs.readFileSync(H.desktopEnvPath, "utf8"));
    return {
      httpProxy: typeof raw.httpProxy === "string" ? raw.httpProxy : "",
      noProxy: typeof raw.noProxy === "string" ? raw.noProxy : "",
      caCerts: typeof raw.caCerts === "string" ? raw.caCerts : "",
    };
  } catch {
    return defaultDesktopEnv();
  }
}

export function applyDesktopEnv(env: DesktopEnv) {
  if (env.httpProxy) {
    process.env.HTTP_PROXY = env.httpProxy;
    process.env.HTTPS_PROXY = env.httpProxy;
    process.env.http_proxy = env.httpProxy;
    process.env.https_proxy = env.httpProxy;
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  }
  if (env.noProxy) {
    process.env.NO_PROXY = env.noProxy;
    process.env.no_proxy = env.noProxy;
  } else {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  }
  if (env.caCerts) process.env.NODE_EXTRA_CA_CERTS = env.caCerts;
  else delete process.env.NODE_EXTRA_CA_CERTS;
}

// ---------- desktop project list (omp-desktop.json under the current profile config dir, absolute paths) ----------
export function readDesktopProjects(): DesktopProjects {
  try {
    const raw = JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8"));
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    const mcpSharing: Record<string, "session" | "project" | "global"> = {};
    if (raw.mcpSharing && typeof raw.mcpSharing === "object") {
      for (const [k, v] of Object.entries<any>(raw.mcpSharing)) {
        if (v === "session" || v === "project" || v === "global") {
          mcpSharing[k] = v;
        }
      }
    }
    return {
      // Strip the app-owned backing dir on read: an older build (or a hand-edited
      // manifest) may have recorded it as a project, and the sidebar's fixed row
      // is injected by the frontend instead — keeping it here would render twice.
      allProjects: strs(raw.allProjects).filter((c) => c !== defaultWorkspaceDir),
      removedProjects: strs(raw.removedProjects),
      expandedProjects: strs(raw.expandedProjects),
      pinnedSessions: strs(raw.pinnedSessions),
      archivedSessions: strs(raw.archivedSessions),
      mcpSharing,
    };
  } catch {
    return { allProjects: [], removedProjects: [], expandedProjects: [], pinnedSessions: [], archivedSessions: [], mcpSharing: {} };
  }
}

export async function saveDesktopProjects() {
  // Overlay only the managed top-level keys onto the on-disk object:
  // user-written unmanaged sections (e.g. acp config) must survive untouched.
  // The shared writer refuses to touch a present-but-unreadable file (A1).
  writeDesktopSections({ ...H.desktopProjects });
}

export function computeMcpSharingKey(sourcePath: string, name: string): string {
  return `${path.resolve(sourcePath)}::${name.trim()}`;
}

export function getMcpSharingConfig(sourcePath?: string, name?: string): "session" | "project" | "global" | undefined {
  if (!sourcePath || !name) return undefined;
  const key = computeMcpSharingKey(sourcePath, name);
  const val = H.desktopProjects?.mcpSharing?.[key];
  if (val === "session" || val === "project" || val === "global") return val;
  return undefined;
}

export async function setMcpSharingConfig(sourcePath: string, name: string, mode: "session" | "project" | "global" | null): Promise<void> {
  if (!H.desktopProjects.mcpSharing) H.desktopProjects.mcpSharing = {};
  const key = computeMcpSharingKey(sourcePath, name);
  if (!mode || mode === "session") {
    // Default/session level is not redundantly persisted (unrecorded means the session default, keeping the config lean)
    delete H.desktopProjects.mcpSharing[key];
  } else {
    H.desktopProjects.mcpSharing[key] = mode;
  }
  await saveDesktopProjects();
}

export async function deleteMcpSharingConfig(sourcePath?: string, name?: string): Promise<void> {
  if (!sourcePath || !name || !H.desktopProjects.mcpSharing) return;
  const key = computeMcpSharingKey(sourcePath, name);
  if (key in H.desktopProjects.mcpSharing) {
    delete H.desktopProjects.mcpSharing[key];
    await saveDesktopProjects();
  }
}

export async function migrateMcpSharingConfig(oldSourcePath: string, oldName: string, newSourcePath: string, newName: string): Promise<void> {
  const current = getMcpSharingConfig(oldSourcePath, oldName);
  if (current) {
    await deleteMcpSharingConfig(oldSourcePath, oldName);
    await setMcpSharingConfig(newSourcePath, newName, current);
  }
}

// Merge projects newly seen in history scans into the all-projects list (appended at the tail); returns whether anything was added.
// Strictly filtered: system temp dirs, root/home dir, nonexistent paths and already-removed projects are not merged.
export function mergeHistoryProjects(cwds: string[]): boolean {
  let added = false;
  const home = os.homedir();
  for (const cwd of cwds) {
    if (!cwd || typeof cwd !== "string") continue;
    if (cwd === "/" || cwd === home) continue;
    if (cwd === defaultWorkspaceDir) continue; // app-owned backing dir, not a registrable project
    if (isTempDirPath(cwd)) continue;
    if (H.desktopProjects.removedProjects.includes(cwd)) continue;
    if (!fs.existsSync(cwd)) continue;
    if (!H.desktopProjects.allProjects.includes(cwd)) {
      H.desktopProjects.allProjects.push(cwd);
      added = true;
    }
  }
  return added;
}

// ---------- sleep prevention (toggled by the power.sleepPrevention setting) ----------
// darwin: caffeinate helper bound to the host pid. win32: kernel32
// SetThreadExecutionState(ES_CONTINUOUS | flags) via bun:ffi — per-thread, and
// the host's JS thread persists for the process lifetime, so CONTINUOUS holds
// until reset. Both are released by applySleepPrevention("off").
const ES_CONTINUOUS = 0x8000_0000;
const ES_SYSTEM_REQUIRED = 0x0000_0001;
const ES_DISPLAY_REQUIRED = 0x0000_0002;
const WIN_SLEEP_FLAGS: Record<string, number> = {
  idle: ES_SYSTEM_REQUIRED,
  display: ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
  // Windows has no counterpart of caffeinate -s (system awake while the
  // display may sleep); SYSTEM_REQUIRED is the closest safe mapping.
  system: ES_SYSTEM_REQUIRED,
};
type WinSleepSetter = (flags: number) => unknown;
let winSleepSetter: WinSleepSetter | null | undefined;
function windowsSleepFlags(flags: number): void {
  if (winSleepSetter === undefined) {
    try {
      // Lazy require so non-Windows hosts never touch bun:ffi; a load failure
      // caches null (warn once, stay a no-op instead of throwing per toggle).
      const ffi = require("bun:ffi") as { dlopen: typeof BunFfi.dlopen };
      winSleepSetter = ffi.dlopen("kernel32.dll", {
        SetThreadExecutionState: { args: ["u32"], returns: "u32" },
      }).symbols.SetThreadExecutionState as WinSleepSetter;
    } catch (err) {
      winSleepSetter = null;
      safeStderr(`[host] sleep prevention unavailable (kernel32 load failed: ${err})\n`);
      return;
    }
  }
  try {
    winSleepSetter?.(flags);
  } catch (err) {
    safeStderr(`[host] sleep prevention failed (SetThreadExecutionState: ${err})\n`);
  }
}

let sleepProc: Bun.Subprocess | null = null;
export function applySleepPrevention(level: string) {
  try {
    sleepProc?.kill();
  } catch {}
  sleepProc = null;
  if (level === "off") {
    if (process.platform === "win32") windowsSleepFlags(ES_CONTINUOUS); // clear requirements, keep continuity semantics
    return;
  }
  if (process.platform === "win32") {
    const flags = WIN_SLEEP_FLAGS[level];
    if (flags === undefined) return;
    windowsSleepFlags(ES_CONTINUOUS | flags);
    return;
  }
  if (process.platform !== "darwin") return;
  const args = level === "system" ? ["-i", "-s"] : level === "display" ? ["-i", "-d"] : ["-i"];
  sleepProc = Bun.spawn(["caffeinate", ...args, "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
}

// True when cwd sits under the OS temp dir — keeps throwaway probe/smoke
// sessions out of the merged desktop project list. Covers macOS (/tmp,
// /private/tmp, /var/folders) and Windows/Linux via os.tmpdir() (case-folded
// on Windows, where drive-letter and profile casing vary).
function isTempDirPath(cwd: string): boolean {
  if (cwd.startsWith("/tmp") || cwd.startsWith("/private/tmp") || cwd.startsWith("/var/folders")) return true;
  const t = os.tmpdir();
  if (!t) return false;
  const fold = process.platform === "win32";
  const [a, b] = fold ? [cwd.toLowerCase(), t.toLowerCase()] : [cwd, t];
  return a.startsWith(b);
}

// ---------- Profile list and switching ----------
export async function refreshAvailableProfiles(): Promise<string[]> {
  const root = path.join(os.homedir(), ".omp", "profiles");
  const result: string[] = ["default"];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "default") {
        result.push(e.name);
      }
    }
  } catch {}
  if (!result.includes(H.currentProfile)) result.push(H.currentProfile);
  if (!result.includes("omp-desktop")) result.push("omp-desktop");
  H.cachedProfiles = Array.from(new Set(result)).sort((a, b) => {
    if (a === "omp-desktop") return -1;
    if (b === "omp-desktop") return 1;
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
  return H.cachedProfiles;
}

export async function applyProfile(profileName: string) {
  const t0 = performance.now();
  let target = "default";
  try {
    const norm = normalizeProfileName(profileName);
    target = norm || "default";
  } catch (e) {
    throw new Error(hostI18n.t("errors.invalidProfileName", { detail: String((e as any)?.message || e) }));
  }
  H.currentProfile = target;
  saveProfileToDisk(target);
  setProfile(target === "default" ? undefined : target);

  // Clear the existing session pool
  for (const [, entry] of sessions) {
    try {
      entry.unsubscribe?.();
    } catch {}
  }
  sessions.clear();

  H.agentDir = getAgentDir();
  // Startup segment timing (performance.now() zeroed at process start): locate the big cost centers before the ready frame
  let t = performance.now();
  H.authStorage = await discoverAuthStorage(H.agentDir);
  safeStderr(hostI18n.t("errors.startup.timingAuthStorage", { ms: (performance.now() - t).toFixed(0), t: t.toFixed(0) }));
  t = performance.now();
  H.modelRegistry = new ModelRegistry(H.authStorage);
  // Aligned with CLI startup semantics (refreshInBackground in main.ts): the
  // constructor already loads the on-disk cached catalog synchronously
  // (models.yml + SQLite snapshot); online discovery goes to the background
  // and does not block the ready frame (measured: a full await refresh takes
  // 4s, online catalog discovery being the bulk). After the refresh, re-take
  // the catalog and fire onModelsRefreshed so the host side pushes a models
  // frame.
  const reg = H.modelRegistry;
  reg.refreshInBackground();
  void reg.awaitBackgroundRefresh().then(() => {
    if (H.modelRegistry !== reg || !H.settings) return; // profile switched again during refresh, or the refresh landed before Settings.init finished (18.5.0's non-empty built-in catalog makes this reachable): drop the callback — applyProfile's own later rebuild covers it
    syncAvailableModels();
    rebuildScopedModels();
    safeStderr(hostI18n.t("errors.startup.timingCatalogRefreshed", { ms: (performance.now() - t).toFixed(0), models: H.availableModels.length }));
    H.onModelsRefreshed?.();
  });
  safeStderr(hostI18n.t("errors.startup.timingRegistry", { ms: (performance.now() - t).toFixed(0), t: t.toFixed(0) }));
  t = performance.now();
  H.settings = await Settings.init({ cwd: defaultCwd, agentDir: H.agentDir });
  safeStderr(hostI18n.t("errors.startup.timingSettingsInit", { ms: (performance.now() - t).toFixed(0), t: t.toFixed(0) }));
  // Sync the capability discovery registry: disabledProviders/enabledProviders -> in-memory registry (same call as the CLI entry;
  // without it, third-party sources the user disabled still show up / count as enabled at the discovery layer)
  initializeWithSettings(H.settings);

  // Base cache warming off, unconditionally: the desktop ships its own cache
  // keepalive (host/keepalive.ts, keepalive.enabled in omp-desktop.json), and
  // the two probing loops must never run at once in one process. Written to
  // the runtime override layer only — the user's config.yml keeps whatever
  // they chose there for the CLI (no global-layer write, no pollution).
  const cacheWarmingSetting = lookupSetting("providers.cacheWarming");
  if (cacheWarmingSetting) H.settings.writeValue(cacheWarmingSetting, "off", "override");

  H.desktopEnvPath = path.join(H.agentDir, "desktop-env.json");
  H.desktopEnvFilePresent = fs.existsSync(H.desktopEnvPath);
  H.desktopEnv = H.desktopEnvFilePresent ? readDesktopEnv() : defaultDesktopEnv();
  if (H.desktopEnvFilePresent) applyDesktopEnv(H.desktopEnv);

  H.desktopProjectsPath = path.join(H.agentDir, "omp-desktop.json");
  H.desktopProjects = readDesktopProjects();
  // The "work without a project" backing dir must exist before any agent is
  // spawned there (agents cannot run without a real cwd).
  ensureDefaultWorkspaceDir();
  // UI locale lives in the same per-profile omp-desktop.json: re-read on every
  // apply so the host language follows the active profile's persisted preference
  initHostI18n(readUiLocale());
  // Browser routing (omp-desktop.json's browser.external): off by default pins
  // relay/cdpUrl to "no external browser" on the override layer, so a browser
  // configured in the user's config.yml cannot outrank the desktop default.
  applyExternalBrowserSetting(readExternalBrowserEnabled());
  // Computer-use display: computer.display persists a Win32 monitor handle, so
  // a value that resolved before a reboot names nothing afterwards (the base
  // then rejects every capture). Re-point it at the same physical monitor on
  // every profile apply — i.e. before any session can read a dead value.
  void reconcileComputerDisplay().catch(err => safeStderr(hostI18n.t("errors.computerDisplay.reconcileFailed", { detail: String(err) })));
  // Computer-use Kimi provider: warm the builtin kimi-cu connection into the
  // shared pool when the provider pick says kimi (global pool is keyed by the
  // profile's agentDir, so every profile apply re-warms its own pool entry).
  warmKimiCu();

  const sleepSetting = lookupSetting("power.sleepPrevention");
  const sleep = String(settingsGet(H.settings, "power.sleepPrevention") ?? "off");
  if (sleepSetting && H.settings.isConfigured(sleepSetting) && sleep !== "off") applySleepPrevention(sleep);
  else applySleepPrevention("off");

  syncAvailableModels();
  rebuildScopedModels();
  // Voice runtimes (vocalizer model source + the STT controller) latch the
  // profile's settings/registry instances: rewire them to the new base
  initVoiceMode();

  H.modelOverride = process.env.OMP_DESKTOP_MODEL
    ? H.availableModels.find((m) => `${m.provider}/${m.id}` === process.env.OMP_DESKTOP_MODEL)
    : undefined;

  if (process.env.OMP_DESKTOP_MODEL && !H.modelOverride) {
    safeStderr(hostI18n.t("errors.profile.modelOverrideNotFound", { model: process.env.OMP_DESKTOP_MODEL }));
  }
  if (H.scopedModels.length === 0) {
    safeStderr(hostI18n.t("errors.profile.noModelsAvailable"));
  }

  await refreshAvailableProfiles();
  safeStderr(
    hostI18n.t("errors.startup.profileActivated", {
      profile: target,
      agentDir: H.agentDir,
      models: H.availableModels.length,
      t0: t0.toFixed(0),
      t1: performance.now().toFixed(0),
      total: (performance.now() - t0).toFixed(0),
    }),
  );

  // Automations state is per-profile (<agentDir>/automations.json, read fresh on
  // every store call through H.agentDir): arm the scheduler here — applyProfile
  // runs exactly once at boot (profileReady) and on every profile switch, so this
  // single hook covers both boot start and hot-switch re-arm. Run ledger write-backs
  // refresh the sidebar via the session_list push (the same pattern rpc/session
  // uses after list-mutating RPCs); the scheduler itself never imports rpc/.
  setAutomationNotify(() => {
    const ws = activeWs.value;
    if (ws) void handleListSessions(ws).catch(() => {});
  });
  reloadAutomationScheduler();
}

// ---------- experimental feature switches (acp / sessionContext sections of omp-desktop.json) ----------
// Moved over from main.ts: desktop-level config read/write lives in the same omp-desktop.json as the profile, so it belongs to this module.

/** Read the raw omp-desktop.json object. Read-side tolerance: a
 * present-but-unreadable/corrupt file reads as empty (only writes are gated
 * by the shared module's null refusal). */
export function readAcpRaw(): Record<string, unknown> {
  return readDesktopJson() ?? {};
}

/** Read the ACP config object for the experimental settings page: master
 * switch + tier ladder. l1/l2/l3 store token counts in absolute mode and
 * percentages of the session model's context window in percent mode
 * (converted host-side in acpParamsFromConfig). */
export function readAcpConfig(): {
  enabled: boolean;
  tierMode: "absolute" | "percent";
  l1?: number;
  l2?: number;
  l3?: number;
  tailTurns?: number;
  tailTokens?: number;
} {
  const acp = readDesktopSection("acp");
  const num = (v: unknown): number | undefined => (typeof v === "number" && v >= 0 ? v : undefined);
  return {
    enabled: acp.enabled === true,
    tierMode: acp.tierMode === "percent" ? "percent" : "absolute",
    l1: num(acp.l1),
    l2: num(acp.l2),
    l3: num(acp.l3),
    tailTurns: num(acp.tailTurns),
    tailTokens: num(acp.tailTokens),
  };
}

/** ACP master switch (acp.enabled in omp-desktop.json). Experimental
 *  feature: missing/invalid values count as off (new-user default) — only
 *  an explicit true turns it on. */
export function readAcpEnabled(): boolean {
  return readDesktopSection("acp").enabled === true;
}

/** Write acp.enabled back: read from disk first, then overlay, preserving omp-desktop.json's other keys and other fields inside the acp section. */
export async function writeAcpEnabled(enabled: boolean): Promise<void> {
  writeDesktopSection("acp", { ...readDesktopSection("acp"), enabled });
}

/** History session search (read_session_context) master switch (sessionContext.enabled in omp-desktop.json).
 *  Same semantics as readAcpEnabled: missing/invalid values count as off (new-user default); only an explicit true turns it on. */
export function readSessionContextEnabled(): boolean {
  return readDesktopSection("sessionContext").enabled === true;
}

/** Write sessionContext.enabled back: read from disk first, then overlay, preserving omp-desktop.json's other keys and other fields inside the section. */
export async function writeSessionContextEnabled(enabled: boolean): Promise<void> {
  writeDesktopSection("sessionContext", { ...readDesktopSection("sessionContext"), enabled });
}

