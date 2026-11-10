// Repository grouping for the "one row per repository" project list mode
// (session.worktreeScope === "repo"): which registered project dirs belong to the same
// repository, and every checkout of it.
import fs from "node:fs";
import path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { gitRead } from "./git.ts";

/** One `git worktree` checkout (no "current" flag: that is a per-page concern). */
export interface RepoWorktree {
  path: string;
  /** Checked-out branch short name; empty when detached. */
  branch: string;
  detached: boolean;
}

/** Every checkout of one repository, plus the registered project dirs inside it. */
export interface RepoGroup {
  /** Primary checkout (the clone the linked worktrees point back to). */
  root: string;
  /** Display name: the primary checkout's directory name, disambiguated on collision. */
  name: string;
  worktrees: RepoWorktree[];
  /** Registered project cwds that belong to this repository. */
  cwds: string[];
}

/**
 * Primary checkout of the repository containing `cwd`, from the filesystem alone (no
 * subprocess): a linked worktree carries a `.git` FILE holding
 * `gitdir: <root>/.git/worktrees/<name>`, a plain checkout carries a `.git` DIRECTORY.
 * Returns null when `cwd` has no `.git` — the caller falls back to `gitCommonRoot`.
 */
export function repoRootOf(cwd: string): string | null {
  const gitEntry = path.join(cwd, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitEntry);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return cwd;
  const m = /^gitdir:[ \t]*(.+)$/m.exec(fs.readFileSync(gitEntry, "utf8"));
  if (!m) return null;
  // Relative gitdir paths resolve against the directory holding the .git file.
  const gitdir = path.resolve(cwd, m[1].trim());
  // <root>/.git/worktrees/<name> → <root>. Anything else (submodule `.git/modules/*`,
  // bare repo) is not a primary checkout of its own repository.
  if (path.basename(path.dirname(gitdir)) !== "worktrees") return null;
  return path.resolve(gitdir, "..", "..", "..");
}

/**
 * Same root for a cwd WITHOUT its own `.git` (a project registered as a subdirectory),
 * resolved through the git common dir so a linked worktree maps back to the primary
 * checkout instead of to itself.
 */
async function gitCommonRoot(cwd: string): Promise<string | null> {
  const r = await gitRead(cwd, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return null;
  const dir = path.resolve(cwd, r.stdout.trim());
  return path.basename(dir) === ".git" ? path.dirname(dir) : null;
}

/**
 * Parse `git worktree list --porcelain` (blank-line separated records). Bare
 * repositories are dropped: they have no working tree to open.
 */
export function parseWorktreeList(stdout: string): RepoWorktree[] {
  const out: RepoWorktree[] = [];
  for (const block of stdout.split("\n\n")) {
    let wtPath = "";
    let branch = "";
    let detached = false;
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
    }
    if (!wtPath || bare) continue;
    out.push({ path: wtPath, branch, detached });
  }
  return out;
}

/**
 * Every checkout of the repository whose primary checkout is `root`. Uncached on purpose:
 * one git call per repository per session-list frame, and the frame is already dominated
 * by the disk scan. An empty list (git failure) leaves the caller's rows unmerged.
 */
export async function worktreesOf(root: string): Promise<RepoWorktree[]> {
  const r = await gitRead(root, ["worktree", "list", "--porcelain"]);
  return r.ok ? parseWorktreeList(r.stdout) : [];
}

/**
 * Group registered project cwds by repository. Non-git dirs and unresolvable roots are
 * left out so the caller keeps them as ordinary rows. Repositories whose primary checkout
 * name collides with another one get the parent directory appended ("repo-a/omp").
 */
export async function repoGroups(cwds: string[]): Promise<RepoGroup[]> {
  // Keyed by the realpath-normalized root: the same checkout reached through a symlinked
  // or differently-cased spelling (macOS /var vs /private/var, the .git file stores the
  // real path) must not become two groups.
  const byRoot = new Map<string, string[]>();
  for (const cwd of cwds) {
    const root = repoRootOf(cwd) ?? (await gitCommonRoot(cwd));
    if (!root) continue;
    const key = normalizePathForComparison(root);
    const list = byRoot.get(key);
    if (list) list.push(cwd);
    else byRoot.set(key, [cwd]);
  }
  const groups: RepoGroup[] = [];
  for (const [root, members] of byRoot) {
    const worktrees = await worktreesOf(root);
    if (worktrees.length === 0) continue;
    groups.push({ root, name: path.basename(root) || root, worktrees, cwds: members });
  }
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
  for (const g of groups) {
    if ((counts.get(g.name) ?? 0) < 2) continue;
    g.name = `${path.basename(path.dirname(g.root))}/${g.name}`;
  }
  return groups;
}
