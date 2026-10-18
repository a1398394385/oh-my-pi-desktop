// Read-only Git manager RPCs backing the middle-column Git page: the commit
// graph (topo-ordered log across refs plus branch/tag lists in one round
// trip), one commit's detail (full message, per-file numstat, ancestor count)
// and one file's diff inside a commit (right-panel viewer). Only `log`, `show`,
// `rev-list`, `for-each-ref` and `rev-parse` run here — no ref is ever written.
//
// Replies echo the caller's reqId and, on failure, carry ok:false instead of
// throwing (same contract as the worktree domain): a missing repository or a
// stale ref must not surface as a generic error frame without correlation.
//
// Caching: a commit graph is a pure function of (repo, scope, limit) until the
// refs move, so results are memoized for GRAPH_TTL_MS — reopening the page or
// re-filtering a branch then costs zero subprocesses. Commit details and
// per-file diffs are immutable (keyed by oid/path) and only evicted by size.
// `force: true` (the refresh button) bypasses the graph cache.
import { hostI18n } from "../i18n/host.ts";
import type { RpcHandler } from "./types";
// Every git call routes through the shared process layer (argv/env/timeout in
// one place); this file only decides which command to run and how to read it.
import { forEachRef, gitError, gitRead, repoRoot, type RefRow } from "../git.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const GRAPH_TTL_MS = 5_000;
const MAX_IMMUTABLE_ROWS = 300;
/** NUL-separated fields, record separator after each commit (subject is single-line). */
const GRAPH_FORMAT = "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e";
/** Body sits last: it may contain newlines, so the field list is split from the left. */
const DETAIL_FORMAT = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e";

function reqIdOf(msg: Record<string, unknown>): number {
  const n = Number(msg.reqId);
  return Number.isFinite(n) ? n : 0;
}

/** `%D` decorations: drop the detached-HEAD marker, the `HEAD -> ` hand-off and the `tag: ` prefix. */
function parseRefs(decoration: string): string[] {
  if (!decoration) return [];
  return decoration
    .split(", ")
    .map((part) =>
      part === "HEAD" ? "" : part.replace(/^HEAD -> /, "").replace(/^tag: /, "").trim(),
    )
    .filter(Boolean);
}

interface GraphCommit {
  oid: string;
  parents: string[];
  subject: string;
  author: string;
  authorTime: number;
  refs: string[];
}

function parseCommits(stdout: string): GraphCommit[] {
  const commits: GraphCommit[] = [];
  for (const raw of stdout.split("\x1e")) {
    // tformat appends one newline per record: every record but the first starts with it
    const entry = raw.replace(/^\n/, "");
    if (!entry) continue;
    const [oid, parentsRaw, author, authorTimeRaw, decoration, subject] = entry.split("\x00");
    if (!oid) continue;
    commits.push({
      oid,
      parents: parentsRaw ? parentsRaw.split(" ") : [],
      subject: subject ?? "",
      author: author ?? "",
      authorTime: Number(authorTimeRaw ?? "0"),
      refs: parseRefs(decoration ?? ""),
    });
  }
  return commits;
}

interface CommitFile {
  path: string;
  /** Pre-rename path when the commit renamed/copied this file (numstat -z record). */
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface CommitDetail {
  oid: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
  body: string;
}

/**
 * Parse the `--numstat -z` block: records are NUL-terminated, and a
 * rename/copy record splits its paths into two extra NUL-separated fields
 * (`add\tdel\t\0old\0new`). Reading those explicitly is what makes the detail
 * rows point at real paths — the human-readable `a => b` form is not a path and
 * would make the per-file diff request come back empty.
 */
function parseNumstat(rest: string): CommitFile[] {
  const files: CommitFile[] = [];
  const parts = rest.split("\x00");
  let i = 0;
  while (i < parts.length) {
    const record = parts[i].replace(/^\n+/, "");
    i += 1;
    if (!record) continue;
    const cells = record.split("\t");
    if (cells.length < 3) continue;
    const [additionsRaw, deletionsRaw, pathField] = cells;
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    let oldPath: string | undefined;
    let path = pathField;
    if (!pathField) {
      // rename/copy: the next two NUL fields carry old and new path
      oldPath = parts[i];
      path = parts[i + 1] ?? "";
      i += 2;
      if (!path) continue;
    }
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      additions: binary ? 0 : Number(additionsRaw),
      deletions: binary ? 0 : Number(deletionsRaw),
      binary,
    });
  }
  return files;
}

/** Split `git show --numstat` output into the header fields and the numstat rows. */
function parseDetail(stdout: string): { commit: CommitDetail; files: CommitFile[] } | null {
  const cut = stdout.indexOf("\x1e");
  if (cut < 0) return null;
  const fields = stdout.slice(0, cut).split("\x00");
  const [oid, parentsRaw, author, authorEmail, authorTimeRaw, subject, ...bodyParts] = fields;
  if (!oid) return null;
  const files = parseNumstat(stdout.slice(cut + 1));
  return {
    commit: {
      oid,
      parents: parentsRaw ? parentsRaw.split(" ") : [],
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      authorTime: Number(authorTimeRaw ?? "0"),
      subject: subject ?? "",
      body: bodyParts.join("\x00").trim(),
    },
    files,
  };
}

/** Ref names under one namespace, sorted; symbolic HEAD entries dropped. */
function groupRefs(refs: RefRow[], prefix: string): string[] {
  const ns = prefix + "/";
  return refs
    .filter((r) => r.refname.startsWith(ns) && !r.short.endsWith("/HEAD"))
    .map((r) => r.short)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Bounded memo: insertion order doubles as eviction order (oldest first). */
function remember<T>(map: Map<string, T>, key: string, value: T): T {
  if (map.size >= MAX_IMMUTABLE_ROWS) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
  return value;
}

/** Graph payload, cached per (repo, scope, limit). */
interface GraphPayload {
  root: string;
  branch: string;
  commits: GraphCommit[];
  hasMore: boolean;
  branches: { local: string[]; remotes: string[]; tags: string[] };
}

const graphCache = new Map<string, { at: number; payload: GraphPayload }>();
const detailCache = new Map<string, { commit: CommitDetail; files: CommitFile[]; commitCount: number | null }>();
const fileDiffCache = new Map<string, string>();

export const gitGraphHandlers: Record<string, RpcHandler> = {
  // Commit graph. scope = "" means every local/remote ref (git log --branches
  // --tags --remotes); a branch/tag name restricts the log to that ref's
  // history. hasMore reports that the host fetched one row past the caller's
  // limit.
  async git_graph(ws, msg) {
    const reqId = reqIdOf(msg);
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    const base = { type: "git_graph", reqId, cwd };
    const fail = (error: string) => ws.send(JSON.stringify({ ...base, ok: false, error }));
    if (!cwd) return fail(hostI18n.t("errors.param.missingPath"));
    const top = await repoRoot(cwd);
    if (!top) return fail(hostI18n.t("errors.git.notARepo"));
    const repoRootPath = top;
    const rawLimit = Number(msg.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
      : DEFAULT_LIMIT;
    // A ref never starts with "-": refusing one keeps the value out of option
    // position. Existence is left to git log, whose stderr explains the miss.
    const scope = typeof msg.scope === "string" ? msg.scope.trim() : "";
    if (scope.startsWith("-") || scope.includes("\n")) return fail(hostI18n.t("errors.git.badRef", { ref: scope }));
    const cacheKey = `${repoRootPath}\x00${scope}\x00${limit}`;
    const cached = graphCache.get(cacheKey);
    if (msg.force !== true && cached && Date.now() - cached.at < GRAPH_TTL_MS) {
      ws.send(JSON.stringify({ ...base, ok: true, ...cached.payload }));
      return;
    }
    const refArgs = scope ? [scope] : ["--branches", "--tags", "--remotes"];
    const log = await gitRead(repoRootPath, [
      "log",
      ...refArgs,
      "--topo-order",
      "--parents",
      GRAPH_FORMAT,
      "--max-count",
      String(limit + 1),
    ]);
    if (!log.ok) {
      return fail(hostI18n.t("errors.git.logFailed", { detail: gitError(log, 300) || hostI18n.t("errors.git.notARepo") }));
    }
    const all = parseCommits(log.stdout);
    // One for-each-ref feeds all three namespace lists and the current branch.
    const refs = await forEachRef(repoRootPath);
    const head = refs.find((r) => r.isHead);
    const payload: GraphPayload = {
      root: repoRootPath,
      branch: head?.short ?? "",
      commits: all.slice(0, limit),
      hasMore: all.length > limit,
      branches: {
        local: groupRefs(refs, "refs/heads"),
        remotes: groupRefs(refs, "refs/remotes"),
        tags: groupRefs(refs, "refs/tags"),
      },
    };
    graphCache.set(cacheKey, { at: Date.now(), payload });
    ws.send(JSON.stringify({ ...base, ok: true, ...payload }));
  },

  // One commit's detail: header fields + full body, the numstat file rows, and
  // how many commits are reachable from it (the "N commits" footer).
  async git_commit_detail(ws, msg) {
    const reqId = reqIdOf(msg);
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    const oid = String(msg.oid ?? "").trim();
    const base = { type: "git_commit_detail", reqId, cwd, oid };
    const fail = (error: string) => ws.send(JSON.stringify({ ...base, ok: false, error }));
    if (!cwd) return fail(hostI18n.t("errors.param.missingPath"));
    if (!/^[0-9a-fA-F]{4,40}$/.test(oid)) return fail(hostI18n.t("errors.git.badCommit", { oid }));
    const cacheKey = `${cwd}\x00${oid}`;
    const cached = detailCache.get(cacheKey);
    if (cached) {
      ws.send(JSON.stringify({ ...base, ok: true, ...cached }));
      return;
    }
    // `-m --first-parent` makes merge commits show their first-parent diff
    // (plain `git show <merge>` prints nothing for a path query).
    const show = await gitRead(cwd, ["show", "--numstat", "-z", "-M", "-m", "--first-parent", DETAIL_FORMAT, oid]);
    if (!show.ok) {
      return fail(hostI18n.t("errors.git.showFailed", { detail: gitError(show, 300) || hostI18n.t("errors.git.notARepo") }));
    }
    const parsed = parseDetail(show.stdout);
    if (!parsed) return fail(hostI18n.t("errors.git.showFailed", { detail: hostI18n.t("errors.git.notARepo") }));
    const count = await gitRead(cwd, ["rev-list", "--count", oid]);
    let additions = 0;
    let deletions = 0;
    for (const file of parsed.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    const payload = {
      commit: parsed.commit,
      files: parsed.files,
      additions,
      deletions,
      commitCount: count.ok ? Number(count.stdout.trim()) || 0 : null,
    };
    remember(detailCache, cacheKey, payload);
    ws.send(JSON.stringify({ ...base, ok: true, ...payload }));
  },

  // One file's diff inside a commit (right-panel viewer). `git show` with an
  // empty format prints the patch alone; `-M` keeps renames showable, and a
  // rename is addressed by both paths (the old one is what the patch hunk is
  // keyed on). The commit contents never change, so the result is memoized by
  // (cwd, oid, path).
  async git_commit_file_diff(ws, msg) {
    const reqId = reqIdOf(msg);
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    const oid = String(msg.oid ?? "").trim();
    const filePath = String(msg.path ?? "");
    const oldPath = String(msg.oldPath ?? "");
    const base = { type: "commit_file_diff", reqId, cwd, oid, path: filePath };
    const fail = (error: string) => ws.send(JSON.stringify({ ...base, ok: false, error }));
    if (!cwd) return fail(hostI18n.t("errors.param.missingPath"));
    if (!/^[0-9a-fA-F]{4,40}$/.test(oid)) return fail(hostI18n.t("errors.git.badCommit", { oid }));
    if (!filePath) return fail(hostI18n.t("errors.param.missingPath"));
    const cacheKey = `${cwd}\x00${oid}\x00${filePath}`;
    const cached = fileDiffCache.get(cacheKey);
    if (cached !== undefined) {
      ws.send(JSON.stringify({ ...base, ok: true, diff: cached }));
      return;
    }
    // `-m --first-parent` is what makes a merge commit's patch visible against
    // its first parent (plain `git show <merge> -- <path>` prints nothing).
    const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
    const show = await gitRead(cwd, [
      "show",
      "--format=",
      "-M",
      "-m",
      "--first-parent",
      oid,
      "--",
      ...paths,
    ]);
    if (!show.ok) {
      return fail(hostI18n.t("errors.git.showFailed", { detail: gitError(show, 300) || hostI18n.t("errors.git.notARepo") }));
    }
    const diff = remember(fileDiffCache, cacheKey, show.stdout.slice(0, 500_000));
    ws.send(JSON.stringify({ ...base, ok: true, diff }));
  },
};
