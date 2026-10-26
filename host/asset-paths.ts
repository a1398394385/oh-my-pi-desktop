// Disk asset path resolution leaf: project .omp discovery, per-kind asset
// roots, frontend path validation and the source-switch predicates shared by
// the skill / MCP / plugin asset scanners. No dependency on the asset
// scanners themselves (assets.ts, mcp-assets.ts, plugin-assets.ts).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { hostI18n } from "./i18n/host.ts";
import { H } from "./state.ts";
import { isProviderEnabled, isUserSourceEnabled } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";

// Agent definition description: prefer the YAML frontmatter description, fall back to the H1 heading
export async function agentFileDescription(file: string): Promise<string> {
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
export function hookDirRoots(): string[] {
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
export function isAssetSourceOn(provider: string, level: "user" | "project"): boolean {
  if (!isProviderEnabled(provider)) return false;
  if (level === "project") return true;
  if (isUserSourceEnabled(provider)) return true;
  if (provider === "claude") return settingsGet(H.settings, "skills.enableClaudeUser") === true;
  if (provider === "codex") return settingsGet(H.settings, "skills.enableCodexUser") === true;
  return false;
}

// All valid skill roots (global OMP/Agents/Claude/Codex/OpenCode, profile, and project levels)
export function allSkillRoots(): string[] {
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
