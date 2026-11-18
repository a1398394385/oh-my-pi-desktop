// Disk asset domain: skill discovery (through the base's own runtime loader, so the page
// shows exactly what a session loads), agent definitions, hooks, and the aggregate
// list_agent_assets entry. Path resolution lives in asset-paths.ts, MCP discovery in
// mcp-assets.ts, plugin packages in plugin-assets.ts.
import path from "node:path";
import { readdir } from "node:fs/promises";
import { H } from "./state.ts";
import { settingsGet } from "./settings-compat.ts";
import { loadCapability } from "./bootstrap.ts";
import { nearestProjectOmpDir, validDesktopProjects } from "./asset-paths.ts";
import { loadAllMcpScoped } from "./mcp-assets.ts";
import { DESKTOP_EXTENSION_EVENTS, loadPluginsScoped, readHooksEnabled, readPluginsEnabled } from "./plugin-assets.ts";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { loadSkills, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { SkillsSettings } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { AgentAssetsPayload } from "./wire/payloads.ts";

// Skills come from the base's own runtime loader (`extensibility/skills` loadSkills), not a
// local directory scan: the page then shows exactly what a session loads — same provider set,
// same ancestor walk (stops at the repo root, home is never a project), same shadowing order.
// The earlier hand-rolled scan (8 user dirs + 7 dirs per ancestor up to home) drifted from it
// in three ways: it crossed git worktree roots, it read providers that the base only reads at
// cwd, and it walked past a repo root into a parent checkout (BUG-025 had aligned only the
// source switches). Exclusion lists go in empty on purpose: the page must still list disabled
// skills to offer their toggles, so `enabled` is marked here instead of filtering.
/** One row of the skills page: the session-visible name plus the file it came from. */
interface SkillRow {
  name: string;
  description: string;
  path: string;
  dir: string;
  provider: string;
  level: string;
  scope: string;
  enabled: boolean;
}

export async function loadAllSkillsScoped() {
  const disabled = new Set<string>(((settingsGet(H.settings, "disabledExtensions") ?? []) as string[]));
  const ignored = new Set<string>(((settingsGet(H.settings, "skills.ignoredSkills") ?? []) as string[]));
  const isSkillDisabled = (name: string) => disabled.has(`skill:${name}`) || ignored.has(name);
  // `settingsGet` is typed unknown; the skills group is the registry's own shape.
  const skillsSettings = (settingsGet(H.settings, "skills") ?? {}) as SkillsSettings;

  const item = (skill: Skill, scope: string): SkillRow => {
    const [provider, level] = String(skill.source).split(":");
    return {
      name: skill.name,
      description: skill.description ?? "",
      path: skill.filePath,
      dir: skill.baseDir,
      provider: provider ?? "native",
      level: level ?? "user",
      scope,
      enabled: !isSkillDisabled(skill.name),
    };
  };
  const byName = (a: SkillRow, b: SkillRow) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const load = async (cwd: string, level: "user" | "project"): Promise<Skill[]> => {
    const res = await loadSkills({
      ...skillsSettings,
      cwd,
      // The page owns these: it lists excluded skills and shows the switch state.
      enabled: true,
      ignoredSkills: [],
      includeSkills: [],
      disabledExtensions: [],
    });
    return res.skills.filter((s) => String(s.source).endsWith(`:${level}`));
  };

  const profileItems = (await load(H.agentDir, "user")).map((s) => item(s, "profile")).sort(byName);

  const projects: { cwd: string; name: string; dir: string; skills: SkillRow[] }[] = [];
  for (const cwd of validDesktopProjects()) {
    const skills = (await load(cwd, "project")).map((s) => item(s, `project:${cwd}`)).sort(byName);
    // Write/open target stays the writable .omp root: the loader's read scope is wider than
    // where the page may create files.
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

// Lifecycle hook events: discovery only scans hooks/{pre,post}/ (upstream loader convention),
// so lifecycle hooks live in hooks/pre/<event>.ts and the basename names the event; scanHookDir
// applies the same rule in reverse to label rows. tool_call/tool_result stay phase-derived.
export const LIFECYCLE_EVENTS = ["turn_start", "turn_end", "agent_start", "agent_end", "session_stop", "session_shutdown"] as const;
export const HOOK_EVENTS = ["tool_call", "tool_result", ...LIFECYCLE_EVENTS] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields the base's hook capability reports that this page renders (capability/hook.ts). */
interface HookCapabilityItem {
  name: string;
  path: string;
  type: "pre" | "post";
  tool: string;
  level: "user" | "project";
}

export interface HookAssetItem {
  name: string;
  path: string;
  phase: "pre" | "post";
  event: HookEvent;
  tool: string;
  scope: "profile" | "project";
  cwd?: string;
  projectName?: string;
  enabled: boolean;
}

export async function listAgentAssets() {
  const memoriesDir = path.join(H.agentDir, "memories");
  // Agent definitions are returned in two scopes: current profile / each desktop project.
  // `bundled` are the agents compiled into the base package: no file on disk, so the page
  // shows them read-only and only toggles `task.disabledAgents`.
  type AssetListPayload = AgentAssetsPayload["agents"];
  const loadScopedAgents = async (): Promise<AssetListPayload> => {
    const disabledAgents = new Set<string>((settingsGet(H.settings, "task.disabledAgents") ?? []) as string[]);
    const payload: AssetListPayload = {
      global: [],
      profile: [],
      projects: [],
      bundled: loadBundledAgents().map((a) => ({ name: a.name, description: a.description, disabled: disabledAgents.has(a.name) })),
      profileDir: path.join(H.agentDir, "agents"),
      globalDir: path.join(H.agentDir, "agents"),
    };
    // Definitions come from the base's own task-agent discovery (`task/discovery`), the same
    // contract the task tool runs on: user dirs, the nearest project `.omp/agents`, and
    // extension-package agents. The page used to also accept `agents/<name>/AGENT.md`, which
    // the base never loads, so those rows could never spawn.
    const row = (a: AgentDefinition) => ({ name: a.name, path: a.filePath ?? "", description: a.description ?? "" });
    payload.profile = (await discoverAgents(H.agentDir)).agents.filter((a) => a.source === "user").map(row);
    for (const cwd of validDesktopProjects()) {
      const found = await discoverAgents(cwd);
      payload.projects.push({
        cwd,
        name: path.basename(cwd),
        dir: found.projectAgentsDir ?? path.join(path.resolve(cwd), ".omp", "agents"),
        agents: found.agents.filter((a) => a.source === "project").map(row),
      });
    }
    payload.global = payload.profile;
    payload.profileName = H.currentProfile;
    return payload;
  };
  const agents = await loadScopedAgents();
  const skills = await loadAllSkillsScoped();
  const mcp = await loadAllMcpScoped();

  const hooks: HookAssetItem[] = [];
  const disabled = new Set<string>((settingsGet(H.settings, "disabledExtensions") ?? []) as string[]);
  // Hooks come from the base's hook capability, so the page lists exactly the files a session
  // loads: the agent dir plus `cwd/.omp/hooks/{pre,post}` of the SAME cwd (no ancestor walk —
  // that was the old scan's drift), extension-package hooks included. The old scan also filtered
  // by HOOK_EXTS; the base loads any non-dot file, so the list does too.
  const hookItem = (h: HookCapabilityItem, scope: "profile" | "project", cwd?: string): HookAssetItem => {
    const name = path.basename(h.path);
    const baseName = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    const phase = h.type;
    const event: HookEvent = (LIFECYCLE_EVENTS as readonly string[]).includes(baseName)
      ? (baseName as HookEvent)
      : phase === "pre" ? "tool_call" : "tool_result";
    const extId = `hook:${phase}:${h.tool}:${name}`;
    const isOptOut = disabled.has(extId) || disabled.has(`hook:${phase}:${h.tool}:${baseName}`);
    return {
      name,
      path: h.path,
      phase,
      event,
      tool: h.tool,
      scope,
      cwd,
      projectName: cwd ? path.basename(cwd) : undefined,
      enabled: !isOptOut,
    };
  };

  const profileHooks = await loadCapability<HookCapabilityItem>("hooks", { cwd: H.agentDir });
  for (const h of profileHooks.items) if (h.level === "user") hooks.push(hookItem(h, "profile"));
  for (const cwd of validDesktopProjects()) {
    const projectHooks = await loadCapability<HookCapabilityItem>("hooks", { cwd });
    for (const h of projectHooks.items) if (h.level === "project") hooks.push(hookItem(h, "project", cwd));
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
  const plugins = await loadPluginsScoped();
  // Plugin event subscriptions are profile-scoped: project plugin roots feed sessions
  // rooted in that project, and the hooks page lists profile assets only.
  const pluginHooks = plugins.profile.flatMap((p) =>
    (p.contents?.hooks ?? [])
      .filter((h) => h.runtime)
      .map((h) => ({ plugin: p.name, event: h.name, active: DESKTOP_EXTENSION_EVENTS[h.name] === true })),
  );
  return {
    memories,
    skills,
    agents,
    hooks,
    pluginHooks,
    mcp,
    plugins,
    flags: { enableMCP: false, disableExtensionDiscovery: !(readPluginsEnabled() || readHooksEnabled()), computerEnabled: !!settingsGet(H.settings, "computer.enabled") },
  };
}
