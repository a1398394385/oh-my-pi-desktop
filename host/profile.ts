// Profile / desktop env / desktop project list: config domains dynamically
// reloaded with activeProfile. applyProfile is the reload entry: clear the
// session pool, rebuild the base (authStorage/modelRegistry/settings), re-read
// env and the project list, refresh the model catalog.
import { setProfile, getAgentDir, normalizeProfileName } from "@oh-my-pi/pi-utils";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { H, DesktopEnv, DesktopProjects, defaultCwd, sessions } from "./state.ts";
import { Settings, ModelRegistry, discoverAuthStorage, saveProfileToDisk, initializeWithSettings, lookupSetting } from "./bootstrap.ts";
import { rebuildScopedModels } from "./models.ts";
import type { AcpNudgeConfig } from "./acp-state.ts";
import { readUiLocale } from "./ui-config.ts";
import { hostI18n, initHostI18n } from "../ui-src/i18n/host.ts";
import { settingsGet } from "./settings-compat.ts";

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
      allProjects: strs(raw.allProjects),
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
  // Read the on-disk object first, then overlay managed keys: user-written unmanaged sections (e.g. acp config) must survive untouched
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8"));
  } catch {}
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...base, ...H.desktopProjects }, null, 2));
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
    if (cwd.startsWith("/tmp") || cwd.startsWith("/private/tmp") || cwd.startsWith("/var/folders")) continue;
    if (H.desktopProjects.removedProjects.includes(cwd)) continue;
    if (!fs.existsSync(cwd)) continue;
    if (!H.desktopProjects.allProjects.includes(cwd)) {
      H.desktopProjects.allProjects.push(cwd);
      added = true;
    }
  }
  return added;
}

// ---------- sleep prevention (caffeinate, toggled by the power.sleepPrevention setting) ----------
let sleepProc: ReturnType<typeof Bun.spawn> | null = null;
export function applySleepPrevention(level: string) {
  try {
    sleepProc?.kill();
  } catch {}
  sleepProc = null;
  if (process.platform !== "darwin" || level === "off") return;
  const args = level === "system" ? ["-i", "-s"] : level === "display" ? ["-i", "-d"] : ["-i"];
  sleepProc = Bun.spawn(["caffeinate", ...args, "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
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
  process.stderr.write(`[host][启动计时] discoverAuthStorage: ${(performance.now() - t).toFixed(0)}ms (t=${t.toFixed(0)})\n`);
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
    H.availableModels = reg.getAvailable();
    rebuildScopedModels();
    process.stderr.write(`[host][启动计时] 模型目录后台刷新完成: +${(performance.now() - t).toFixed(0)}ms, 可用模型数 ${H.availableModels.length}\n`);
    H.onModelsRefreshed?.();
  });
  process.stderr.write(`[host][启动计时] modelRegistry 构造(缓存目录)+后台刷新启动: ${(performance.now() - t).toFixed(0)}ms (t=${t.toFixed(0)})\n`);
  t = performance.now();
  H.settings = await Settings.init({ cwd: defaultCwd, agentDir: H.agentDir });
  process.stderr.write(`[host][启动计时] Settings.init: ${(performance.now() - t).toFixed(0)}ms (t=${t.toFixed(0)})\n`);
  // Sync the capability discovery registry: disabledProviders/enabledProviders -> in-memory registry (same call as the CLI entry;
  // without it, third-party sources the user disabled still show up / count as enabled at the discovery layer)
  initializeWithSettings(H.settings);

  H.desktopEnvPath = path.join(H.agentDir, "desktop-env.json");
  H.desktopEnvFilePresent = fs.existsSync(H.desktopEnvPath);
  H.desktopEnv = H.desktopEnvFilePresent ? readDesktopEnv() : defaultDesktopEnv();
  if (H.desktopEnvFilePresent) applyDesktopEnv(H.desktopEnv);

  H.desktopProjectsPath = path.join(H.agentDir, "omp-desktop.json");
  H.desktopProjects = readDesktopProjects();
  // UI locale lives in the same per-profile omp-desktop.json: re-read on every
  // apply so the host language follows the active profile's persisted preference
  initHostI18n(readUiLocale());

  const sleepSetting = lookupSetting("power.sleepPrevention");
  const sleep = String(settingsGet(H.settings, "power.sleepPrevention") ?? "off");
  if (sleepSetting && H.settings.isConfigured(sleepSetting) && sleep !== "off") applySleepPrevention(sleep);
  else applySleepPrevention("off");

  H.availableModels = H.modelRegistry.getAvailable();
  rebuildScopedModels();
  H.modelOverride = process.env.OMP_DESKTOP_MODEL
    ? H.availableModels.find((m) => `${m.provider}/${m.id}` === process.env.OMP_DESKTOP_MODEL)
    : undefined;

  if (process.env.OMP_DESKTOP_MODEL && !H.modelOverride) {
    process.stderr.write(`[host] 模型覆盖失败：找不到 ${process.env.OMP_DESKTOP_MODEL}，回退默认选择\n`);
  }
  if (H.scopedModels.length === 0) {
    process.stderr.write("[host] 当前 profile 无可用模型（尚未配置 API Key 或 models.yml）\n");
  }

  await refreshAvailableProfiles();
  process.stderr.write(
    `[host] 已激活 Profile: ${target}, agentDir=${H.agentDir}, 可用模型数: ${H.availableModels.length} [t=${t0.toFixed(0)}ms→${performance.now().toFixed(0)}ms, 总耗时 ${(performance.now() - t0).toFixed(0)}ms]\n`,
  );
}

// ---------- experimental feature switches (acp / sessionContext sections of omp-desktop.json) ----------
// Moved over from main.ts: desktop-level config read/write lives in the same omp-desktop.json as the profile, so it belongs to this module.

/** Read the raw omp-desktop.json object (empty object on read failure). */
export function readAcpRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readAcpNudgeConfig(): AcpNudgeConfig {
  const fallback: AcpNudgeConfig = { maxContextLimit: 0.55, minContextLimit: 0.45 };
  const acp = readAcpRaw().acp as Record<string, unknown> | undefined;
  if (!acp || typeof acp !== "object") return fallback;
  const parse = (v: unknown, dflt: number): number => {
    if (typeof v === "number" && v > 0 && v <= 1) return v;
    if (typeof v === "string") {
      const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(v);
      if (m) return Number(m[1]) / 100;
    }
    return dflt;
  };
  return {
    maxContextLimit: parse(acp.maxContextLimit, 0.55),
    minContextLimit: parse(acp.minContextLimit, 0.45),
  };
}

/** Read the full ACP context compression config object. */
export function readAcpConfig(): {
  enabled: boolean;
  maxContextLimit: string;
  minContextLimit: string;
  contextWindow: string;
  candidates: boolean;
  protectUserMessages: boolean;
  systemPrompt: boolean;
} {
  const raw = readAcpRaw();
  const acp = (raw.acp && typeof raw.acp === "object" ? raw.acp : {}) as Record<string, unknown>;
  const fmtLimit = (v: unknown, dflt: string): string => {
    if (typeof v === "number" && v > 0 && v <= 1) return `${Math.round(v * 100)}%`;
    if (typeof v === "string" && v.trim()) return v.trim();
    return dflt;
  };
  return {
    enabled: acp.enabled !== false,
    maxContextLimit: fmtLimit(acp.maxContextLimit, "55%"),
    minContextLimit: fmtLimit(acp.minContextLimit, "45%"),
    contextWindow: typeof acp.contextWindow === "string" ? acp.contextWindow : (acp.contextWindow ? String(acp.contextWindow) : ""),
    candidates: acp.candidates === true,
    protectUserMessages: acp.protectUserMessages !== false,
    systemPrompt: acp.systemPrompt === true,
  };
}

/** ACP master switch (acp.enabled in omp-desktop.json). Missing/invalid
 *  values count as on, preserving pre-switch behavior — only an explicit
 *  false turns it off. */
export function readAcpEnabled(): boolean {
  const acp = readAcpRaw().acp as Record<string, unknown> | undefined;
  if (!acp || typeof acp !== "object") return true;
  return acp.enabled !== false;
}

/** Write acp.enabled back: read from disk first, then overlay, preserving omp-desktop.json's other keys and other fields inside the acp section. */
export async function writeAcpEnabled(enabled: boolean): Promise<void> {
  const raw = readAcpRaw();
  const acp = raw.acp && typeof raw.acp === "object" ? (raw.acp as Record<string, unknown>) : {};
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, acp: { ...acp, enabled } }, null, 2));
}

/** History session search (read_session_context) master switch (sessionContext.enabled in omp-desktop.json).
 *  Same semantics as readAcpEnabled: missing/invalid values count as on; only an explicit false turns it off. */
export function readSessionContextEnabled(): boolean {
  const section = readAcpRaw().sessionContext as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object") return true;
  return section.enabled !== false;
}

/** Write sessionContext.enabled back: read from disk first, then overlay, preserving omp-desktop.json's other keys and other fields inside the section. */
export async function writeSessionContextEnabled(enabled: boolean): Promise<void> {
  const raw = readAcpRaw();
  const section =
    raw.sessionContext && typeof raw.sessionContext === "object" ? (raw.sessionContext as Record<string, unknown>) : {};
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, sessionContext: { ...section, enabled } }, null, 2));
}

