// Side-by-side compare data for the Git page: both versions of one file plus the
// patch that pairs with them, in one round trip.
//
// The patch asks git for a huge context (`--unified=999999`) so its hunks cover
// the whole file. The renderer builds aligned rows from the hunks alone, and a
// three-line-context diff would leave it unable to place unchanged lines.
//
// Three sources, selected by the request shape:
//   oid given        → the commit's own change (`oid^` vs `oid`), first-parent for merges
//   staged: true     → index change (`HEAD` vs index)
//   neither          → worktree change (index vs the file on disk)
//
// `./` inside the object spec makes the path relative to the caller's cwd, so a
// repository opened from a subdirectory reads the same file `git status` listed.
// A missing object (root commit, newly added or deleted file) is an empty side,
// not an error: the compare view shows a blank half instead of failing.
//
// Commit contents never change, so those replies are memoized by
// (cwd, oid, path, oldPath); worktree/index reads always run fresh.
import fs from "node:fs";
import path from "node:path";
import { hostI18n } from "../i18n/host.ts";
import type { RpcHandler } from "./types";
import { gitError, gitRead } from "../git.ts";

/** One side / the patch: same order as the per-file diff cap in git-graph.ts. */
const MAX_TEXT_CHARS = 500_000;
/** Resident compare payloads (commit mode only; worktree reads are never cached). */
const MAX_CACHED_VERSIONS = 64;

function reqIdOf(msg: Record<string, unknown>): number {
  const n = Number(msg.reqId);
  return Number.isFinite(n) ? n : 0;
}

function clip(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}

/** `<rev>:./<path>`; an empty rev reads the index (`:./path`). Missing object → "". */
async function showBlob(cwd: string, rev: string, filePath: string): Promise<string> {
  const r = await gitRead(cwd, ["show", `${rev}:./${filePath}`]);
  return r.ok ? r.stdout : "";
}

/** The file on disk under `cwd`; a file deleted in the worktree yields "". */
async function readWorktree(cwd: string, filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(path.join(cwd, filePath), "utf8");
  } catch {
    return "";
  }
}

interface VersionsPayload {
  oldText: string;
  newText: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

const versionsCache = new Map<string, VersionsPayload>();

export const gitCompareHandlers: Record<string, RpcHandler> = {
  async git_file_versions(ws, msg) {
    const reqId = reqIdOf(msg);
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    const filePath = String(msg.path ?? "");
    const oid = String(msg.oid ?? "").trim();
    const oldPath = String(msg.oldPath ?? "");
    const staged = msg.staged === true;
    const base = { type: "file_versions", reqId, cwd, oid, path: filePath };
    const fail = (error: string) => ws.send(JSON.stringify({ ...base, ok: false, error }));
    if (!cwd) return fail(hostI18n.t("errors.param.missingPath"));
    if (!filePath) return fail(hostI18n.t("errors.param.missingPath"));
    if (oid && !/^[0-9a-fA-F]{4,40}$/.test(oid)) return fail(hostI18n.t("errors.git.badCommit", { oid }));

    const cacheKey = oid ? `${cwd}\x00${oid}\x00${filePath}\x00${oldPath}` : "";
    const cached = oid ? versionsCache.get(cacheKey) : undefined;
    if (cached) {
      ws.send(JSON.stringify({ ...base, ok: true, ...cached }));
      return;
    }

    let oldText: string;
    let newText: string;
    let patch: string;
    if (oid) {
      // `-m --first-parent`: a merge commit diffs against its first parent, same
      // rule as git_commit_file_diff, so the file rows and the patch agree.
      const sourcePath = oldPath || filePath;
      const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
      const show = await gitRead(cwd, [
        "show",
        "--format=",
        "--unified=999999",
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
      oldText = await showBlob(cwd, `${oid}^`, sourcePath);
      newText = await showBlob(cwd, oid, filePath);
      patch = show.stdout;
    } else if (staged) {
      const diff = await gitRead(cwd, ["diff", "--cached", "--unified=999999", "-M", "--", filePath]);
      if (!diff.ok) {
        return fail(hostI18n.t("errors.git.diffFailed", { detail: gitError(diff, 300) || hostI18n.t("errors.git.notARepo") }));
      }
      oldText = await showBlob(cwd, "HEAD", filePath);
      newText = await showBlob(cwd, "", filePath);
      patch = diff.stdout;
    } else {
      const diff = await gitRead(cwd, ["diff", "--unified=999999", "-M", "--", filePath]);
      if (!diff.ok) {
        return fail(hostI18n.t("errors.git.diffFailed", { detail: gitError(diff, 300) || hostI18n.t("errors.git.notARepo") }));
      }
      oldText = await showBlob(cwd, "", filePath);
      newText = await readWorktree(cwd, filePath);
      patch = diff.stdout;
    }

    // An untracked file has no diff at all; its compare view is still useful
    // (empty left half, whole file on the right), so a missing patch is fine.
    const binary = oldText.slice(0, 8000).includes("\0") || newText.slice(0, 8000).includes("\0");
    let payload: VersionsPayload;
    if (binary) {
      payload = { oldText: "", newText: "", patch: "", binary: true, truncated: false };
    } else {
      const oldSide = clip(oldText);
      const newSide = clip(newText);
      const patchSide = clip(patch);
      payload = {
        oldText: oldSide.text,
        newText: newSide.text,
        patch: patchSide.text,
        binary: false,
        truncated: oldSide.truncated || newSide.truncated || patchSide.truncated,
      };
    }
    if (oid) {
      if (versionsCache.size >= MAX_CACHED_VERSIONS) {
        const oldest = versionsCache.keys().next();
        if (!oldest.done) versionsCache.delete(oldest.value);
      }
      versionsCache.set(cacheKey, payload);
    }
    ws.send(JSON.stringify({ ...base, ok: true, ...payload }));
  },
};
