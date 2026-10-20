// Plugin asset domain: installed plugin package listing per scope (profile /
// each desktop project), enabled toggles (hooks/plugins master switches,
// per-package lockfile / project overrides) and static content attribution.
// Split out of assets.ts; depends only on the path leaf (asset-paths.ts).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import { H } from "./state.ts";
import {
  clearPluginRootsAndCaches,
  resolveActiveProjectRegistryPath,
  resolvePluginManifestEntries,
} from "./bootstrap.ts";
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";
import { validDesktopProjects, nearestProjectOmpDir } from "./asset-paths.ts";

export interface PluginContentItem {
  name: string;
  description?: string;
}

/**
 * What a plugin package contributes, attributed with the same rules the base
 * applies at runtime: manifest-declared entries (tools/hooks/commands/extensions,
 * enabled features included) resolved through the base's own resolver, plus the
 * conventional sibling dirs the omp-plugins discovery provider scans inside an
 * extension package (skills/, commands/*.md, rules/, prompts/, hooks/{pre,post}/,
 * tools/, .mcp.json / mcp.json). Extension modules may inject further things at
 * runtime; the static groups here are what is visible from disk.
 */
export interface PluginContents {
  extensions: PluginContentItem[];
  tools: PluginContentItem[];
  commands: PluginContentItem[];
  skills: PluginContentItem[];
  rules: PluginContentItem[];
  prompts: PluginContentItem[];
  hooks: PluginContentItem[];
  mcp: PluginContentItem[];
}

export interface PluginAssetItem {
  name: string;
  /** node_modules package key (dir name, "@scope/name" for scoped) — toggle addressing */
  key?: string;
  version?: string;
  path?: string;
  scope?: "user" | "project";
  enabled?: boolean;
  description?: string;
  contents?: PluginContents;
}

export interface PluginAssetsPayload {
  /** Packages from the current profile's plugin root. */
  profile: PluginAssetItem[];
  /** One section per desktop project: that project's own plugin root only. */
  projects: { cwd: string; name: string; dir: string; plugins: PluginAssetItem[] }[];
  profileDir: string;
  profileName?: string;
}

/** Read hooks.enabled from omp-desktop.json (defaults to off). */
export function readHooksEnabled(): boolean {
  return readDesktopSection("hooks").enabled === true;
}

/** Write hooks.enabled back. */
export async function writeHooksEnabled(enabled: boolean): Promise<void> {
  // mkdir-first stays here: a fresh profile's agent dir may not exist yet and
  // the shared writer does not create parent directories.
  const dir = path.dirname(H.desktopProjectsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeDesktopSection("hooks", { ...readDesktopSection("hooks"), enabled });
}

/** Read plugins.enabled from omp-desktop.json (defaults to off). */
export function readPluginsEnabled(): boolean {
  return readDesktopSection("plugins").enabled === true;
}

/** Write plugins.enabled back. */
export async function writePluginsEnabled(enabled: boolean): Promise<void> {
  // Same mkdir-first reason as writeHooksEnabled.
  const dir = path.dirname(H.desktopProjectsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeDesktopSection("plugins", { ...readDesktopSection("plugins"), enabled });
}

// Installed plugin packages, listed per scope the same way skills/MCP are: each
// section enumerates ONLY that scope's own plugin root — the profile section the
// profile plugin root (getPluginsDir), each project section the root the base's
// registry lookup resolves for that cwd (nearest .omp, else .git anchor, never the
// user config root). Rows include disabled plugins so each one can carry its own
// toggle; per-base semantics a profile row is disabled via the root lockfile's
// plugins[pkg].enabled, a project row via <cwd>/.omp/plugin-overrides.json's
// disabled list (project overrides filter every root for sessions rooted there).
//
// The base's enabledPluginsCache (keyed by cwd+home) is process-global and nothing
// in the desktop app invalidates it, since no RPC here installs a plugin. Without an
// explicit clear first, a refresh would keep returning the first scan's snapshot for
// the host's lifetime.
export async function loadPluginsScoped(): Promise<PluginAssetsPayload> {
  clearPluginRootsAndCaches();
  const profileRoot = getPluginsDir();
  const profile = await listInstalledPluginRows(profileRoot, "user", await readLockfileDisabled(profileRoot));
  const projects = await Promise.all(
    validDesktopProjects().map(async (cwd) => {
      // The base's own resolution: null when the cwd has no project anchor — such a
      // section genuinely has no project-level plugin root, not even an empty dir
      const reg = await resolveActiveProjectRegistryPath(cwd).catch(() => null);
      const root = reg ? path.dirname(reg) : null;
      const plugins = root ? await listInstalledPluginRows(root, "project", await readProjectOverridesDisabled(cwd)) : [];
      return { cwd, name: path.basename(cwd), dir: root ?? nearestProjectOmpPluginsDir(cwd), plugins };
    }),
  );
  return {
    profile,
    projects,
    profileDir: profileRoot,
    profileName: H.currentProfile,
  };
}

// Enumerate a plugin root's installed packages straight from node_modules (mirroring
// the base loader's effective set: every listed row has a real package.json carrying
// an omp/pi manifest; stale lockfile/deps entries without one are invisible there too).
// Scoped packages (@scope/name) are traversed one level down, same as the base's
// path.join(root, "node_modules", name) lookups. Rows whose package name is in
// `disabled` stay visible with enabled: false.
async function listInstalledPluginRows(
  root: string,
  scope: "user" | "project",
  disabled: Set<string>,
): Promise<PluginAssetItem[]> {
  let entries: fs.Dirent[];
  try {
    entries = await readdir(path.join(root, "node_modules"), { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
    if (!e.name.startsWith("@")) {
      candidates.push(e.name);
      continue;
    }
    // scope dir (@scope): collect its package children one level down
    try {
      const kids = await readdir(path.join(root, "node_modules", e.name), { withFileTypes: true });
      for (const k of kids) if (k.isDirectory() || k.isSymbolicLink()) candidates.push(`${e.name}/${k.name}`);
    } catch {}
  }
  const rows = await Promise.all(
    candidates.map(async (pkg): Promise<PluginAssetItem | null> => {
      const pkgPath = path.join(root, "node_modules", pkg);
      let manifestPkg: {
        version?: string;
        omp?: PluginManifestLike;
        pi?: PluginManifestLike;
      };
      try {
        manifestPkg = JSON.parse(await readFile(path.join(pkgPath, "package.json"), "utf8"));
      } catch {
        return null; // unreadable / missing package.json — the base skips these too
      }
      const manifest = manifestPkg.omp || manifestPkg.pi;
      if (!manifest) return null; // not an omp plugin
      let realPath: string | undefined;
      try {
        realPath = await realpath(pkgPath); // marketplace installs symlink into node_modules; extension-center entry paths use the resolved root
      } catch {}
      return {
        name: manifest.name || pkg,
        key: pkg,
        version: manifestPkg.version,
        path: pkgPath,
        realPath,
        scope,
        enabled: !disabled.has(pkg),
        description: manifest.description,
        contents: await scanPluginContents(pkgPath, manifest),
      };
    }),
  );
  return rows
    .filter((r): r is PluginAssetItem => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The omp/pi manifest fields the attribution scan cares about (a structural subset
// of the base's PluginManifest — passed to the base resolver as-is)
interface PluginManifestLike {
  version?: string;
  name?: string;
  description?: string;
  tools?: string | string[];
  hooks?: string | string[];
  commands?: string | string[];
  extensions?: string[];
  features?: Record<string, { default?: boolean; tools?: string[]; hooks?: string[]; commands?: string[]; extensions?: string[] }>;
}

const PLUGIN_TOOL_EXTENSIONS: Record<string, true> = { json: true, md: true, ts: true, js: true, sh: true, bash: true, py: true };
const PLUGIN_RULE_EXTENSIONS: Record<string, true> = { md: true, mdc: true };

async function readDirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

// Frontmatter `description:` of a SKILL.md / tool .md (best effort, mirrors the base parser)
function markdownDescription(file: string): Promise<string | undefined> {
  return readFile(file, "utf8")
    .then((text) => {
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) return undefined;
      const m = fm[1].match(/^description:\s*(.+?)\s*$/m);
      return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
    })
    .catch(() => undefined);
}

// Attribute what a plugin package contributes (see PluginContents doc comment)
async function scanPluginContents(pkgPath: string, manifest: PluginManifestLike): Promise<PluginContents> {
  const contents: PluginContents = {
    extensions: [],
    tools: [],
    commands: [],
    skills: [],
    rules: [],
    prompts: [],
    hooks: [],
    mcp: [],
  };
  const seen: Record<keyof PluginContents, Set<string>> = {
    extensions: new Set(),
    tools: new Set(),
    commands: new Set(),
    skills: new Set(),
    rules: new Set(),
    prompts: new Set(),
    hooks: new Set(),
    mcp: new Set(),
  };
  const push = (kind: keyof PluginContents, item: PluginContentItem, dedupeKey?: string) => {
    const key = dedupeKey ?? item.name;
    if (seen[kind].has(key)) return;
    seen[kind].add(key);
    contents[kind].push(item);
  };

  // Manifest-declared entries, resolved by the base's own resolver (features included)
  const pluginArg = {
    name: path.basename(pkgPath),
    version: manifest.version ?? "",
    path: pkgPath,
    manifest,
    enabledFeatures: null,
    enabled: true,
  };
  const manifestEntries = async (key: "tools" | "hooks" | "commands" | "extensions") => {
    try {
      return await resolvePluginManifestEntries(pluginArg as Parameters<typeof resolvePluginManifestEntries>[0], key);
    } catch {
      return [] as { entry: string; resolvedPath: string | null }[];
    }
  };
  for (const { resolvedPath } of await manifestEntries("extensions")) {
    if (resolvedPath) push("extensions", { name: path.basename(resolvedPath) }, resolvedPath);
  }
  for (const { resolvedPath } of await manifestEntries("tools")) {
    if (resolvedPath) push("tools", { name: stripExt(path.basename(resolvedPath)) }, resolvedPath);
  }
  for (const { resolvedPath } of await manifestEntries("commands")) {
    if (resolvedPath) push("commands", { name: stripExt(path.basename(resolvedPath)) }, resolvedPath);
  }
  for (const { resolvedPath } of await manifestEntries("hooks")) {
    if (resolvedPath) push("hooks", { name: stripExt(path.basename(resolvedPath)) }, resolvedPath);
  }

  // skills/: one skill per <name>/SKILL.md dir (omp-plugins provider convention)
  for (const d of await readDirSafe(path.join(pkgPath, "skills"))) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const skillMd = path.join(pkgPath, "skills", d.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    push("skills", { name: d.name, description: await markdownDescription(skillMd) });
  }

  // commands/*.md and prompts/*.md: file name is the command/prompt name
  for (const f of await readDirSafe(path.join(pkgPath, "commands"))) {
    if (!f.isFile() || !f.name.endsWith(".md") || f.name.startsWith(".")) continue;
    push("commands", { name: f.name.slice(0, -".md".length) });
  }
  for (const f of await readDirSafe(path.join(pkgPath, "prompts"))) {
    if (!f.isFile() || !f.name.endsWith(".md") || f.name.startsWith(".")) continue;
    push("prompts", { name: f.name.slice(0, -".md".length) });
  }

  // rules/*.{md,mdc}
  for (const f of await readDirSafe(path.join(pkgPath, "rules"))) {
    const ext = path.extname(f.name).slice(1);
    if (!f.isFile() || !PLUGIN_RULE_EXTENSIONS[ext] || f.name.startsWith(".")) continue;
    push("rules", { name: stripExt(f.name) });
  }

  // hooks/{pre,post}/* — file base name is the hooked tool ("*" = wildcard)
  for (const phase of ["pre", "post"] as const) {
    for (const f of await readDirSafe(path.join(pkgPath, "hooks", phase))) {
      if (!f.isFile() || f.name.startsWith(".")) continue;
      push("hooks", { name: stripExt(f.name), description: phase });
    }
  }

  // tools/: flat tool files (json/md carry name/description inside) + <name>/index.ts subdirs
  const toolsDir = path.join(pkgPath, "tools");
  for (const f of await readDirSafe(toolsDir)) {
    if (f.isDirectory()) {
      if (!f.name.startsWith(".") && fs.existsSync(path.join(toolsDir, f.name, "index.ts"))) {
        push("tools", { name: f.name });
      }
      continue;
    }
    if (!f.isFile() || f.name.startsWith(".")) continue;
    const ext = path.extname(f.name).slice(1);
    if (!PLUGIN_TOOL_EXTENSIONS[ext]) continue;
    const file = path.join(toolsDir, f.name);
    if (ext === "json") {
      try {
        const data = JSON.parse(await readFile(file, "utf8")) as { name?: string; description?: string };
        push("tools", { name: typeof data.name === "string" && data.name ? data.name : stripExt(f.name), description: typeof data.description === "string" ? data.description : undefined });
        continue;
      } catch {}
    }
    if (ext === "md") {
      push("tools", { name: stripExt(f.name), description: await markdownDescription(file) });
      continue;
    }
    push("tools", { name: stripExt(f.name) });
  }

  // .mcp.json and mcp.json both feed the base's loader; same-named servers from the
  // first filename win here, mirroring capability first-wins dedupe
  for (const filename of [".mcp.json", "mcp.json"]) {
    try {
      const parsed = JSON.parse(await readFile(path.join(pkgPath, filename), "utf8")) as {
        mcpServers?: Record<string, { command?: unknown; url?: unknown }>;
      };
      for (const [serverName, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        if (!cfg || typeof cfg !== "object") continue;
        if (typeof cfg.command !== "string" && typeof cfg.url !== "string") continue;
        push("mcp", { name: serverName, description: typeof cfg.command === "string" ? cfg.command : cfg.url }, serverName);
      }
    } catch {}
  }

  return contents;
}

// Per-root disabled set from <root>/omp-plugins.lock.json's plugins[pkg].enabled
// (the base's global per-plugin switch for that root's packages)
async function readLockfileDisabled(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const cfg = JSON.parse(await readFile(path.join(root, "omp-plugins.lock.json"), "utf8")) as {
      plugins?: Record<string, { enabled?: unknown }>;
    };
    for (const [name, st] of Object.entries(cfg.plugins ?? {})) {
      if (st && typeof st === "object" && st.enabled === false) out.add(name);
    }
  } catch {}
  return out;
}

// Per-cwd disabled set from the first readable plugin-overrides.json (the base reads
// <cwd>/.omp then <cwd>/.pi; malformed files are ignored the same way)
async function readProjectOverridesDisabled(cwd: string): Promise<Set<string>> {
  for (const base of [".omp", ".pi"]) {
    try {
      const json = JSON.parse(await readFile(path.join(cwd, base, "plugin-overrides.json"), "utf8")) as {
        disabled?: unknown;
      };
      return new Set(Array.isArray(json.disabled) ? json.disabled.filter((x): x is string => typeof x === "string") : []);
    } catch {}
  }
  return new Set();
}

// Flip one row's enabled state at the exact place the base loader reads it:
// profile scope -> <getPluginsDir()>/omp-plugins.lock.json plugins[pkg].enabled;
// project scope -> <cwd>/.omp/plugin-overrides.json disabled list. Other keys in
// both files are preserved verbatim.
export async function setPluginEnabled(
  scope: "profile" | "project",
  cwd: string | undefined,
  pkg: string,
  enabled: boolean,
): Promise<void> {
  if (scope === "profile") {
    const root = getPluginsDir();
    await fs.promises.mkdir(root, { recursive: true });
    const lockPath = path.join(root, "omp-plugins.lock.json");
    let cfg: { plugins?: Record<string, unknown> } = {};
    try {
      cfg = JSON.parse(await readFile(lockPath, "utf8")) as { plugins?: Record<string, unknown> };
    } catch {}
    const plugins = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
    const prev = plugins[pkg] && typeof plugins[pkg] === "object" ? (plugins[pkg] as Record<string, unknown>) : {};
    plugins[pkg] = { ...prev, enabled };
    cfg.plugins = plugins;
    await writeFile(lockPath, JSON.stringify(cfg, null, 2));
    return;
  }
  const dir = path.join(path.resolve(String(cwd ?? "")), ".omp");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, "plugin-overrides.json");
  let cfg: { disabled?: unknown; [k: string]: unknown } = {};
  try {
    cfg = JSON.parse(await readFile(file, "utf8")) as { disabled?: unknown };
  } catch {}
  const disabled = new Set(
    Array.isArray(cfg.disabled) ? cfg.disabled.filter((x): x is string => typeof x === "string") : [],
  );
  if (enabled) disabled.delete(pkg);
  else disabled.add(pkg);
  cfg.disabled = Array.from(disabled);
  await writeFile(file, JSON.stringify(cfg, null, 2));
}

// Where a project's plugin packages live: the nearest project .omp above it, else
// <cwd>/.omp. The user config root (~/.omp) is NOT a project anchor — the base's
// registry lookup rejects it (isUserConfigRoot), so a project without its own .omp
// must not display the user plugin dir as if it were a project-scoped one.
function nearestProjectOmpPluginsDir(cwd: string): string {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  const userRoot = path.resolve(os.homedir());
  for (;;) {
    if (dir !== userRoot && fs.existsSync(path.join(dir, ".omp"))) return path.join(dir, ".omp", "plugins");
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return path.join(path.resolve(cwd), ".omp", "plugins");
}
