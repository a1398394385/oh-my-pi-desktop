// Editor / terminal / file-manager discovery and "open in external app".
// On macOS the open-with list comes from Launch Services (host-side port of ZCodium's
// file-open-apps/mac.ts + native.ts): NSWorkspace reports which installed apps can open the
// queried file, so Preview/Office/browsers appear without any allow-list. Windows keeps the
// static allow-list below — its Shell COM query (ZCodium windows.ts) is not ported yet.
// Ported from ZCodium's main-process editors.ts + openInEditor.ts (its tested implementation),
// with the Electron dependencies replaced by host-side equivalents:
//   nativeImage + @fiahfy/icns + app.getFileIcon → Info.plist (plutil) + a plain .icns PNG extractor
//   shell.openPath / shell.showItemInFolder           → `open` / `open -R` (darwin) and explorer.exe (win32)
//   child_process.execFile                            → Bun.spawn
// The SSH/WSL/Docker remote-URI branches were dropped: this app only ever opens local session paths.
// Windows discovery is a static allow-list filtered by existsSync — never by PATH — so the menu
// shows what is actually installed; the CLI is only a launch channel, with the bundle as fallback.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, win32 as pathWin32 } from "node:path";
import { hostI18n } from "./i18n/host.ts";
import { safeStderr } from "./stderr.ts";

export type EditorKind = "editor" | "terminal" | "fileManager";

interface EditorDef {
  id: string;
  name: string;
  kind: EditorKind;
  /** macOS .app bundle or Windows executable */
  appPath: string;
  appPathCandidates?: string[];
  /** Windows executable names reachable from a CLI shim's directory */
  windowsCommandAppNames?: string[];
  /** CLI command; null → launch the app bundle directly */
  command: string | null;
}

export interface EditorInfo {
  id: string;
  name: string;
  /** Absent for system file associations: their category is only known once opened */
  kind?: EditorKind;
  /** PNG data URL of the real app icon; absent when the icon cannot be resolved (UI falls back) */
  iconDataUrl?: string;
}

// Launch Services is the only source of truth for "which apps open this file": macOS cannot
// answer that from the filesystem or a fixed list. Same query as ZCodium's file-open-apps/mac.ts,
// run through osascript because the host process has no AppKit bridge.
const MAC_FILE_APPS_QUERY = `ObjC.import('AppKit');
function run(argv) {
  var ws = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var urls = ws.URLsForApplicationsToOpenURL(file);
  var defUrl = ws.URLForApplicationToOpenURL(file);
  var defPath = defUrl ? ObjC.unwrap(defUrl.URLByResolvingSymlinksInPath.path) : '';
  var out = [];
  for (var i = 0; i < urls.count; i++) {
    var u = urls.objectAtIndex(i);
    var bundle = $.NSBundle.bundleWithURL(u);
    var path = ObjC.unwrap(u.URLByResolvingSymlinksInPath.path);
    var name = bundle.objectForInfoDictionaryKey('CFBundleDisplayName') || bundle.objectForInfoDictionaryKey('CFBundleName');
    var version = bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
    var bundleId = bundle.bundleIdentifier;
    out.push({
      key: path,
      name: name ? ObjC.unwrap(name) : ObjC.unwrap(path.split('/').pop()).replace(/\\.app$/, ''),
      identity: bundleId ? 'darwin-bundle:' + ObjC.unwrap(bundleId).toLowerCase() : 'darwin-path:' + path,
      version: version ? ObjC.unwrap(version) : '',
      isDefault: path === defPath
    });
  }
  return JSON.stringify(out);
}`;

interface MacFileApp {
  key: string;
  name: string;
  identity: string;
  version: string;
  isDefault: boolean;
}

// Launch Services lists every registered copy of a bundle (profile caches, playwright chromium
// builds), so one app can arrive five times; identity + install location picks one deterministically.
function compareMacApps(left: MacFileApp, right: MacFileApp): number {
  // 0 = system install, 1 = an Applications folder (any volume), 2 = update/cache copies
  const rank = (key: string) =>
    /^\/(?:Applications|System\/Applications|System\/Library\/CoreServices)\//.test(key)
      ? 0
      : /\/Library\/Caches\/|\/Application Support\/|(\/|^)\.cache\//.test(key)
        ? 2
        : 1;
  return (
    Number(right.isDefault) - Number(left.isDefault) ||
    rank(left.key) - rank(right.key) ||
    right.version.localeCompare(left.version, "en", { numeric: true }) ||
    left.key.localeCompare(right.key, "en")
  );
}

function dedupeMacApps(apps: MacFileApp[]): MacFileApp[] {
  const byIdentity = new Map<string, MacFileApp>();
  for (const app of apps) {
    if (!app?.key || !app.name) continue;
    const previous = byIdentity.get(app.identity);
    if (!previous || compareMacApps(app, previous) < 0) byIdentity.set(app.identity, app);
  }
  return [...byIdentity.values()].sort(compareMacApps);
}

async function queryMacFileApps(target: string): Promise<MacFileApp[]> {
  const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", MAC_FILE_APPS_QUERY, target], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.trim() || `osascript exited ${code}`);
  return dedupeMacApps(JSON.parse(stdout) as MacFileApp[]);
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)));
}

function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`, "Programs");
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

// JetBrains installs into per-version directories (JetBrains/IntelliJ IDEA 2024.1/bin/idea64.exe),
// so the newest matching directory wins
function findWindowsJetBrainsExecutableCandidates(productDirPrefix: string, executableName: string): string[] {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  const candidates: string[] = [];
  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(productDirPrefix.toLowerCase()))
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a));
      for (const entry of entries) candidates.push(pathWin32.join(root, entry, "bin", executableName));
    } catch {
      // JetBrains products are optional; missing roots are expected
    }
  }
  return candidates;
}

function createWindowsEditorDef(
  id: string,
  name: string,
  kind: EditorKind,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    kind,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

function resolveWindowsCommandPaths(command: string): string[] {
  if (process.platform !== "win32") return [];
  try {
    const proc = Bun.spawnSync(["where.exe", command], { stdout: "pipe", stderr: "ignore" });
    return proc.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

// Windows PATH usually holds a bin\code.cmd shim; only the real exe can be launched directly
function deriveWindowsAppPathsFromCommand(command: string, appNames: string[]): string[] {
  const candidates: string[] = [];
  for (const commandPath of resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) candidates.push(pathWin32.join(appRoot, appName));
    }
  }
  return uniquePaths(candidates).filter((candidate) => existsSync(candidate));
}

const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

// The system file manager is part of the open-with list on every platform, so the
// "reveal in file manager" entry needs no separate code path in the UI
const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  { id: "explorer", name: "Explorer", kind: "fileManager", appPath: WINDOWS_EXPLORER_PATH, command: null },
  createWindowsEditorDef(
    "vscode",
    "VS Code",
    "editor",
    [windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"), ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe")],
    "code",
    ["Code.exe"],
  ),
  createWindowsEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    "editor",
    [
      windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    ],
    "code-insiders",
    ["Code - Insiders.exe"],
  ),
  createWindowsEditorDef(
    "cursor",
    "Cursor",
    "editor",
    [windowsLocalProgramCandidate("Cursor", "Cursor.exe"), ...windowsProgramFilesCandidates("Cursor", "Cursor.exe")],
    "cursor",
    ["Cursor.exe"],
  ),
  createWindowsEditorDef("trae", "Trae", "editor", [
    windowsLocalProgramCandidate("Trae", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
    ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
  ]),
  createWindowsEditorDef("idea", "IntelliJ IDEA", "editor", findWindowsJetBrainsExecutableCandidates("IntelliJ IDEA", "idea64.exe")),
  createWindowsEditorDef("webstorm", "WebStorm", "editor", findWindowsJetBrainsExecutableCandidates("WebStorm", "webstorm64.exe")),
  createWindowsEditorDef("pycharm", "PyCharm", "editor", findWindowsJetBrainsExecutableCandidates("PyCharm", "pycharm64.exe")),
  createWindowsEditorDef("goland", "GoLand", "editor", findWindowsJetBrainsExecutableCandidates("GoLand", "goland64.exe")),
  createWindowsEditorDef("clion", "CLion", "editor", findWindowsJetBrainsExecutableCandidates("CLion", "clion64.exe")),
];

// macOS has no allow-list any more: getFileOpenTargets queries Launch Services per file.
function getEditorDefsForCurrentPlatform(): EditorDef[] {
  return process.platform === "win32" ? WINDOWS_EDITOR_DEFS : [];
}

/** Resolve the actual install path: bundle candidates first, then paths derived from the CLI shim. */
export function resolveEditorDefAppPath(def: EditorDef): string | null {
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? resolveWindowsCommandPaths(def.command)
        : [];
  const candidates = uniquePaths([def.appPath, ...(def.appPathCandidates ?? []), ...commandAppPaths, ...commandPaths]);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// ---------- App icon (.app bundle → Info.plist → .icns → embedded PNG) ----------

const ICON_PNG_TYPES: Record<string, number> = {
  icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
  ic11: 32, ic12: 64, ic13: 128, ic14: 256,
};

// Minimal .icns reader: the container is [type][length] chunks and the modern icon types hold a
// complete PNG each, so the largest payload below 1024px can be handed out as a data URL directly.
function extractPngFromIcns(buffer: Buffer): Buffer | null {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "icns") return null;
  let best: { size: number; png: Buffer } | null = null;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("latin1", offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) break;
    const size = ICON_PNG_TYPES[type];
    const payload = buffer.subarray(offset + 8, offset + length);
    const isPng = payload.length > 8 && payload[0] === 0x89 && payload.toString("latin1", 1, 4) === "PNG";
    // Smaller payloads keep the frame small; 256px is still crisp on retina at menu size
    if (size && isPng && size <= 256 && (!best || size > best.size)) best = { size, png: payload };
    offset += length;
  }
  return best?.png ?? null;
}

function readInfoPlistIconNames(appPath: string): string[] {
  try {
    const proc = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return [];
    const plist = JSON.parse(proc.stdout.toString()) as {
      CFBundleIconFile?: string;
      CFBundleIconFiles?: string[];
      CFBundleIconName?: string;
      CFBundleIcons?: { CFBundlePrimaryIcon?: { CFBundleIconFiles?: string[]; CFBundleIconName?: string } };
    };
    return [
      plist.CFBundleIconFile,
      ...(plist.CFBundleIconFiles ?? []),
      ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
      plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
      plist.CFBundleIconName,
    ].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  } catch {
    return [];
  }
}

// Some bundles ship a resource directory named like the icon file, so only real files qualify
function resolveAppIconPath(appPath: string): string | null {
  for (const iconName of readInfoPlistIconNames(appPath)) {
    const fileNames = iconName.endsWith(".icns") ? [iconName] : [iconName, `${iconName}.icns`];
    for (const fileName of fileNames) {
      const candidate = join(appPath, "Contents", "Resources", fileName);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

const iconCache = new Map<string, string | null>();

function getAppIconDataUrl(appPath: string): string | null {
  const cached = iconCache.get(appPath);
  if (cached !== undefined) return cached;
  let dataUrl: string | null = null;
  if (process.platform === "darwin") {
    const iconPath = resolveAppIconPath(appPath);
    if (iconPath) {
      try {
        const png = extractPngFromIcns(readFileSync(iconPath));
        if (png) dataUrl = `data:image/png;base64,${png.toString("base64")}`;
      } catch (err) {
        safeStderr(`[host] editor icon read failed: ${String(err)}\n`);
      }
    }
  }
  iconCache.set(appPath, dataUrl);
  return dataUrl;
}

// ---------- Installed editors ----------

let cachedEditors: EditorInfo[] | null = null;

/** Windows allow-list (no per-file associations there yet), file managers pinned first. */
export async function getInstalledEditors(): Promise<EditorInfo[]> {
  if (cachedEditors) return cachedEditors;
  const installed = getEditorDefsForCurrentPlatform()
    .map((def) => ({ def, appPath: resolveEditorDefAppPath(def) }))
    .filter((entry): entry is { def: EditorDef; appPath: string } => entry.appPath !== null);
  const pinned = installed.filter(({ def }) => def.kind === "fileManager");
  const rest = installed.filter(({ def }) => def.kind !== "fileManager");
  cachedEditors = [...pinned, ...rest].map(({ def, appPath }) => {
    const iconDataUrl = getAppIconDataUrl(appPath);
    return { id: def.id, name: def.name, kind: def.kind, ...(iconDataUrl ? { iconDataUrl } : {}) };
  });
  return cachedEditors;
}

const SYS_APP_PREFIX = "sys:";

/**
 * Apps that can open this path, for the right-panel open-with menu.
 * macOS: Launch Services associations for the file, default handler first (ordering only — the UI
 * marks nothing, a check mark there would read as "currently selected"). Directories already come
 * back with Finder as a handler; plain files do not, and their reveal action lives in the menu.
 * Windows: the static allow-list.
 */
export async function getFileOpenTargets(target: string): Promise<EditorInfo[]> {
  if (process.platform !== "darwin") return getInstalledEditors();
  const apps = await queryMacFileApps(target).catch((err) => {
    safeStderr(`[host] file association query failed: ${String(err)}\n`);
    return [] as MacFileApp[];
  });
  return apps.map((app) => {
    const iconDataUrl = getAppIconDataUrl(app.key);
    return { id: `${SYS_APP_PREFIX}${app.key}`, name: app.name, ...(iconDataUrl ? { iconDataUrl } : {}) };
  });
}

// ---------- Open ----------

interface RunResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

async function run(cmd: string[], timeoutMs = 5000): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    return { ok: code === 0, code, stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, code: null, stderr: String(err) };
  }
}

async function launchApp(appPath: string, target: string): Promise<RunResult> {
  if (process.platform === "darwin") return run(["open", "-a", appPath, target]);
  return run([appPath, target]);
}

// explorer.exe hands the request to a running instance and still exits with code 1 (empty stderr);
// treat that shape as success only when the target is actually reachable (same test as ZCodium)
async function isDelegatedExplorerExit(result: RunResult, cmd: string[], target: string): Promise<boolean> {
  if (result.code !== 1 || result.stderr) return false;
  if (process.platform !== "win32" || !existsSync(target)) return false;
  return cmd.length > 0 && existsSync(cmd[0]);
}

/**
 * Open a path in one of the listed targets (right-panel file menu).
 * Throws on an unknown id, a missing path, or a failed launch — the RPC error frame toasts it.
 */
export async function openInEditor(editorId: string, target: string): Promise<void> {
  let isDir: boolean;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    throw new Error(hostI18n.t("errors.openWith.pathMissing", { path: target }));
  }

  // Launch Services entry (macOS): re-query the associations and match the id, so a caller can
  // neither run a command nor open an app the system does not offer for this file
  if (editorId.startsWith(SYS_APP_PREFIX)) {
    const appPath = editorId.slice(SYS_APP_PREFIX.length);
    const apps = await queryMacFileApps(target).catch(() => [] as MacFileApp[]);
    if (!apps.some((app) => app.key === appPath)) throw new Error(hostI18n.t("errors.openWith.unknownApp", { app: editorId }));
    const name = appPath.split("/").pop()?.replace(/\.app$/, "") || appPath;
    const result = await run(["open", "-a", appPath, "--", target]);
    if (result.ok) return;
    throw new Error(hostI18n.t("errors.openWith.launchFailed", { app: name, detail: result.stderr }));
  }

  // File managers: a single system reveal call, never a CLI ("finder" is the UI-facing id on every platform)
  if (editorId === "finder" || editorId === "explorer") {
    const win = process.platform === "win32";
    const cmd = win
      ? [WINDOWS_EXPLORER_PATH, ...(isDir ? [target] : [`/select,${target}`])]
      : ["open", ...(isDir ? [target] : ["-R", target])];
    const result = await run(cmd);
    if (result.ok || (win && (await isDelegatedExplorerExit(result, cmd, target)))) return;
    throw new Error(hostI18n.t("errors.openWith.launchFailed", { app: win ? "Explorer" : "Finder", detail: result.stderr }));
  }

  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) throw new Error(hostI18n.t("errors.openWith.unknownApp", { app: editorId }));
  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;

  // Editors/terminals: CLI first (the login-shell PATH is already merged in by gui-path.ts),
  // app bundle as fallback — the same two-stage launch as ZCodium
  if (def.command) {
    const cli = await run([def.command, target]);
    if (cli.ok) return;
    const fallback = await launchApp(appPath, target);
    if (fallback.ok) return;
    throw new Error(hostI18n.t("errors.openWith.launchFailed", { app: def.name, detail: fallback.stderr || cli.stderr }));
  }
  const launched = await launchApp(appPath, target);
  if (launched.ok) return;
  throw new Error(hostI18n.t("errors.openWith.launchFailed", { app: def.name, detail: launched.stderr }));
}
