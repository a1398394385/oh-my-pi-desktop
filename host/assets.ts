// Disk asset domain: scan, read, health-probe and aggregate agent definitions /
// skills / MCP configs across three scopes (global ~/.omp, profile agentDir,
// each desktop project). listAgentAssets is the aggregate entry behind the
// list_agent_assets command.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { hostI18n } from "../ui-src/i18n/host.ts";
import { H } from "./state.ts";
import {
  loadCapability,
  clearCapabilityFsCache,
  connectToServer,
  disconnectServer,
  readDisabledServers,
  readEnabledServers,
  isProviderEnabled,
  isUserSourceEnabled,
} from "./bootstrap.ts";
import { getMcpSharingConfig } from "./profile.ts";
import { settingsGet } from "./settings-compat.ts";

async function firstHeading(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    const m = text.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// Agent definition description: prefer the YAML frontmatter description, fall back to the H1 heading
async function agentFileDescription(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const m = fm[1].match(/^description:\s*(.+?)\s*$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
    const h = text.match(/^#\s+(.+)$/m);
    if (h) return h[1].trim();
  } catch {}
  return "";
}

// omp discovery rule: walk upward from the project directory to find the nearest .omp config directory
export function nearestProjectOmpDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  for (;;) {
    const cand = path.join(dir, ".omp");
    if (fs.existsSync(cand)) return cand;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

// Read-write roots for disk assets (agent definitions / skills / MCP configs):
// the current profile's agentDir/<sub>, plus the nearest .omp/<sub> above each
// valid desktop project
export type AssetKind = "agent" | "skill" | "mcp" | "hook";

// Hook script extensions accepted by the hooks list scan (listAgentAssets) and
// resolveAssetFile. Only .ts/.js are actually imported by the base extension
// loader; the rest are listed for visibility and editing of existing files.
export const HOOK_EXTS: Record<string, true> = { ".ts": true, ".js": true, ".mjs": true, ".cjs": true, ".sh": true, ".bash": true, ".py": true };

export interface AssetRoot { dir: string; scope: string; cwd?: string }

// Only desktop projects registered in omp-desktop.json and not removed
export function validDesktopProjects(): string[] {
  const removed = new Set(H.desktopProjects.removedProjects);
  return H.desktopProjects.allProjects.filter((c) => !removed.has(c));
}

export function assetRoots(kind: AssetKind): AssetRoot[] {
  const sub = kind === "agent" ? "agents" : "skills";
  const roots: AssetRoot[] = [
    { dir: path.join(H.agentDir, sub), scope: "profile" },
  ];
  for (const cwd of validDesktopProjects()) {
    const ompDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    roots.push({ dir: path.join(ompDir, sub), scope: "project", cwd });
  }
  return roots;
}

// omp config directory for a given scope (the directory holding mcp.json)
export function assetOmpDir(kind: AssetKind, scope: unknown, cwd?: unknown): string {
  const s = String(scope ?? "profile");
  if (s === "profile" || s === "global") return H.agentDir;
  if (s === "project") {
    const c = String(cwd ?? "");
    if (!validDesktopProjects().includes(c)) throw new Error(hostI18n.t("errors.asset.unknownProject", { c }));
    return nearestProjectOmpDir(c) ?? path.join(path.resolve(c), ".omp");
  }
  throw new Error(hostI18n.t("errors.asset.unknownScope", { s }));
}

// mcp.json candidate files (dotted one read with priority, unprefixed one is the primary write target)
export function mcpCandidates(dir: string): string[] {
  return [path.join(dir, "mcp.json"), path.join(dir, ".mcp.json")];
}

// Writable hook roots: profile agentDir/hooks + each valid project's nearest .omp/hooks
// (mirrors the scanHookDir paths in listAgentAssets)
function hookDirRoots(): string[] {
  const roots = [path.join(H.agentDir, "hooks")];
  for (const cwd of validDesktopProjects()) {
    roots.push(path.join(nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp"), "hooks"));
  }
  return roots;
}

// External source switch resolution (mirrors base discovery load conditions;
// once a source is switched off its assets no longer appear in the list):
// - Source master switch: extensions page "Sources" -> base disabledProviders
// - User-level external tool directory opt-in: extensions page "External tools ~/ config" -> base enabledProviders
// - claude / codex user-level directories additionally honor skill-level
//   compatibility switches (base skills.enableClaudeUser / enableCodexUser)
// Project-level directories are not gated by the opt-in, only by the source
// master switch (same as the base isUserSourceEnabled comment).
function isAssetSourceOn(provider: string, level: "user" | "project"): boolean {
  if (!isProviderEnabled(provider)) return false;
  if (level === "project") return true;
  if (isUserSourceEnabled(provider)) return true;
  if (provider === "claude") return settingsGet(H.settings, "skills.enableClaudeUser") === true;
  if (provider === "codex") return settingsGet(H.settings, "skills.enableCodexUser") === true;
  return false;
}

// All valid skill roots (global OMP/Agents/Claude/Codex/OpenCode, profile, and project levels)
function allSkillRoots(): string[] {
  const roots: string[] = [
    path.join(os.homedir(), ".omp", "agent", "skills"),
    path.join(os.homedir(), ".omp", "agent", "managed-skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".config", "opencode", "skills"),
    path.join(os.homedir(), ".opencode", "skills"),
    path.join(H.agentDir, "skills"),
    path.join(H.agentDir, "managed-skills"),
  ];
  try {
    const customDirs = (settingsGet(H.settings, "skills.customDirectories") ?? []) as string[];
    for (const cd of customDirs) {
      const exp = cd.startsWith("~/") ? path.join(os.homedir(), cd.slice(2)) : path.resolve(cd);
      roots.push(exp);
    }
  } catch {}
  for (const cwd of validDesktopProjects()) {
    let cur = path.resolve(cwd);
    const root = path.parse(cur).root;
    while (cur && cur !== os.homedir() && cur !== root) {
      roots.push(
        path.join(cur, ".omp", "skills"),
        path.join(cur, ".agents", "skills"),
        path.join(cur, ".agent", "skills"),
        path.join(cur, ".claude", "skills"),
        path.join(cur, ".codex", "skills"),
        path.join(cur, ".opencode", "skills"),
        path.join(cur, ".github", "skills"),
      );
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return roots;
}

// Paths from the frontend must fall inside the allowed roots; directory-style definitions are normalized to their entry file (AGENT.md/SKILL.md)
export function resolveAssetFile(kind: AssetKind, p: unknown): string {
  const raw = String(p ?? "");
  let file = path.resolve(raw);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, kind === "skill" ? "SKILL.md" : "AGENT.md");
  if (kind === "mcp") {
    if (file.endsWith(".json") || file.endsWith(".toml")) {
      return file;
    }
    throw new Error(hostI18n.t("errors.asset.jsonTomlOnly", { raw }));
  }
  if (kind === "hook") {
    if (!HOOK_EXTS[path.extname(file)]) throw new Error(hostI18n.t("errors.asset.hookExtOnly", { raw }));
    const ok = hookDirRoots().some((root) => {
      const rel = path.relative(root, file);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!ok) throw new Error(hostI18n.t("errors.asset.dirForbidden", { kind, raw }));
    return file;
  }
  if (!file.endsWith(".md")) throw new Error(hostI18n.t("errors.asset.mdOnly", { kind: kind === "skill" ? "skill" : "agent" }));
  if (kind === "skill") {
    const ok = allSkillRoots().some((root) => {
      const rel = path.relative(root, file);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!ok) throw new Error(hostI18n.t("errors.asset.skillDirForbidden", { raw }));
    return file;
  }
  const ok = assetRoots(kind).some((root) => {
    const rel = path.relative(root.dir, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!ok) throw new Error(hostI18n.t("errors.asset.dirForbidden", { kind, raw }));
  return file;
}

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
      const d = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (d) description = d[1].trim().replace(/^["\x27]|["\x27]$/g, "");
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
    { dir: path.join(H.agentDir, "managed-skills"), provider: "managed-skills" },
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

// MCP health probe cache (avoids re-connecting within 60s). This used to live
// inside the listAgentAssets function body, which left server-layer
// set_mcp_server_enabled / test_mcp_server references dangling (TS2304) —
// hoisted to module level during the split.
export const mcpHealthCache = new Map<
  string,
  { status: "connected" | "error"; error?: string; log?: string; timestamp: number }
>();

async function probeStdioMcp(server: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}, timeoutMs = 5000): Promise<{ status: "connected" | "error"; error?: string; log?: string }> {
  const cmd = server.command?.trim();
  if (!cmd) {
    return {
      status: "error",
      error: hostI18n.t("flows.mcp.noCommand"),
      log: hostI18n.t("flows.mcp.noCommandLog"),
    };
  }
  const fullCmd = [cmd, ...(server.args ?? [])];
  const cwd = server.cwd && fs.existsSync(server.cwd) ? server.cwd : process.cwd();
  const env = { ...process.env, ...(server.env ?? {}) };

  let proc: any;
  try {
    proc = (Bun as any).spawn(fullCmd, {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: any) {
    const detail = err?.stack || err?.message || String(err);
    const errorMsg = hostI18n.t("flows.mcp.spawnFailed", { message: err?.message || String(err) });
    const log =
      hostI18n.t("flows.mcp.logCommand", { command: fullCmd.join(" ") }) +
      "\n" +
      hostI18n.t("flows.mcp.logCwd", { cwd }) +
      "\n" +
      hostI18n.t("flows.mcp.spawnFailLog", { detail });
    return { status: "error", error: errorMsg, log };
  }

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];

  const readStderr = async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {}
  };
  const stderrPromise = readStderr();

  const readStdout = async (): Promise<boolean> => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          stdoutChunks.push(line);
          try {
            const parsed = JSON.parse(line);
            if (parsed && (parsed.id === 1 || parsed.result)) {
              return true;
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  };
  const stdoutPromise = readStdout();

  try {
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-desktop-probe", version: "1.0.0" },
      },
    }) + "\n";
    proc.stdin.write(new TextEncoder().encode(initMsg));
    await proc.stdin.flush();
  } catch {}

  let success = false;
  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([
    stdoutPromise.then((ok) => { if (ok) success = true; }),
    proc.exited.then(() => {}),
    timeoutPromise,
  ]);

  try {
    if (success) {
      try {
        const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
        proc.stdin.write(new TextEncoder().encode(notif));
        await proc.stdin.flush();
      } catch {}
    }
    proc.kill();
  } catch {}

  if (!timedOut) {
    try { await proc.exited; } catch {}
  }

  await Promise.race([stderrPromise, new Promise((r) => setTimeout(r, 200))]);

  const stderrText = stderrChunks.join("").trim();
  const stdoutText = stdoutChunks.join("\n").trim();
  const exitCode = proc.exitCode;

  if (success) {
    return { status: "connected" };
  }

  let summary = "";
  if (timedOut) {
    summary = hostI18n.t("flows.mcp.timedOut", { sec: timeoutMs / 1000 });
  } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    summary = hostI18n.t("flows.mcp.abnormalExit", { code: exitCode });
  } else if (stderrText) {
    summary = stderrText.split("\n")[0].slice(0, 120) || hostI18n.t("flows.mcp.outputAbnormal");
  } else {
    summary = hostI18n.t("flows.mcp.noJsonrpc");
  }

  const logLines = [
    hostI18n.t("flows.mcp.logCommand", { command: fullCmd.join(" ") }),
    hostI18n.t("flows.mcp.logCwd", { cwd }),
    hostI18n.t("flows.mcp.logExitCode", {
      code: exitCode ?? (timedOut ? hostI18n.t("flows.mcp.exitRunning") : hostI18n.t("flows.mcp.exitUnknown")),
    }),
  ];
  if (stderrText) {
    logLines.push(hostI18n.t("flows.mcp.logStderr", { text: stderrText }));
  }
  if (stdoutText) {
    logLines.push(hostI18n.t("flows.mcp.logStdout", { text: stdoutText }));
  }
  if (!stderrText && !stdoutText) {
    logLines.push(hostI18n.t("flows.mcp.logNoOutput", { ms: timeoutMs }));
  }

  return {
    status: "error",
    error: summary,
    log: logLines.join("\n"),
  };
}

export async function probeMcpServerHealth(server: {
  name: string;
  transport?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ status: "connected" | "error"; error?: string; log?: string }> {
  const cached = mcpHealthCache.get(server.name);
  if (cached && Date.now() - cached.timestamp < 60_000) {
    return { status: cached.status, error: cached.error, log: cached.log };
  }

  const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");

  if (transport === "stdio") {
    const res = await probeStdioMcp(server);
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  }

  const config: any = {
    type: transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    cwd: server.cwd,
  };
  try {
    const conn = await Promise.race([
      connectToServer(`probe_${Date.now()}_${server.name}`, config),
      // Structured timeout marker: matched by MCP_TIMEOUT below, never by
      // display text — the branch must survive language switches.
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("MCP_TIMEOUT")), 5000)
      ),
    ]);
    await disconnectServer(conn);
    const res = { status: "connected" as const };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  } catch (err: any) {
    let msg = err?.message || String(err);
    if (msg.includes("protocol") || msg.includes("version") || msg.includes("negotiation") || msg.includes("UnsupportedProtocolVersion")) {
      msg = hostI18n.t("flows.mcp.protocolFail");
    } else if (msg.includes("ECONNREFUSED")) {
      msg = hostI18n.t("flows.mcp.connRefused");
    } else if (msg.includes("MCP_TIMEOUT")) {
      msg = hostI18n.t("flows.mcp.connTimedOut");
    }
    const detail = err?.stack || err?.message || String(err);
    const log =
      hostI18n.t("flows.mcp.logUrl", { url: server.url || hostI18n.t("flows.mcp.urlUnknown") }) +
      "\n" +
      hostI18n.t("flows.mcp.logTransport", { transport }) +
      "\n" +
      hostI18n.t("flows.mcp.logReason", { reason: msg }) +
      "\n" +
      hostI18n.t("flows.mcp.logDetail", { detail });
    const res = { status: "error" as const, error: msg, log };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  }
}

export interface McpServerAsset {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  source: {
    provider: string;
    providerName: string;
    path: string;
    level: "user" | "project" | "native";
  };
  scope: string; // "profile" | `project:${cwd}`
  projectName?: string;
  status: "connected" | "error" | "disabled" | "unknown";
  error?: string;
  log?: string;
  sharing?: "session" | "project" | "global";
}

// Discover and merge all MCP servers across global, profile and each workspace project, following the omp source mcps capability
export async function loadAllMcpScoped(options?: { probe?: boolean }) {
  clearCapabilityFsCache();
  const userMcpPath = path.join(H.agentDir, "mcp.json");
  const [disabledList, forcedList] = await Promise.all([
    readDisabledServers(userMcpPath).catch(() => [] as string[]),
    readEnabledServers(userMcpPath).catch(() => [] as string[]),
  ]);
  const disabledSet = new Set(disabledList);
  const forcedSet = new Set(forcedList);

  const isServerEnabled = (name: string, rawEnabled?: boolean) => {
    if (disabledSet.has(name)) return false;
    if (rawEnabled === false && !forcedSet.has(name)) return false;
    return true;
  };


  const allServersMap = new Map<string, McpServerAsset>();
  const rawFileCache = new Map<string, any>();
  const readRawSharing = async (filePath?: string, serverName?: string): Promise<"session" | "project" | "global" | undefined> => {
    if (!filePath || !serverName) return undefined;
    const desktopSharing = getMcpSharingConfig(filePath, serverName);
    if (desktopSharing) return desktopSharing;
    try {
      let doc = rawFileCache.get(filePath);
      if (!doc) {
        if (fs.existsSync(filePath)) {
          doc = JSON.parse(await readFile(filePath, "utf8"));
          rawFileCache.set(filePath, doc);
        }
      }
      const raw = doc?.mcpServers?.[serverName]?.sharing;
      if (raw === "session" || raw === "project" || raw === "global") return raw;
      return undefined;
    } catch {
      return undefined;
    }
  };

  const serverKey = (scope: string, name: string) => `${scope}::${name}`;

  // 1. User-level discovery (current profile plus global external sources such
  //    as ~/.claude.json, ~/.cursor/mcp.json, ~/.codex/config.toml).
  //    includeDisabled is not passed: external user-level sources stay gated by
  //    the "sources" and "external tools ~/ config" switches (same as base runtime loading)
  try {
    const userRes = await loadCapability<any>("mcps", { cwd: H.agentDir });
    for (const s of userRes.items) {
      const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
      const enabled = isServerEnabled(s.name, s.enabled);
      const filePath = s._source?.path ?? userMcpPath;
      const fileSharing = await readRawSharing(filePath, s.name);
      const rawSharing = fileSharing ?? s.sharing ?? (s as any)._config?.sharing;
      const sharing: "session" | "project" | "global" =
        (rawSharing === "global" || rawSharing === "project") ? rawSharing : "session";
      allServersMap.set(serverKey("profile", s.name), {
        name: s.name,
        transport,
        command: s.command,
        args: s.args,
        url: s.url,
        headers: s.headers,
        env: s.env,
        cwd: s.cwd,
        enabled,
        sharing,
        source: {
          provider: s._source?.provider ?? "native",
          providerName: s._source?.providerName ?? "OMP",
          path: filePath,
          level: s._source?.level ?? "user",
        },
        scope: "profile",
        status: enabled ? "unknown" : "disabled",
      });
    }
  } catch (err) {
    process.stderr.write(`[host] MCP 用户级发现失败: ${err}\n`);
  }

  // Read the current profile's mcp.json directly so freshly saved config and the sharing field stay 100% in sync
  if (fs.existsSync(userMcpPath)) {
    try {
      const rawUserDoc = JSON.parse(await readFile(userMcpPath, "utf8"));
      for (const [name, cfg] of Object.entries<any>(rawUserDoc.mcpServers || {})) {
        const transport = (cfg.type ?? (cfg.command ? "stdio" : cfg.url ? "http" : "stdio")) as "stdio" | "http" | "sse";
        const enabled = isServerEnabled(name, cfg.enabled);
        const rawSharing = getMcpSharingConfig(userMcpPath, name) ?? cfg.sharing;
        const sharing: "session" | "project" | "global" =
          (rawSharing === "global" || rawSharing === "project") ? rawSharing : "session";
        const uKey = serverKey("profile", name);
        const existing = allServersMap.get(uKey);
        if (existing) {
          existing.command = cfg.command ?? existing.command;
          existing.args = cfg.args ?? existing.args;
          existing.url = cfg.url ?? existing.url;
          existing.headers = cfg.headers ?? existing.headers;
          existing.env = cfg.env ?? existing.env;
          existing.cwd = cfg.cwd ?? existing.cwd;
          existing.sharing = sharing;
          existing.transport = transport;
        } else {
          allServersMap.set(uKey, {
            name,
            transport,
            command: cfg.command,
            args: cfg.args,
            url: cfg.url,
            headers: cfg.headers,
            env: cfg.env,
            cwd: cfg.cwd,
            enabled,
            sharing,
            source: {
              provider: "native",
              providerName: "OMP",
              path: userMcpPath,
              level: "user",
            },
            scope: "profile",
            status: enabled ? "unknown" : "disabled",
          });
        }
      }
    } catch {}
  }

  // 2. Project workspace discovery (each project opened in the desktop app)
  const projectScopeList: { cwd: string; name: string; dir: string; count: number }[] = [];
  for (const cwd of validDesktopProjects()) {
    let count = 0;
    const primaryOmpDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    const projMcpFile = path.join(primaryOmpDir, "mcp.json");
    const projScope = `project:${cwd}`;

    try {
      const projRes = await loadCapability<any>("mcps", { cwd });
      for (const s of projRes.items) {
        // base loadCapability cascades user-level capabilities back; only handle MCP entries owned by the current project
        if (s._source?.level !== "project") continue;
        const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
        const enabled = isServerEnabled(s.name, s.enabled);
        const filePath = s._source?.path ?? projMcpFile;
        const fileSharing = await readRawSharing(filePath, s.name);
        const rawSharing = fileSharing ?? s.sharing ?? (s as any)._config?.sharing;
        const sharing: "session" | "project" | "global" =
          rawSharing === "project" ? "project" : "session"; // rule 2: global forbidden inside a project; rule 1: default session
        const item: McpServerAsset = {
          name: s.name,
          transport,
          command: s.command,
          args: s.args,
          url: s.url,
          headers: s.headers,
          env: s.env,
          cwd: s.cwd ?? cwd,
          enabled,
          sharing,
          source: {
            provider: s._source?.provider ?? "native",
            providerName: s._source?.providerName ?? hostI18n.t("flows.mcp.projectConfig"),
            path: filePath,
            level: "project",
          },
          scope: projScope,
          projectName: path.basename(cwd),
          status: enabled ? "unknown" : "disabled",
        };
        allServersMap.set(serverKey(projScope, s.name), item);
        count++;
      }
    } catch (err) {
      process.stderr.write(`[host] MCP 项目级发现失败 (${cwd}): ${err}\n`);
    }

    // Read the project .omp/mcp.json directly so project-level additions and sharing sync 100%
    if (fs.existsSync(projMcpFile)) {
      try {
        const rawProjDoc = JSON.parse(await readFile(projMcpFile, "utf8"));
        for (const [name, cfg] of Object.entries<any>(rawProjDoc.mcpServers || {})) {
          const transport = (cfg.type ?? (cfg.command ? "stdio" : cfg.url ? "http" : "stdio")) as "stdio" | "http" | "sse";
          const enabled = isServerEnabled(name, cfg.enabled);
          const rawSharing = getMcpSharingConfig(projMcpFile, name) ?? cfg.sharing;
          const sharing: "session" | "project" | "global" =
            rawSharing === "project" ? "project" : "session";
          const pKey = serverKey(projScope, name);
          const existing = allServersMap.get(pKey);
          if (existing) {
            existing.command = cfg.command ?? existing.command;
            existing.args = cfg.args ?? existing.args;
            existing.url = cfg.url ?? existing.url;
            existing.headers = cfg.headers ?? existing.headers;
            existing.env = cfg.env ?? existing.env;
            existing.cwd = cfg.cwd ?? existing.cwd ?? cwd;
            existing.sharing = sharing;
            existing.transport = transport;
          } else {
            allServersMap.set(pKey, {
              name,
              transport,
              command: cfg.command,
              args: cfg.args,
              url: cfg.url,
              headers: cfg.headers,
              env: cfg.env,
              cwd: cfg.cwd ?? cwd,
              enabled,
              sharing,
              source: {
                provider: "native",
                providerName: hostI18n.t("flows.mcp.projectConfig"),
                path: projMcpFile,
                level: "project",
              },
              scope: projScope,
              projectName: path.basename(cwd),
              status: enabled ? "unknown" : "disabled",
            });
            count++;
          }
        }
      } catch {}
    }

    // Extra compatibility with e.g. etower-agent's config/mcp-servers.json
    const etowerFile = path.join(cwd, "config", "mcp-servers.json");
    if (fs.existsSync(etowerFile)) {
      try {
        const raw = JSON.parse(await readFile(etowerFile, "utf8"));
        for (const [name, cfg] of Object.entries<any>(raw.mcpServers || raw)) {
          const eKey = serverKey(projScope, name);
          if (!allServersMap.has(eKey)) {
            const transport = (cfg.url ? "http" : "stdio") as "stdio" | "http";
            const enabled = isServerEnabled(name, cfg.enabled);
            const sharing: "session" | "project" | "global" =
              cfg.sharing === "project" ? "project" : "session";
            allServersMap.set(eKey, {
              name,
              transport,
              command: cfg.command,
              args: cfg.args,
              url: cfg.url,
              headers: cfg.headers,
              env: cfg.env,
              cwd,
              enabled,
              sharing,
              source: {
                provider: "etower",
                providerName: hostI18n.t("flows.mcp.projectConfig"),
                path: etowerFile,
                level: "project",
              },
              scope: projScope,
              projectName: path.basename(cwd),
              status: enabled ? "unknown" : "disabled",
            });
            count++;
          }
        }
      } catch {}
    }
    projectScopeList.push({ cwd, name: path.basename(cwd), dir: primaryOmpDir, count });
  }

  const serverList = Array.from(allServersMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  // 3. Concurrent health checks (fast probes against enabled servers, 2s timeout).
  // Skipped on the session-mount path ({ probe: false }): mounting must not pay
  // the per-server connect budget — status stays "unknown" there.
  if (options?.probe !== false) {
    const enabledServers = serverList.filter((s) => s.enabled);
    await Promise.all(
      enabledServers.map(async (s) => {
        const probe = await probeMcpServerHealth(s);
        if (probe) {
          s.status = probe.status;
          s.error = probe.error;
          s.log = probe.log;
        } else {
          s.status = "connected";
        }
      })
    );
  }

  for (const s of serverList) {
    if (!s.enabled) {
      s.status = "disabled";
      s.error = undefined;
      s.log = undefined;
    }
  }

  // Legacy asset fields for backward compatibility
  const mcpProfile = {
    path: userMcpPath,
    servers: serverList.filter((s) => s.scope === "profile").map((s) => ({
      name: s.name,
      command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "",
    })),
  };
  const mcpProjects = projectScopeList.map((p) => ({
    cwd: p.cwd,
    name: p.name,
    path: path.join(p.dir, "mcp.json"),
    servers: serverList.filter((s) => s.scope === `project:${p.cwd}`).map((s) => ({
      name: s.name,
      command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "",
    })),
  }));

  const scopes = [
    { id: "profile", name: `Profile · ${H.currentProfile}`, count: serverList.filter((s) => s.scope === "profile").length, dir: userMcpPath },
    ...projectScopeList.map((p) => ({
      id: `project:${p.cwd}`,
      name: p.name,
      cwd: p.cwd,
      count: serverList.filter((s) => s.scope === `project:${p.cwd}`).length,
      dir: path.join(p.dir, "mcp.json"),
    })),
  ];

  return {
    servers: serverList,
    scopes,
    userMcpPath,
    global: mcpProfile, // backward compat
    profile: mcpProfile,
    projects: mcpProjects,
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

/** Read hooks.enabled from omp-desktop.json (defaults to off). */
export function readHooksEnabled(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
    const hooks = raw?.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== "object") return false;
    return hooks.enabled === true;
  } catch {
    return false;
  }
}

/** Write hooks.enabled back. */
export async function writeHooksEnabled(enabled: boolean): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {}
  const hooks = raw.hooks && typeof raw.hooks === "object" ? (raw.hooks as Record<string, unknown>) : {};
  const dir = path.dirname(H.desktopProjectsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, hooks: { ...hooks, enabled } }, null, 2));
}

/** Read plugins.enabled from omp-desktop.json (defaults to off). */
export function readPluginsEnabled(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
    const plugins = raw?.plugins as Record<string, unknown> | undefined;
    if (!plugins || typeof plugins !== "object") return false;
    return plugins.enabled === true;
  } catch {
    return false;
  }
}

/** Write plugins.enabled back. */
export async function writePluginsEnabled(enabled: boolean): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {}
  const plugins = raw.plugins && typeof raw.plugins === "object" ? (raw.plugins as Record<string, unknown>) : {};
  const dir = path.dirname(H.desktopProjectsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, plugins: { ...plugins, enabled } }, null, 2));
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
  // HOOK_EXTS membership table (host/assets.ts top) is shared with resolveAssetFile

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
  // replace / \ : with -, wrap both ends in --).
  const validProjects = validDesktopProjects();
  const encodeProjectPath = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
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
    plugins: [] as { name: string }[],
    flags: { enableMCP: false, disableExtensionDiscovery: !(readPluginsEnabled() || readHooksEnabled()), computerEnabled: !!settingsGet(H.settings, "computer.enabled") },
  };
}
