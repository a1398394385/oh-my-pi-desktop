// Disk asset domain: skill scanning across three scopes (global ~/.omp,
// profile agentDir, each desktop project) plus the aggregate list_agent_assets
// entry. Path resolution lives in asset-paths.ts, MCP discovery in
// mcp-assets.ts, plugin packages in plugin-assets.ts.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostI18n } from "./i18n/host.ts";
import { H } from "./state.ts";
import { loadCapability } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";
import {
  agentFileDescription,
  assetRoots,
  HOOK_EXTS,
  isAssetSourceOn,
  nearestProjectOmpDir,
  validDesktopProjects,
} from "./asset-paths.ts";
import { loadAllMcpScoped } from "./mcp-assets.ts";
import { loadPluginsScoped, readHooksEnabled, readPluginsEnabled } from "./plugin-assets.ts";

async function listNamedDirs(dir: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

async function listNamedFiles(dir: string, ext: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(ext) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name.replace(new RegExp(ext.replace(".", "\\.") + "$"), ""), path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

// Recursively discover all SKILL.md files under a directory (supports nesting like research/blocked-page-recovery)
async function findSkillFiles(dir: string, maxDepth = 3): Promise<string[]> {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  async function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".omp") continue;
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        const full = path.join(current, e.name);
        if (e.isDirectory() || e.isSymbolicLink()) {
          const skillMd = path.join(full, "SKILL.md");
          if (fs.existsSync(skillMd)) result.push(skillMd);
          await walk(full, depth + 1);
        }
      }
    } catch {}
  }
  const rootSkill = path.join(dir, "SKILL.md");
  if (fs.existsSync(rootSkill)) result.push(rootSkill);
  await walk(dir, 1);
  return Array.from(new Set(result));
}

// Parse a single SKILL.md file into a skill entry
async function parseSkillFile(filePath: string, provider: string, scope: string, isSkillDisabled: (name: string) => boolean) {
  try {
    const text = await readFile(filePath, "utf8");
    let name = path.basename(path.dirname(filePath));
    let description = "";
    const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const n = fmMatch[1].match(/^name:\s*(.+)$/m);
      if (n) name = n[1].trim().replace(/^["\x27]|["\x27]$/g, "");
      const fmLines = fmMatch[1].split("\n");
      const dIdx = fmLines.findIndex((l) => l.startsWith("description:"));
      if (dIdx >= 0) {
        const inline = fmLines[dIdx].slice("description:".length).trim();
        if (/^[|>][+-]?$/.test(inline)) {
          // YAML block scalar (| literal / > folded): value is the more-indented lines below
          const parts: string[] = [];
          let indent = -1;
          for (let i = dIdx + 1; i < fmLines.length; i++) {
            const line = fmLines[i];
            if (!line.trim()) {
              parts.push("");
              continue;
            }
            const ind = line.match(/^\s*/)![0].length;
            if (ind === 0) break; // next top-level key
            if (indent < 0) indent = ind;
            parts.push(line.slice(Math.min(ind, indent)));
          }
          while (parts.length && !parts[parts.length - 1]) parts.pop();
          description = inline[0] === ">" ? parts.join(" ") : parts.join("\n");
        } else if (inline) {
          description = inline.replace(/^["\x27]|["\x27]$/g, "");
        }
      }
    }
    if (!description) {
      const hMatch = text.match(/^#+\s+(.+)$/m);
      if (hMatch) description = hMatch[1].trim();
      else {
        const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*/, "").trim();
        const firstLine = body.split("\n").find((l) => l.trim().length > 0);
        if (firstLine) description = firstLine.trim();
      }
    }
    return {
      name,
      description,
      path: filePath,
      dir: path.dirname(filePath),
      provider,
      scope,
      enabled: !isSkillDisabled(name),
    };
  } catch {
    return null;
  }
}

// Scan multi-source skills across global, profile and each project, following the omp source discovery logic
export async function loadAllSkillsScoped() {
  const disabled = new Set<string>(((settingsGet(H.settings, "disabledExtensions") ?? []) as string[]));
  const ignored = new Set<string>(((settingsGet(H.settings, "skills.ignoredSkills") ?? []) as string[]));
  const isSkillDisabled = (name: string) => disabled.has(`skill:${name}`) || ignored.has(name);

  // Profile-level directory sources (current profile skills, managed-skills, plus compatible external user-level directories)
  const profileSources = [
    { dir: path.join(H.agentDir, "skills"), provider: "native" },
    { dir: path.join(H.agentDir, "managed-skills"), provider: "omp-managed" },
    { dir: path.join(os.homedir(), ".agents", "skills"), provider: "agents" },
    { dir: path.join(os.homedir(), ".agent", "skills"), provider: "agents" },
    { dir: path.join(os.homedir(), ".claude", "skills"), provider: "claude" },
    { dir: path.join(os.homedir(), ".codex", "skills"), provider: "codex" },
    { dir: path.join(os.homedir(), ".config", "opencode", "skills"), provider: "opencode" },
    { dir: path.join(os.homedir(), ".opencode", "skills"), provider: "opencode" },
  ];
  try {
    const customDirs = (settingsGet(H.settings, "skills.customDirectories") ?? []) as string[];
    for (const cd of customDirs) {
      const exp = cd.startsWith("~/") ? path.join(os.homedir(), cd.slice(2)) : path.resolve(cd);
      profileSources.push({ dir: exp, provider: "custom" });
    }
  } catch {}

  const scanSources = async (sources: { dir: string; provider: string }[], scope: string, level: "user" | "project") => {
    const skillMap = new Map<string, any>();
    for (const src of sources) {
      if (!isAssetSourceOn(src.provider, level)) continue; // source off -> not listed
      const files = await findSkillFiles(src.dir);
      for (const f of files) {
        const item = await parseSkillFile(f, src.provider, scope, isSkillDisabled);
        if (item && !skillMap.has(item.name)) {
          skillMap.set(item.name, item);
        }
      }
    }
    return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  };

  const scannedProfile = await scanSources(profileSources, "profile", "user");
  const profileItemsMap = new Map<string, any>();
  for (const it of scannedProfile) profileItemsMap.set(it.name, it);

  // Base supplement (sources outside the hardcoded directories, e.g.
  // ~/.claude/plugins): includeDisabled is not passed so external user-level
  // directories stay gated by the "external tools ~/ config" opt-in, matching
  // runtime load behavior
  try {
    const capRes = await loadCapability<any>("skills", { cwd: H.agentDir });
    for (const s of capRes.all ?? []) {
      if ((s.level === "user" || s._source?.level === "user") && !profileItemsMap.has(s.name)) {
        const p = s.path || s._source?.path;
        if (p) {
          profileItemsMap.set(s.name, {
            name: s.name,
            description: s.frontmatter?.description || "",
            path: p,
            dir: path.dirname(p),
            provider: s._source?.provider || "native",
            scope: "profile",
            enabled: !isSkillDisabled(s.name),
          });
        }
      }
    }
  } catch {}
  const profileItems = Array.from(profileItemsMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const projects: { cwd: string; name: string; dir: string; skills: any[] }[] = [];
  for (const cwd of validDesktopProjects()) {
    const pSources: { dir: string; provider: string }[] = [];
    let cur = path.resolve(cwd);
    const root = path.parse(cur).root;
    while (cur && cur !== os.homedir() && cur !== root) {
      pSources.push(
        { dir: path.join(cur, ".omp", "skills"), provider: "native" },
        { dir: path.join(cur, ".agents", "skills"), provider: "agents" },
        { dir: path.join(cur, ".agent", "skills"), provider: "agents" },
        { dir: path.join(cur, ".claude", "skills"), provider: "claude" },
        { dir: path.join(cur, ".codex", "skills"), provider: "codex" },
        { dir: path.join(cur, ".opencode", "skills"), provider: "opencode" },
        { dir: path.join(cur, ".github", "skills"), provider: "github" },
      );
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const scannedProj = await scanSources(pSources, `project:${cwd}`, "project");
    const projItemsMap = new Map<string, any>();
    for (const it of scannedProj) projItemsMap.set(it.name, it);

    try {
      const pCapRes = await loadCapability<any>("skills", { cwd });
      for (const s of pCapRes.all ?? []) {
        if ((s.level === "project" || s._source?.level === "project") && !projItemsMap.has(s.name)) {
          const p = s.path || s._source?.path;
          if (p) {
            projItemsMap.set(s.name, {
              name: s.name,
              description: s.frontmatter?.description || "",
              path: p,
              dir: path.dirname(p),
              provider: s._source?.provider || "native",
              scope: `project:${cwd}`,
              enabled: !isSkillDisabled(s.name),
            });
          }
        }
      }
    } catch {}

    const skills = Array.from(projItemsMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const primaryDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp", "skills");
    projects.push({ cwd, name: path.basename(cwd), dir: primaryDir, skills });
  }

  return {
    global: profileItems, // backward compat
    profile: profileItems,
    projects,
    globalDir: path.join(H.agentDir, "skills"), // backward compat
    profileDir: path.join(H.agentDir, "skills"),
    profileName: H.currentProfile,
  };
}

export interface HookAssetItem {
  name: string;
  path: string;
  phase: "pre" | "post";
  tool: string;
  scope: "profile" | "project";
  cwd?: string;
  projectName?: string;
  enabled: boolean;
}

export async function listAgentAssets() {
  const memoriesDir = path.join(H.agentDir, "memories");
  // Agent definitions are returned in two scopes: current profile / each desktop project
  interface AssetListPayload {
    global?: any[];
    profile: any[];
    projects: { cwd: string; name: string; dir: string; agents?: any[] }[];
    globalDir?: string;
    profileDir: string;
    profileName?: string;
  }
  const loadScopedAgents = async (): Promise<AssetListPayload> => {
    const payload: AssetListPayload = {
      profile: [],
      projects: [],
      profileDir: path.join(H.agentDir, "agents"),
    };
    for (const r of assetRoots("agent")) {
      const items = [];
      for (const d of await listNamedDirs(r.dir)) items.push({ name: d.name, path: d.path, description: await agentFileDescription(path.join(d.path, "AGENT.md")) });
      for (const f of await listNamedFiles(r.dir, ".md")) items.push({ name: f.name, path: f.path, description: await agentFileDescription(f.path) });
      if (r.scope === "profile") payload.profile = items;
      else payload.projects.push({ cwd: r.cwd!, name: path.basename(r.cwd!), dir: r.dir, agents: items });
    }
    payload.global = payload.profile;
    payload.globalDir = payload.profileDir;
    payload.profileName = H.currentProfile;
    return payload;
  };
  const agents = await loadScopedAgents();
  const skills = await loadAllSkillsScoped();
  const mcp = await loadAllMcpScoped();

  const hooks: HookAssetItem[] = [];
  const disabled = new Set<string>((settingsGet(H.settings, "disabledExtensions") ?? []) as string[]);
  // HOOK_EXTS membership table (host/asset-paths.ts) is shared with resolveAssetFile

  const scanHookDir = async (dir: string, phase: "pre" | "post", scope: "profile" | "project", cwd?: string, projectName?: string) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        const ext = path.extname(e.name);
        if (!HOOK_EXTS[ext] && ext !== "") continue;
        const fullPath = path.join(dir, e.name);
        const baseName = e.name.includes(".") ? e.name.slice(0, e.name.lastIndexOf(".")) : e.name;
        const tool = baseName === "*" ? "*" : baseName;
        const extId = `hook:${phase}:${tool}:${e.name}`;
        const isOptOut = disabled.has(extId) || disabled.has(`hook:${phase}:${tool}:${baseName}`);
        hooks.push({
          name: e.name,
          path: fullPath,
          phase,
          tool,
          scope,
          cwd,
          projectName,
          enabled: !isOptOut,
        });
      }
    } catch {}
  };

  for (const phase of ["pre", "post"] as const) {
    await scanHookDir(path.join(H.agentDir, "hooks", phase), phase, "profile");
    for (const cwd of validDesktopProjects()) {
      const ompDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
      await scanHookDir(path.join(ompDir, "hooks", phase), phase, "project", cwd, path.basename(cwd));
    }
  }
  // Memory file names use omp's encodeProjectPath (strip cwd's leading slash,
  // replace / \ : with -, wrap both ends in --). The base creates the directory
  // through getMemoryRoot, which case-folds the cwd to lower case on win32
  // (#12596, memories/storage.ts normalizeScopeCwd) — fold the same way here or
  // the === lookup never matches the on-disk (lower-cased) name and the list
  // stays empty on Windows.
  const validProjects = validDesktopProjects();
  const encodeProjectPath = (cwd: string) =>
    `--${(process.platform === "win32" ? cwd.toLowerCase() : cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  let memories: { name: string; path: string; project?: string }[] = [];
  try {
    const entries = await readdir(memoriesDir, { withFileTypes: true });
    memories = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        const cwd = validProjects.find((c) => encodeProjectPath(c) === e.name);
        return { name: e.name, path: path.join(memoriesDir, e.name), project: cwd ? path.basename(cwd) : undefined };
      })
      .filter((m) => m.project !== undefined);
  } catch {}
  return {
    memories,
    skills,
    agents,
    hooks,
    mcp,
    plugins: await loadPluginsScoped(),
    flags: { enableMCP: false, disableExtensionDiscovery: !(readPluginsEnabled() || readHooksEnabled()), computerEnabled: !!settingsGet(H.settings, "computer.enabled") },
  };
}
