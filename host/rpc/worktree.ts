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
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getWorktreeDir, hashPath } from "@oh-my-pi/pi-utils";
import type { RpcHandler } from "./types";
import { gitError, gitWrite } from "../git.ts";

/** Slug form enforced on names after UI-side slugify (identical mirror of the fork's rule). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SUFFIX = 100;
/** Branch namespace + worktree dir segment prefix: `omp worktree list/clear` sweeps these like the base's other producers. */
const BRANCH_PREFIX = "omp/desktop";
const DIR_PREFIX = "desktop";

/**
 * Run one git command against `cwd`. Write-locked (every call here creates or
 * removes refs/worktrees), so it also gets GIT_TERMINAL_PROMPT=0 plus the
 * shared timeout — the process layer in host/git.ts owns both.
 */
function git(args: string[], cwd: string) {
  return gitWrite(cwd, args);
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
  const r = await git(["rev-parse", "--git-common-dir"], cwd);
  if (!r.ok) return null;
  const commonDir = r.stdout.trim();
  if (!commonDir) return null;
  // git answers with a relative ".git" here. `rev-parse --path-format=absolute`
  // would force an absolute answer, but that flag only exists from git 2.31 —
  // older gits do not error, they echo the unknown flag back as if it were the
  // path, which silently turns primaryRoot into the literal string
  // "--path-format=absolute". Resolve against cwd instead so every git works.
  return dirname(resolve(cwd, commonDir));
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

/**
 * Every failure code these RPCs can emit; the UI maps each one to localized
 * copy, so a new literal here must also gain a `worktree.code.<code>` key.
 */
export const WORKTREE_ERROR_CODES = [
  "invalid_name",
  "missing_base",
  "not_a_repo",
  "worktree_create_failed",
  "missing_path",
  "status_failed",
  "not_a_worktree",
  "worktree_dirty",
  "worktree_remove_failed",
  // worktree_create_session only (managed .omp/worktrees copy, spec
  // docs/architecture/managed-worktree-spec.md):
  "start_ref_unresolvable",
  "start_ref_missing_subdir",
  "worktree_root_tracked",
] as const;
export type WorktreeErrorCode = (typeof WORKTREE_ERROR_CODES)[number];

/** One ok:false frame; `code` is the union, so a bare typo cannot slip past typecheck. */
function failFrame(type: string, reqId: number, code: WorktreeErrorCode, error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, reqId, ok: false, code, error, ...extra });
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
      ws.send(failFrame("worktree_created", reqId, "invalid_name", `Invalid worktree name "${rawName}" — use 1-41 chars of [a-z0-9-] after slugify`));
      return;
    }
    const baseCwd = typeof msg.baseCwd === "string" && msg.baseCwd ? msg.baseCwd : "";
    if (!baseCwd) {
      ws.send(failFrame("worktree_created", reqId, "missing_base", "worktree_create requires baseCwd"));
      return;
    }
    const primaryRoot = await primaryRootOf(baseCwd);
    if (!primaryRoot) {
      ws.send(failFrame("worktree_created", reqId, "not_a_repo", `Not a git repository: ${baseCwd}`));
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
        ws.send(failFrame("worktree_created", reqId, "worktree_create_failed", `git branch failed: ${mk.stderr.trim() || mk.stdout.trim()}`));
        return;
      }
      const add = await git(["worktree", "add", path, branch], primaryRoot);
      if (!add.ok) {
        await git(["branch", "-D", branch], primaryRoot); // roll back the orphaned ref, best-effort
        ws.send(failFrame("worktree_created", reqId, "worktree_create_failed", `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`));
        return;
      }
      ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: true, path, branch, baseCwd: primaryRoot }));
      return;
    }
    ws.send(failFrame("worktree_created", reqId, "worktree_create_failed", `No available worktree name after ${MAX_SUFFIX} attempts`));
  },

  // Live status probe for the remove flow: does the path still exist, is it a
  // git working tree, which branch, and the dirty counts. exists covers the
  // "already deleted" case so the dialog can no-op gracefully.
  async worktree_status(ws, msg) {
    const reqId = reqIdOf(msg);
    const path = typeof msg.path === "string" && msg.path ? msg.path : "";
    const base = { type: "worktree_status_result", reqId, path };
    if (!path) {
      ws.send(failFrame("worktree_status_result", reqId, "missing_path", "worktree_status requires path", { path }));
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
      ws.send(failFrame("worktree_status_result", reqId, "status_failed", "git status failed", { path, exists, isRepo, branch, dirty: false, staged: 0, unstaged: 0, untracked: 0 }));
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
      ws.send(failFrame("worktree_removed", reqId, "missing_path", "worktree_remove requires path", { path }));
      return;
    }
    const primaryRoot = await primaryRootOf(path);
    if (!primaryRoot) {
      ws.send(failFrame("worktree_removed", reqId, "not_a_worktree", `Not inside a git worktree: ${path}`, { path }));
      return;
    }
    if (!force) {
      const counts = await statusCounts(path);
      if (counts && counts.staged + counts.unstaged + counts.untracked > 0) {
        ws.send(failFrame("worktree_removed", reqId, "worktree_dirty", "Worktree has uncommitted changes", { path, ...counts }));
        return;
      }
    }
    const rm = await git(["worktree", "remove", ...(force ? ["--force"] : []), path], primaryRoot);
    if (!rm.ok) {
      ws.send(failFrame("worktree_removed", reqId, "worktree_remove_failed", `git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`, { path }));
      return;
    }
    await git(["worktree", "prune"], primaryRoot); // drop stale administrative entries, best-effort
    ws.send(JSON.stringify({ ...base, ok: true }));
  },

  // Managed worktree for the new-session toggle (spec
  // docs/architecture/managed-worktree-spec.md): an unnamed, branchless copy of
  // the repo at <primaryRoot>/.omp/worktrees/<4hex>/<name>, detached at HEAD.
  // Unlike worktree_create there is no name/baseRef negotiation: the directory
  // rule decides the name and HEAD is the only start point. Replies reuse the
  // worktree_created frame with two extra fields (cwd = the session cwd, head =
  // the start commit); the detached checkout sends NO branch field. The managed
  // root is expected to stay untracked: the host makes it locally ignored via
  // info/exclude (never the user's .gitignore) and refuses when tracked files
  // already live under it.
  async worktree_create_session(ws, msg) {
    const reqId = reqIdOf(msg);
    const baseCwd = typeof msg.baseCwd === "string" && msg.baseCwd ? msg.baseCwd : "";
    if (!baseCwd) {
      ws.send(failFrame("worktree_created", reqId, "missing_base", "worktree_create_session requires baseCwd"));
      return;
    }
    // Plain-repository check: the common dir must be <root>/.git (rejects bare,
    // submodules, non-repos). --git-common-dir may answer relative — resolve
    // against cwd like primaryRootOf above; --path-format=absolute stays banned
    // (git < 2.31 echoes the unknown flag back as the path).
    const commonR = await git(["rev-parse", "--git-common-dir"], baseCwd);
    const commonDir = commonR.ok && commonR.stdout.trim() ? resolve(baseCwd, commonR.stdout.trim()) : "";
    if (!commonDir || basename(commonDir) !== ".git") {
      ws.send(failFrame("worktree_created", reqId, "not_a_repo", `Not a plain git repository: ${baseCwd}`));
      return;
    }
    const primaryRoot = dirname(commonDir);
    // Fixed start point: HEAD as a commit. Works detached; an unborn HEAD
    // (empty repo) fails here.
    const headR = await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], primaryRoot);
    if (!headR.ok) {
      ws.send(failFrame("worktree_created", reqId, "start_ref_unresolvable", `HEAD does not resolve to a commit in ${primaryRoot}`));
      return;
    }
    const head = headR.stdout.trim();
    // Subdir project: the same relative path must be a tree at the start commit,
    // so the copy can host the session at the mirrored subdir. git reports the
    // PHYSICAL toplevel (/private/tmp on macOS), so realpath both sides before
    // differencing — a symlinked baseCwd would otherwise compare unequal to its
    // own root and produce a garbage relative path.
    const topR = await git(["rev-parse", "--show-toplevel"], baseCwd);
    let rel = "";
    if (topR.ok && topR.stdout.trim()) {
      const [topReal, baseReal] = await Promise.all([fs.realpath(topR.stdout.trim()), fs.realpath(baseCwd)]);
      rel = relative(topReal, baseReal);
    }
    if (rel) {
      const t = await git(["cat-file", "-t", `${head}:${rel}`], primaryRoot);
      if (!t.ok || t.stdout.trim() !== "tree") {
        ws.send(failFrame("worktree_created", reqId, "start_ref_missing_subdir", `"${rel}" does not exist at commit ${head.slice(0, 12)}`));
        return;
      }
    }
    // Refusal narrows to tracked files under the managed root: gitignore
    // precedence puts tracked above exclude, so an existing tracked file would
    // leak into status no matter what we write.
    const managedRoot = join(primaryRoot, ".omp", "worktrees");
    const tracked = await git(["ls-files", "--", ".omp/worktrees"], primaryRoot);
    if (tracked.ok && tracked.stdout.trim() !== "") {
      ws.send(failFrame("worktree_created", reqId, "worktree_root_tracked", `Tracked files already exist under ${managedRoot}`));
      return;
    }
    try {
      await fs.mkdir(managedRoot, { recursive: true });
    } catch {
      // raced by a concurrent create — harmless, the bucket mkdir below is the claim
    }
    // Keep Spotlight from indexing full checkouts (macOS only; inert elsewhere).
    if (process.platform === "darwin") {
      await fs.writeFile(join(managedRoot, ".metadata_never_index"), "").catch(() => {});
    }
    // Local ignore without touching the user's .gitignore. Deliberately no
    // dedup / locking: a duplicated exclude line is harmless.
    const ign = await git(["check-ignore", "-q", managedRoot], primaryRoot);
    if (!ign.ok) {
      await fs.appendFile(join(commonDir, "info", "exclude"), ".omp/worktrees/\n").catch(() => {});
    }
    // Atomic bucket claim: non-recursive mkdir on a random 4-hex name; EEXIST
    // means a concurrent create claimed it, retry. git creates the target's
    // parent chain itself, so the mkdir is only the uniqueness claim.
    const name = basename(primaryRoot);
    let bucket = "";
    let target = "";
    for (let attempt = 0; attempt < 32; attempt++) {
      const dir = join(managedRoot, randomBytes(2).toString("hex"));
      try {
        await fs.mkdir(dir);
        bucket = dir;
        target = join(dir, name);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          ws.send(failFrame("worktree_created", reqId, "worktree_create_failed", `Could not allocate a worktree bucket under ${managedRoot}: ${String(err)}`));
          return;
        }
      }
    }
    if (!bucket) {
      ws.send(failFrame("worktree_created", reqId, "worktree_create_failed", `No available worktree bucket under ${managedRoot} after 32 attempts`));
      return;
    }
    // Full checkout, so the write timeout relaxes far beyond the default 60s.
    const add = await gitWrite(primaryRoot, ["worktree", "add", "--detach", target, head], { timeoutMs: 600_000 });
    if (!add.ok) {
      // Cleanup contract: no bucket dir on disk, no admin entry in `worktree list`.
      // Recursive rm is safe: the bucket was claimed empty and only the failed
      // add may have written into it.
      await fs.rm(bucket, { recursive: true, force: true }).catch(() => {});
      await git(["worktree", "prune"], primaryRoot); // drop the prunable residue, best-effort
      ws.send(failFrame("worktree_created", reqId, "worktree_create_failed", `git worktree add failed: ${gitError(add, 300)}`));
      return;
    }
    const cwd = rel ? join(target, rel) : target;
    ws.send(JSON.stringify({ type: "worktree_created", reqId, ok: true, path: target, cwd, head, baseCwd: primaryRoot }));
  },
};
