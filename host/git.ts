// Single process layer for every git invocation the host makes. SSOT for argv
// shape, environment and timeout, so no call site can forget the guard rails
// that keep a git call from hanging the host.
//
// Modelled on git4idea's GitImplBase + GitCommand.LockingPolicy:
//
//   locking "read"  → GIT_OPTIONAL_LOCKS=0. Read commands (status/log/diff/
//                     branch) otherwise try to take .git/index.lock, which
//                     collides with the agent's own git runs in the same repo
//                     and with a concurrently open IDE. We never want the index
//                     rewritten by a read.
//   locking "write" → same, plus GIT_TERMINAL_PROMPT=0. stdin is ignored (a
//                     GUI has no terminal), so a credential or identity prompt
//                     has nowhere to go: git would block until the timeout.
//                     Failing fast beats blocking the host.
//
// Global `-c` flags, applied to every call:
//   core.quotepath=false → git stops octal-escaping non-ASCII paths. Status
//                          parsing additionally uses -z (NUL records), so
//                          quoting never applies; this is the backstop for the
//                          commands that still print bare paths.
//   color.ui=false       → no ANSI escapes reach the UI (toasts show raw git
//                          stderr, which would otherwise carry colour codes).
//
// Every call is async with a hard timeout. Bun's sync spawn blocks the whole
// event loop, which would freeze the host on a hung git.

import fs from "node:fs";
import path from "node:path";

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command exceeded its timeout and was killed. */
  timedOut: boolean;
}

export type GitLocking = "read" | "write";

export interface GitOptions {
  /** Overrides the default timeout for this locking class. */
  timeoutMs?: number;
}

/** Read commands must never wait on a lock; give a huge index room to answer. */
const READ_TIMEOUT_MS = 20_000;
/** Local mutations (add/commit/reset/checkout) are fast even on huge repos. */
const WRITE_TIMEOUT_MS = 60_000;
/** Anything that talks to a remote: network, not CPU, dominates. */
const NETWORK_TIMEOUT_MS = 180_000;

const GLOBAL_FLAGS = ["-c", "core.quotepath=false", "-c", "color.ui=false"];

/** Commands that open a network connection; they get the long timeout. */
const NETWORK_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone", "remote", "ls-remote"]);

function envFor(locking: GitLocking): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    // Never let a pager or an inherited editor hijack a non-interactive call.
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    ...(locking === "write" ? { GIT_TERMINAL_PROMPT: "0" } : {}),
  };
}

/**
 * Run git in `cwd`. Arguments are passed as an array, never concatenated into a
 * shell string, so a path can never be reinterpreted as an option (call sites
 * still pass `--` before user-supplied pathspecs).
 */
export async function git(
  cwd: string,
  args: string[],
  locking: GitLocking = "read",
  opts: GitOptions = {},
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs
    ?? (NETWORK_SUBCOMMANDS.has(args[0]) ? NETWORK_TIMEOUT_MS
      : locking === "write" ? WRITE_TIMEOUT_MS
      : READ_TIMEOUT_MS);

  const proc = Bun.spawn(["git", "-C", cwd, ...GLOBAL_FLAGS, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: envFor(locking),
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { ok: code === 0, code, stdout, stderr, timedOut };
  } catch (err) {
    return { ok: false, code: null, stdout: "", stderr: String(err), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: read-locked run. */
export function gitRead(cwd: string, args: string[], opts?: GitOptions) {
  return git(cwd, args, "read", opts);
}

/** Convenience: write-locked run (index-affecting or network). */
export function gitWrite(cwd: string, args: string[], opts?: GitOptions) {
  return git(cwd, args, "write", opts);
}

/** Collapse a failed result into a short, single-line reason for the UI. */
export function gitError(r: GitResult, maxLen = 500): string {
  const raw = r.timedOut ? "" : r.stderr.trim() || r.stdout.trim();
  return raw.replace(/\s+/g, " ").slice(0, maxLen);
}

// ---------- repository discovery ----------

/** Absolute repo root for `cwd`, or null when it is not inside a work tree. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await gitRead(cwd, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return null;
  const root = r.stdout.trim();
  return root || null;
}

export async function isGitWorktree(cwd: string): Promise<boolean> {
  const r = await gitRead(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

// ---------- refs (git4idea's GitRepositoryReader pattern) ----------

export interface RefRow {
  /** Full refname, e.g. "refs/heads/main" / "refs/remotes/origin/main". */
  refname: string;
  oid: string;
  /** Short name with the namespace stripped: "main", "origin/main". */
  short: string;
  isHead: boolean;
  /** Configured upstream's short name, empty when the branch has none. */
  upstream: string;
  /** Raw %(upstream:track): "" / "[gone]" / "[ahead 2, behind 1]". */
  track: string;
  kind: "local" | "remote" | "tag";
}

/**
 * Every ref in one round trip. The refname prefix is what distinguishes a local
 * branch from a remote-tracking one — never a "/" test on the short name, which
 * misreads "feat/login" as a remote. Field 3 (`%(HEAD)`) is "*" for the checked
 * out ref and empty for everything else, so detached HEAD falls out of the same
 * query instead of needing a separate probe.
 */
export async function forEachRef(cwd: string): Promise<RefRow[]> {
  const format = "--format=%(refname)%09%(objectname)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)";
  const r = await gitRead(cwd, ["for-each-ref", format]);
  if (!r.ok) return [];
  const rows: RefRow[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [refname, oid, head, upstream, track] = line.split("\t");
    if (!refname) continue;
    const kind: RefRow["kind"] = refname.startsWith("refs/heads/")
      ? "local"
      : refname.startsWith("refs/remotes/")
        ? "remote"
        : "tag";
    if (kind === "tag" && !refname.startsWith("refs/tags/")) continue;
    rows.push({
      refname,
      oid: oid ?? "",
      short: refname.slice(kind === "tag" ? "refs/tags/".length : kind === "local" ? "refs/heads/".length : "refs/remotes/".length),
      isHead: head === "*",
      upstream: upstream ?? "",
      track: track ?? "",
      kind,
    });
  }
  return rows;
}

// ---------- operation state machine (git4idea's GitOperationState) ----------

export type GitOperationState =
  | "NORMAL"
  | "REBASE"
  | "MERGE"
  | "CHERRY_PICK"
  | "REVERT"
  | "DETACHED_HEAD";

/**
 * Which mutating operation, if any, has the repository half-finished. Read from
 * the git dir directly (no subprocess per probe), the same way IDEA reads
 * MERGE_HEAD / REBASE_HEAD / rebase-merge / rebase-apply off disk.
 *
 * Every mutating RPC consults this before running: committing mid-rebase or
 * checking out mid-merge silently does the wrong thing, and the user needs to be
 * told why the operation was refused.
 */
export async function operationState(cwd: string): Promise<GitOperationState> {
  const gitDir = await absoluteGitDir(cwd);
  if (!gitDir) return "NORMAL";
  const has = (name: string) => fs.existsSync(path.join(gitDir, name));
  if (has("rebase-merge") || has("rebase-apply") || has("REBASE_HEAD")) return "REBASE";
  if (has("MERGE_HEAD")) return "MERGE";
  if (has("CHERRY_PICK_HEAD")) return "CHERRY_PICK";
  if (has("REVERT_HEAD")) return "REVERT";
  // symbolic-ref exits non-zero exactly when HEAD is not on a branch.
  const sym = await gitRead(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!sym.ok) return "DETACHED_HEAD";
  return "NORMAL";
}

/** Absolute .git directory, following a worktree's `gitdir:` pointer file. */
export async function absoluteGitDir(cwd: string): Promise<string | null> {
  const r = await gitRead(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!r.ok) return null;
  const dir = r.stdout.trim();
  return dir || null;
}
