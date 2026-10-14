// Editor / terminal / file-manager discovery and "open in external app".
// Ported from ZCodium's main-process editors.ts + openInEditor.ts (its tested implementation),
// with the Electron dependencies replaced by host-side equivalents:
//   nativeImage + @fiahfy/icns + app.getFileIcon → Info.plist (plutil) + a plain .icns PNG extractor
//   shell.openPath / shell.showItemInFolder           → `open` / `open -R` (darwin) and explorer.exe (win32)
//   child_process.execFile                            → Bun.spawn
// The SSH/WSL/Docker remote-URI branches were dropped: this app only ever opens local session paths.
// Discovery is a static allow-list filtered by existsSync — never by PATH — so the menu shows what
// is actually installed; the CLI is only a launch channel, with the app bundle as fallback.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, win32 as pathWin32 } from "node:path";
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
  kind: EditorKind;
  /** PNG data URL of the real app icon; absent when the icon cannot be resolved (UI falls back) */
  iconDataUrl?: string;
}

const MAC_EDITOR_DEFS: EditorDef[] = [
  // Code editors
  { id: "vscode", name: "VS Code", kind: "editor", appPath: "/Applications/Visual Studio Code.app", command: "code" },
  // Insiders is a separate bundle, so it needs its own entry to be discovered and opened
  { id: "vscode-insiders", name: "VS Code Insiders", kind: "editor", appPath: "/Applications/Visual Studio Code - Insiders.app", command: "code-insiders" },
  { id: "cursor", name: "Cursor", kind: "editor", appPath: "/Applications/Cursor.app", command: "cursor" },
  { id: "trae", name: "Trae", kind: "editor", appPath: "/Applications/Trae.app", command: null },
  { id: "zed", name: "Zed", kind: "editor", appPath: "/Applications/Zed.app", command: "zed" },
  { id: "sublime", name: "Sublime Text", kind: "editor", appPath: "/Applications/Sublime Text.app", command: "subl" },
  { id: "codebuddy", name: "CodeBuddy", kind: "editor", appPath: "/Applications/CodeBuddy.app", command: null },
  { id: "qoder", name: "Qoder", kind: "editor", appPath: "/Applications/Qoder.app", command: null },
  // JetBrains
  { id: "idea", name: "IntelliJ IDEA", kind: "editor", appPath: "/Applications/IntelliJ IDEA.app", command: "idea" },
  { id: "idea-ce", name: "IntelliJ IDEA CE", kind: "editor", appPath: "/Applications/IntelliJ IDEA CE.app", command: "idea" },
  { id: "webstorm", name: "WebStorm", kind: "editor", appPath: "/Applications/WebStorm.app", command: "webstorm" },
  { id: "pycharm", name: "PyCharm", kind: "editor", appPath: "/Applications/PyCharm.app", command: "pycharm" },
  { id: "goland", name: "GoLand", kind: "editor", appPath: "/Applications/GoLand.app", command: "goland" },
  { id: "phpstorm", name: "PhpStorm", kind: "editor", appPath: "/Applications/PhpStorm.app", command: "phpstorm" },
  { id: "rider", name: "Rider", kind: "editor", appPath: "/Applications/Rider.app", command: "rider" },
  { id: "clion", name: "CLion", kind: "editor", appPath: "/Applications/CLion.app", command: "clion" },
  { id: "rubymine", name: "RubyMine", kind: "editor", appPath: "/Applications/RubyMine.app", command: "rubymine" },
  { id: "datagrip", name: "DataGrip", kind: "editor", appPath: "/Applications/DataGrip.app", command: "datagrip" },
  // Terminals (recent macOS keeps Terminal.app under /System/Applications)
  { id: "terminal", name: "Terminal", kind: "terminal", appPath: "/System/Applications/Utilities/Terminal.app", command: null },
  { id: "iterm2", name: "iTerm", kind: "terminal", appPath: "/Applications/iTerm.app", command: null },
  { id: "ghostty", name: "Ghostty", kind: "terminal", appPath: "/Applications/Ghostty.app", command: null },
  { id: "warp", name: "Warp", kind: "terminal", appPath: "/Applications/Warp.app", command: null },
  // File managers
  { id: "finder", name: "Finder", kind: "fileManager", appPath: "/System/Library/CoreServices/Finder.app", command: null },
  // Third-party file managers have no CLI: opened through the app bundle like the terminals
  { id: "qspace", name: "QSpace", kind: "fileManager", appPath: "/Applications/QSpace.app", command: null },
  { id: "qspace-pro", name: "QSpace Pro", kind: "fileManager", appPath: "/Applications/QSpace Pro.app", command: null },
];

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

function getEditorDefsForCurrentPlatform(): EditorDef[] {
  if (process.platform === "darwin") return MAC_EDITOR_DEFS;
  if (process.platform === "win32") return WINDOWS_EDITOR_DEFS;
  return [];
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

/** Installed editors/terminals/file managers, file managers pinned first (list order is menu order). */
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
 * Open a path in one of the discovered apps (right-panel file menu).
 * Throws on an unknown editor id, a missing path, or a failed launch — the RPC error frame toasts it.
 */
export async function openInEditor(editorId: string, target: string): Promise<void> {
  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) throw new Error(hostI18n.t("errors.openWith.unknownApp", { app: editorId }));
  let isDir: boolean;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    throw new Error(hostI18n.t("errors.openWith.pathMissing", { path: target }));
  }
  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;

  // File managers: a single system reveal call, never a CLI
  if (def.id === "finder") {
    const result = await run(isDir ? ["open", target] : ["open", "-R", target]);
    if (result.ok) return;
    throw new Error(hostI18n.t("errors.openWith.launchFailed", { app: def.name, detail: result.stderr }));
  }
  if (def.id === "explorer") {
    const cmd = isDir ? [appPath, target] : [appPath, `/select,${target}`];
    const result = await run(cmd);
    if (result.ok || (await isDelegatedExplorerExit(result, cmd, target))) return;
    throw new Error(hostI18n.t("errors.openWith.launchFailed", { app: def.name, detail: result.stderr }));
  }

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
