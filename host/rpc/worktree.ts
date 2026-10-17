// Git worktree RPCs backing the sidebar "worktree session" entry: create a
// branch `omp/desktop/<slug>` checked out at getWorktreeDir(`desktop-<slug>-<hash7>`),
// then the UI points the new-session flow at that path as cwd. Removal refuses a
// dirty worktree unless force — the confirm dialog on the UI side is the consent
// channel. Ported from the GUI fork's sidecar rpc-worktree.ts, but on plain
// `git` CLI via Bun.spawn (house style: files.ts git domain) instead of the
// pi-natives VCS adapter.
//
// Replies carry the caller's reqId so the UI can correlate (request/response over
// the push-frame ws). Expected failures reply ok:false with a stable `code`
// (the UI maps codes to localized copy) and never throw — exceptions here would
// only reach main.ts's generic error shell, losing the reqId.
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { getWorktreeDir, hashPath } from "@oh-my-pi/pi-utils";
import type { RpcHandler } from "./types";

/** Slug form enforced on names after UI-side slugify (identical mirror of the fork's rule). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SUFFIX = 100;
/** Branch namespace + worktree dir segment prefix: `omp worktree list/clear` sweeps these like the base's other producers. */
const BRANCH_PREFIX = "omp/desktop";
const DIR_PREFIX = "desktop";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one git command; stdin ignored so prompts can never hang the RPC. */
async function git(args: string[], cwd?: string): Promise<GitResult> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, stdout, stderr };
}

/** Lowercase, spaces→`-`, strip everything outside [a-z0-9-], collapse runs, trim dashes (fork parity). */
function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Main repository root for a path inside any worktree: the common git dir's parent. */
async function primaryRootOf(cwd: string): Promise<string | null> {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (!r.ok) return null;
  const commonDir = r.stdout.trim();
  if (!commonDir) return null;
  return dirname(commonDir);
}

/** Porcelain-v1 status counts (staged/unstaged/untracked) — same split the right-panel diff uses. */
async function statusCounts(cwd: string): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const r = await git(["status", "--porcelain"], cwd);
  if (!r.ok) return null;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("??")) {
      untracked++;
    } else {
      if (line[0] !== " ") staged++;
      if (line.length > 1 && line[1] !== " ") unstaged++;
    }
  }
  return { staged, unstaged, untracked };
}

/** Default branch of the origin remote as tracked locally (origin/HEAD), falling back to HEAD. */
async function defaultBranchRef(cwd: string): Promise<string> {
  const r = await git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  if (r.ok) {
    const ref = r.stdout.trim(); // "origin/main" form
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  }
  return "HEAD";
}

function reqIdOf(msg: Record<string, unknown>): number {
  const n = Number(msg.reqId);
  return Number.isFinite(n) ? n : 0;
}

export const worktreeHandlers: Record<string, RpcHandler> = {
  // Create a worktree + branch. name (free text, slugified) + baseRef ("HEAD" |
  // "default") + baseCwd (the repo to branch from — the UI passes the active
  // session's cwd or the new-session project). Collisions suffix -2..-100 on
  // both branch and dir (fork parity).
  async worktree_create(ws, msg) {
    const reqId = reqIdOf(msg);
    const rawName = String(msg.name ?? "");
    const name = slugifyName(rawName);
    if (!name || !NAME_PATTERN.test(name)) {
      ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: false, code: "invalid_name", error: `Invalid worktree name "${rawName}" — use 1-41 chars of [a-z0-9-] after slugify` }));
      return;
    }
    const baseCwd = typeof msg.baseCwd === "string" && msg.baseCwd ? msg.baseCwd : "";
    if (!baseCwd) {
      ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: false, code: "missing_base", error: "worktree_create requires baseCwd" }));
      return;
    }
    const primaryRoot = await primaryRootOf(baseCwd);
    if (!primaryRoot) {
      ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: false, code: "not_a_repo", error: `Not a git repository: ${baseCwd}` }));
      return;
    }
    const startPoint = msg.baseRef === "default" ? await defaultBranchRef(primaryRoot) : "HEAD";

    for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
      const candidate = suffix === 1 ? name : `${name}-${suffix}`;
      const branch = `${BRANCH_PREFIX}/${candidate}`;
      const path = getWorktreeDir(`${DIR_PREFIX}-${candidate}-${hashPath(primaryRoot)}`);
      // Stat the dir itself, not just .git — a half-created worktree dir still makes `git worktree add` fail with "exists".
      const dirTaken = await fs
        .stat(path)
        .then(
          () => true,
          () => false,
        );
      const branchTaken = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], primaryRoot)).ok;
      if (dirTaken || branchTaken) continue;
      // Create the branch first so a worktree-add failure can roll the ref back
      // cleanly (the next suffix or a retry must not trip over a half ref).
      const mk = await git(["branch", branch, startPoint], primaryRoot);
      if (!mk.ok) {
        ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: false, code: "worktree_create_failed", error: `git branch failed: ${mk.stderr.trim() || mk.stdout.trim()}` }));
        return;
      }
      const add = await git(["worktree", "add", path, branch], primaryRoot);
      if (!add.ok) {
        await git(["branch", "-D", branch], primaryRoot); // roll back the orphaned ref, best-effort
        ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: false, code: "worktree_create_failed", error: `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}` }));
        return;
      }
      ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: true, path, branch, baseCwd: primaryRoot }));
      return;
    }
    ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: false, code: "worktree_create_failed", error: `No available worktree name after ${MAX_SUFFIX} attempts` }));
  },

  // Live status probe for the remove flow: does the path still exist, is it a
  // git working tree, which branch, and the dirty counts. exists covers the
  // "already deleted" case so the dialog can no-op gracefully.
  async worktree_status(ws, msg) {
    const reqId = reqIdOf(msg);
    const path = typeof msg.path === "string" && msg.path ? msg.path : "";
    const base = { type: "worktree_status_result", reqId, path };
    if (!path) {
      ws.send(JSON.stringify({ ...base, ok: false, code: "missing_path", error: "worktree_status requires path" }));
      return;
    }
    const exists = await fs
      .stat(path)
      .then(
        () => true,
        () => false,
      );
    const root = exists ? await primaryRootOf(path) : null;
    const isRepo = root !== null;
    if (!exists || !isRepo) {
      ws.send(JSON.stringify({ ...base, ok: true, exists, isRepo, branch: null, dirty: false, staged: 0, unstaged: 0, untracked: 0 }));
      return;
    }
    const branchR = await git(["branch", "--show-current"], path);
    const branch = branchR.ok ? branchR.stdout.trim() || null : null;
    const counts = await statusCounts(path);
    if (!counts) {
      ws.send(JSON.stringify({ ...base, ok: false, code: "status_failed", error: "git status failed", exists, isRepo, branch, dirty: false, staged: 0, unstaged: 0, untracked: 0 }));
      return;
    }
    ws.send(JSON.stringify({ ...base, ok: true, exists, isRepo, branch, dirty: counts.staged + counts.unstaged + counts.untracked > 0, ...counts }));
  },

  // Remove a worktree. Dirty refuses unless force (code "worktree_dirty" carries
  // the counts in the same frame so the dialog can show what would be
  // discarded). The branch itself is never deleted — merged-state detection is
  // out of scope, `git branch -d` stays one manual command away.
  async worktree_remove(ws, msg) {
    const reqId = reqIdOf(msg);
    const path = typeof msg.path === "string" && msg.path ? msg.path : "";
    const force = msg.force === true;
    const base = { type: "worktree_removed", reqId, path };
    if (!path) {
      ws.send(JSON.stringify({ ...base, ok: false, code: "missing_path", error: "worktree_remove requires path" }));
      return;
    }
    const primaryRoot = await primaryRootOf(path);
    if (!primaryRoot) {
      ws.send(JSON.stringify({ ...base, ok: false, code: "not_a_worktree", error: `Not inside a git worktree: ${path}` }));
      return;
    }
    if (!force) {
      const counts = await statusCounts(path);
      if (counts && counts.staged + counts.unstaged + counts.untracked > 0) {
        ws.send(JSON.stringify({ ...base, ok: false, code: "worktree_dirty", error: "Worktree has uncommitted changes", ...counts }));
        return;
      }
    }
    const rm = await git(["worktree", "remove", ...(force ? ["--force"] : []), path], primaryRoot);
    if (!rm.ok) {
      ws.send(JSON.stringify({ ...base, ok: false, code: "worktree_remove_failed", error: `git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}` }));
      return;
    }
    await git(["worktree", "prune"], primaryRoot); // drop stale administrative entries, best-effort
    ws.send(JSON.stringify({ ...base, ok: true }));
  },
};
