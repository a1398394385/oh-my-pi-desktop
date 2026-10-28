// File and git domain RPC: file page reads (text/image/dir tree), single-file
// diff, git status/branches/write operations.
// Moved over from the main.ts message dispatch (third slice).
//
// Git argv/env/timeout all come from host/git.ts — this file holds only git
// *semantics* (which command, what to do with the output), so the process-level
// guards cannot drift per call site.
import path from "node:path";
import fs from "node:fs";
import { defaultCwd } from "../state.ts";
import { hostI18n } from "../i18n/host.ts";
import type { RpcHandler } from "./types";
import { quotePosixArgument } from "../bootstrap.ts";
import { resolveRemoteTarget, readUserSshHost } from "../remote-workspaces.ts";
import { runSshCommand, formatSshError, type SshHostConfigShape } from "./ssh.ts";
import { forEachRef, gitError, gitRead, gitWrite, isGitWorktree, operationState, type GitOperationState } from "../git.ts";
import { applyLines, type GitRunner } from "../git-patch.ts";
import type { GitStatusFile } from "../wire/payloads.ts";
import { generatedByName, generatedByHeader } from "../git-generated.ts";

// paths parameter of git write RPCs: string array, empties dropped
function stringPaths(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter((x) => x.trim()) : [];
}

/**
 * Line-level request of the git write RPCs: a single path plus new-side line
 * numbers (1-based). Absent or empty means the whole-file form.
 */
function lineSelection(msg: unknown): { path: string; lines: number[] } | null {
  if (!msg || typeof msg !== "object") return null;
  const { path: rawPath, lines: rawLines } = msg as { path?: unknown; lines?: unknown };
  const p = typeof rawPath === "string" ? rawPath.trim() : "";
  const lines = Array.isArray(rawLines)
    ? rawLines.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
    : [];
  return p && lines.length > 0 ? { path: p, lines } : null;
}

/** The two locking classes git-patch.ts needs, bound to one repo. */
function gitRunner(cwd: string): GitRunner {
  return {
    read: (args, input) => gitRead(cwd, args, { input }),
    write: (args, input) => gitWrite(cwd, args, { input }),
  };
}

/** First lines of a working-tree file, or null when absent, binary or huge. */
function readHeadLines(absPath: string): string[] | null {
  const stat = fs.statSync(absPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 1_000_000) return null;
  const buf = Buffer.alloc(8000);
  const fd = fs.openSync(absPath, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const bytes = buf.subarray(0, read);
  if (bytes.includes(0)) return null; // binary: never a generated header
  return bytes.toString("utf8").split("\n").slice(0, 5);
}

/** Unmerged porcelain XY codes: both sides differ and the file needs resolving. */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Repository state that forbids an operation, with the reason to show.
 * `stage` and `commit` are deliberately absent: marking a conflict resolved and
 * finishing a rebase/merge are exactly what those two are for.
 */
function refusalFor(state: GitOperationState, op: "unstage" | "discard" | "checkout"): string | null {
  if (state === "NORMAL" || state === "DETACHED_HEAD") return null;
  const name = hostI18n.t(`errors.git.opState.${state}` as any);
  return hostI18n.t(`errors.git.refusedDuringOp` as any, { op: hostI18n.t(`errors.git.op.${op}` as any), state: name });
}

async function checkAllowed(cwd: string, op: "unstage" | "discard" | "checkout"): Promise<string | null> {
  return refusalFor(await operationState(cwd), op);
}

// Remote-workspace branch shared by the file RPCs: a local path inside a stub
// resolves to the host config (from user-scope ssh.json) plus the remote POSIX
// path; null keeps the caller on the plain local-fs path.
async function remoteTargetFor(localPath: string): Promise<{ config: SshHostConfigShape; remotePath: string } | null> {
  const target = resolveRemoteTarget(localPath);
  if (!target) return null;
  const config = await readUserSshHost(target.host);
  if (!config) throw new Error(hostI18n.t("errors.ssh.hostNotFound", { name: target.host }));
  return { config, remotePath: target.remotePath };
}

export const filesHandlers: Record<string, RpcHandler> = {
  async get_file_diff(ws, msg) {
    // Detailed single-file diff: tracked files go through git diff HEAD;
    // untracked/out-of-repo files use --no-index to render a pure addition.
    // Files outside cwd (e.g. ~/.omp global config) are not rejected: locate
    // the git repo they live in; outside any repo, the whole file renders as
    // an addition.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const filePath = String(msg.path ?? "");
    if (!filePath) throw new Error(hostI18n.t("errors.param.missingPath"));
    const abs = path.resolve(cwd, filePath);
    let repoCwd = cwd;
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) {
      const top = await gitRead(path.dirname(abs), ["rev-parse", "--show-toplevel"]);
      const topLevel = top.ok ? top.stdout.trim() : "";
      if (topLevel && abs.startsWith(topLevel + path.sep)) repoCwd = topLevel;
    }
    const rel = path.relative(path.resolve(repoCwd), abs);
    // The tracked check must use rel (relative to repoCwd): tool calls often
    // pass absolute or repo-root-relative paths; feeding the raw filePath as
    // the pathspec makes git report outside repository — once tracked is
    // misjudged as false, the --no-index fallback renders the whole file as a
    // pure addition (the root cause of diff views disagreeing with +N-M
    // summaries)
    const tracked = await gitRead(repoCwd, ["ls-files", "--error-unmatch", "--", rel]);
    const args = tracked.ok
      ? ["diff", "HEAD", "--", rel]
      : ["diff", "--no-index", "--", "/dev/null", abs];
    const p = await gitRead(repoCwd, args);
    // exitCode=1 from --no-index with differences is normal
    if ((p.code ?? 0) > 1) throw new Error(hostI18n.t("errors.git.diffFailed", { detail: gitError(p, 200) }));
    ws.send(
      JSON.stringify({
        type: "file_diff",
        cwd,
        path: filePath,
        diff: p.stdout.slice(0, 500_000),
      }),
    );
  },
  async read_file(ws, msg) {
    // Full file content for the file page (shared by read-line clicks / file-tree click details); text files capped at 2MB
    const p = String(msg.path ?? "");
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    const remote = await remoteTargetFor(p);
    if (remote) {
      // Same caps as the local branch: 2MB text limit + NUL sniff on the head
      const q = quotePosixArgument(remote.remotePath);
      const size = await runSshCommand(remote.config, `wc -c < ${q}`, 8_000);
      if (size.code !== 0) throw new Error(formatSshError(size.stderr, size.stdout, size.code));
      const bytes = Number(size.stdout.trim());
      if (bytes > 2_000_000) {
        ws.send(JSON.stringify({ type: "file_content", path: p, error: hostI18n.t("errors.file.tooLarge", { size: (bytes / 1e6).toFixed(1) }) }));
        return;
      }
      const cat = await runSshCommand(remote.config, `cat ${q}`, 20_000);
      if (cat.code !== 0) throw new Error(formatSshError(cat.stderr, cat.stdout, cat.code));
      if (cat.stdout.slice(0, 8000).includes("\0")) {
        ws.send(JSON.stringify({ type: "file_content", path: p, error: hostI18n.t("errors.file.binaryNoPreview") }));
        return;
      }
      ws.send(JSON.stringify({ type: "file_content", path: p, text: cat.stdout }));
      return;
    }
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(hostI18n.t("errors.file.notAFile", { path: p }));
    if (stat.size > 2_000_000) {
      ws.send(JSON.stringify({ type: "file_content", path: p, error: hostI18n.t("errors.file.tooLarge", { size: (stat.size / 1e6).toFixed(1) }) }));
      return;
    }
    const buf = await fs.promises.readFile(p);
    const head = buf.subarray(0, 8000);
    if (head.includes(0)) {
      ws.send(JSON.stringify({ type: "file_content", path: p, error: hostI18n.t("errors.file.binaryNoPreview") }));
      return;
    }
    ws.send(JSON.stringify({ type: "file_content", path: p, text: buf.toString("utf8") }));
  },
  async read_image(ws, msg) {
    // Image binary read (conversation attachment previews etc.): extension
    // whitelist + 8MB cap, returned as base64;
    // path validation matches read_file's looseness (only requires non-empty
    // and is-a-file)
    const p = String(msg.path ?? "");
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    const MIME: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
    };
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!(ext in MIME)) {
      ws.send(JSON.stringify({ type: "image_content", path: p, error: hostI18n.t("errors.image.unsupportedFormat", { ext: ext || hostI18n.t("errors.image.noExtension") }) }));
      return;
    }
    const remote = await remoteTargetFor(p);
    if (remote) {
      const q = quotePosixArgument(remote.remotePath);
      const size = await runSshCommand(remote.config, `wc -c < ${q}`, 8_000);
      if (size.code !== 0) throw new Error(formatSshError(size.stderr, size.stdout, size.code));
      const bytes = Number(size.stdout.trim());
      if (bytes > 8_000_000) {
        ws.send(JSON.stringify({ type: "image_content", path: p, error: hostI18n.t("errors.image.tooLarge", { size: (bytes / 1e6).toFixed(1) }) }));
        return;
      }
      // GNU base64 wraps at 76 columns (macOS never does): strip all whitespace for the data URL
      const b64 = await runSshCommand(remote.config, `base64 < ${q}`, 30_000);
      if (b64.code !== 0) throw new Error(formatSshError(b64.stderr, b64.stdout, b64.code));
      ws.send(JSON.stringify({ type: "image_content", path: p, mime: MIME[ext], data: b64.stdout.replace(/\s+/g, "") }));
      return;
    }
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      ws.send(JSON.stringify({ type: "image_content", path: p, error: hostI18n.t("errors.file.notAFile", { path: p }) }));
      return;
    }
    if (stat.size > 8_000_000) {
      ws.send(JSON.stringify({ type: "image_content", path: p, error: hostI18n.t("errors.image.tooLarge", { size: (stat.size / 1e6).toFixed(1) }) }));
      return;
    }
    const buf = await fs.promises.readFile(p);
    ws.send(JSON.stringify({ type: "image_content", path: p, mime: MIME[ext], data: buf.toString("base64") }));
  },
  async list_dir(ws, msg) {
    // Single-level file tree listing: directories first, alphabetical; hides .git/.DS_Store
    const dir = String(msg.path ?? "");
    if (!dir) throw new Error(hostI18n.t("errors.param.missingPath"));
    const remote = await remoteTargetFor(dir);
    if (remote) {
      // ls -1ap marks directories with a trailing "/"; the reply echoes the local
      // stub path so the frontend tree cache keys keep matching
      const result = await runSshCommand(remote.config, `ls -1ap ${quotePosixArgument(remote.remotePath)}`, 8_000);
      if (result.code !== 0) throw new Error(formatSshError(result.stderr, result.stdout, result.code));
      const entries: { name: string; dir: boolean }[] = [];
      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "./" || trimmed === "../") continue;
        const isDir = trimmed.endsWith("/");
        const name = isDir ? trimmed.slice(0, -1) : trimmed;
        if (!name || name === ".git" || name === ".DS_Store") continue;
        entries.push({ name, dir: isDir });
      }
      entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      ws.send(JSON.stringify({ type: "dir_list", path: dir, entries }));
      return;
    }
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw new Error(hostI18n.t("errors.file.notADirectory", { path: dir }));
    const entries: { name: string; dir: boolean }[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".DS_Store") continue;
      entries.push({ name: e.name, dir: e.isDirectory() });
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    ws.send(JSON.stringify({ type: "dir_list", path: dir, entries }));
  },
  async git_stage(ws, msg) {
    // Stage: git add -- <paths> (argument array passed straight through; -- prevents path injection).
    // Deliberately NOT blocked mid-rebase/merge: `git add` on a resolved conflict is
    // how the user finishes that operation.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const line = lineSelection(msg);
    if (line) {
      const error = await applyLines(gitRunner(cwd), cwd, line.path, line.lines, "stage");
      ws.send(JSON.stringify(error ? { type: "git_staged", cwd, error } : { type: "git_staged", cwd, ok: true }));
      return;
    }
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const r = await gitWrite(cwd, ["add", "--", ...paths]);
    ws.send(JSON.stringify(r.ok ? { type: "git_staged", cwd, ok: true } : { type: "git_staged", cwd, error: gitError(r) }));
  },
  async git_unstage(ws, msg) {
    // Unstage: git reset HEAD -- <paths>. Refused while a rebase/merge is open —
    // resetting the index there silently rewrites the operation's own state.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const line = lineSelection(msg);
    if (line) {
      const refused = await checkAllowed(cwd, "unstage");
      if (refused) {
        ws.send(JSON.stringify({ type: "git_unstaged", cwd, error: refused }));
        return;
      }
      const error = await applyLines(gitRunner(cwd), cwd, line.path, line.lines, "unstage");
      ws.send(JSON.stringify(error ? { type: "git_unstaged", cwd, error } : { type: "git_unstaged", cwd, ok: true }));
      return;
    }
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const refused = await checkAllowed(cwd, "unstage");
    if (refused) {
      ws.send(JSON.stringify({ type: "git_unstaged", cwd, error: refused }));
      return;
    }
    const r = await gitWrite(cwd, ["reset", "HEAD", "--", ...paths]);
    ws.send(JSON.stringify(r.ok ? { type: "git_unstaged", cwd, ok: true } : { type: "git_unstaged", cwd, error: gitError(r) }));
  },
  async git_discard(ws, msg) {
    // Discard working-tree changes (destructive, already double-confirmed on
    // the UI side, host executes directly): tracked files restore via one
    // batched checkout --, untracked files delete via one batched clean -f --
    // (same shape as git_stage; a per-path loop costs 2 spawns per file).
    // One ls-files -z run partitions the list; a pathspec naming a directory
    // still counts as tracked when any listed file sits beneath it.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const line = lineSelection(msg);
    if (line) {
      const refused = await checkAllowed(cwd, "discard");
      if (refused) {
        ws.send(JSON.stringify({ type: "git_discarded", cwd, error: refused }));
        return;
      }
      const error = await applyLines(gitRunner(cwd), cwd, line.path, line.lines, "discard");
      ws.send(JSON.stringify(error ? { type: "git_discarded", cwd, error } : { type: "git_discarded", cwd, ok: true }));
      return;
    }
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const refused = await checkAllowed(cwd, "discard");
    if (refused) {
      ws.send(JSON.stringify({ type: "git_discarded", cwd, error: refused }));
      return;
    }
    // ls-files failure mirrors the old per-path fallback: treat everything as
    // untracked and let clean -f surface the real error.
    const listed = await gitRead(cwd, ["ls-files", "-z", "--", ...paths]);
    const trackedFiles = listed.ok ? listed.stdout.split("\0").filter(Boolean) : [];
    const trackedNames = new Set<string>();
    const trackedDirs = new Set<string>();
    for (const f of trackedFiles) {
      trackedNames.add(f);
      for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) trackedDirs.add(f.slice(0, i));
    }
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const p of paths) (trackedNames.has(p) || trackedDirs.has(p) ? tracked : untracked).push(p);
    let err = "";
    if (tracked.length > 0) {
      const r = await gitWrite(cwd, ["checkout", "--", ...tracked]);
      if (!r.ok) err = gitError(r);
    }
    if (!err && untracked.length > 0) {
      const r = await gitWrite(cwd, ["clean", "-f", "--", ...untracked]);
      if (!r.ok) err = gitError(r);
    }
    ws.send(JSON.stringify(err ? { type: "git_discarded", cwd, error: err } : { type: "git_discarded", cwd, ok: true }));
  },
  async git_commit(ws, msg) {
    // Commit: message goes through the argument array (no shell
    // concatenation, injection-proof); paths omitted = commit everything
    // staged, given = pathspec commit (git auto-stages those paths' changes
    // and commits only them). The reply carries the new commit sha.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const message = String(msg.message ?? "");
    if (!message.trim()) throw new Error(hostI18n.t("errors.param.missingMessage"));
    const paths = stringPaths(msg.paths);
    const args = ["commit", "-m", message, ...(paths.length > 0 ? ["--", ...paths] : [])];
    const r = await gitWrite(cwd, args);
    if (!r.ok) {
      ws.send(JSON.stringify({ type: "git_committed", cwd, error: gitError(r) }));
      return;
    }
    const sha = await gitRead(cwd, ["rev-parse", "HEAD"]);
    if (!sha.ok) {
      ws.send(JSON.stringify({ type: "git_committed", cwd, error: gitError(sha) }));
      return;
    }
    ws.send(JSON.stringify({ type: "git_committed", cwd, ok: true, commit: sha.stdout.trim() }));
  },
  async git_push(ws, msg) {
    // Push the current branch. A branch with no upstream is the common failure:
    // name the fix instead of letting git's bare "no upstream branch" surface.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const refs = await forEachRef(cwd);
    const head = refs.find((r) => r.isHead);
    if (!head) {
      ws.send(JSON.stringify({ type: "git_pushed", cwd, error: hostI18n.t("errors.git.noCommitsYet") }));
      return;
    }
    if (!head.upstream) {
      ws.send(JSON.stringify({ type: "git_pushed", cwd, error: hostI18n.t("errors.git.noUpstream", { branch: head.short }) }));
      return;
    }
    const r = await gitWrite(cwd, ["push"]);
    if (!r.ok) {
      ws.send(JSON.stringify({ type: "git_pushed", cwd, error: gitError(r) }));
      return;
    }
    // push's progress/result output (branch update lines) lands on stderr; take it as result on success
    ws.send(JSON.stringify({
      type: "git_pushed",
      cwd,
      ok: true,
      result: r.stderr.trim() || r.stdout.trim() || hostI18n.t("notify.pushed"),
    }));
  },
  async get_git_diff(ws, msg) {
    // Changed-files list of the current session's project (for tree/flat display).
    // `--porcelain -z` (not `--short`): NUL-delimited records carry the path
    // verbatim, so a non-ASCII filename arrives as text instead of git's
    // octal-escaped quoted form — which would render as garbage in the UI and
    // make stage/unstage fail against a path that does not exist on disk.
    // `--porcelain=v2` additionally reports a rename as one `2 ` record naming
    // its source, and its `# branch.ab` header carries ahead/behind.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const p = await gitRead(cwd, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    if (!p.ok) {
      throw new Error(hostI18n.t("errors.git.statusFailed", {
        detail: gitError(p, 200) || hostI18n.t("errors.git.notARepo"),
      }));
    }
    const files: GitStatusFile[] = [];
    let ahead = 0;
    let behind = 0;
    let upstream = "";
    // One NUL per record; split keeps empty tails out.
    const recs = p.stdout.split("\0");
    const addFile = (code: string, filePath: string, origPath?: string) => {
      const [x, y] = code;
      files.push({
        code,
        path: filePath,
        ...(origPath ? { origPath } : {}),
        staged: x === " " || x === "?" ? "" : x,
        unstaged: y === " " ? "" : y,
        conflict: CONFLICT_CODES.has(code),
        generated: false,
        fingerprint: "",
      });
    };
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (!rec) continue;
      if (rec.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(rec);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
        continue;
      }
      if (rec.startsWith("# branch.upstream ")) {
        upstream = rec.slice("# branch.upstream ".length);
        continue;
      }
      if (rec[0] === "#") continue;
      if (rec[0] === "?") {
        addFile("??", rec.slice(2));
        continue;
      }
      if (rec[0] === "!") continue;
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const kind = rec[0];
      const pathAt = kind === "1" ? 8 : kind === "u" ? 10 : 9;
      const parts = rec.split(" ");
      // v2 writes "." for an unchanged column; the frame keeps v1's " " so the
      // UI's badge letters and staged/unstaged semantics stay as they were.
      const code = parts[1]?.replace(/\./g, " ");
      // Anything shorter is a format change we must not silently mis-slice
      // (git4idea treats the same case as a hard error).
      if ((kind !== "1" && kind !== "2" && kind !== "u") || !code || code.length !== 2 || parts.length <= pathAt) {
        throw new Error(hostI18n.t("errors.git.statusFailed", { detail: hostI18n.t("errors.git.statusMalformed", { line: rec }) }));
      }
      // A `2 ` record's source path is the next NUL field, not part of this one.
      addFile(code, parts.slice(pathAt).join(" "), kind === "2" ? recs[++i] : undefined);
    }

    // Generated: the name table needs no IO, the file's first lines and the
    // repository's linguist-generated attribute do (one batch for all paths).
    const byName = new Set(files.filter((f) => generatedByName(f.path)).map((f) => f.path));
    const byHeader = new Set<string>();
    for (const f of files) {
      if (byName.has(f.path)) continue;
      const head = readHeadLines(path.join(cwd, f.path));
      if (head && generatedByHeader(head)) byHeader.add(f.path);
    }
    const byAttr = new Set<string>();
    if (files.length > 0) {
      const attr = await gitRead(cwd, ["check-attr", "-z", "--stdin", "linguist-generated"], {
        input: files.map((f) => f.path).join("\0"),
      });
      if (attr.ok) {
        const t = attr.stdout.split("\0");
        for (let i = 0; i + 2 < t.length; i += 3) if (t[i + 2] === "set" || t[i + 2] === "true") byAttr.add(t[i]);
      }
    }

    // Fingerprint: the blob oid the row's content hashes to. Rows with unstaged
    // edits hash the working tree in one batched call, the rest reuse the index
    // blob; a row whose content cannot be hashed keeps "".
    const indexOid = new Map<string, string>();
    const ls = await gitRead(cwd, ["ls-files", "-s", "-z"]);
    if (ls.ok) {
      for (const rec of ls.stdout.split("\0")) {
        const tab = rec.indexOf("\t");
        if (tab > 0) indexOid.set(rec.slice(tab + 1), rec.slice(0, tab).split(" ")[1]);
      }
    }
    const workPaths = files
      .filter((f) => f.unstaged !== "" || f.code === "??")
      .map((f) => f.path)
      .filter((rel) => fs.statSync(path.join(cwd, rel), { throwIfNoEntry: false })?.isFile() === true);
    const workOid = new Map<string, string>();
    if (workPaths.length > 0) {
      // shortcut: --stdin-paths pairs one oid per line, so a path containing a
      // newline would shift the results; such paths just lose their fingerprint.
      const h = await gitRead(cwd, ["hash-object", "--stdin-paths"], { input: workPaths.map((w) => `${w}\n`).join("") });
      if (h.ok) h.stdout.split("\n").forEach((oid, i) => {
        if (oid && workPaths[i]) workOid.set(workPaths[i], oid);
      });
    }
    for (const f of files) {
      f.generated = byName.has(f.path) || byHeader.has(f.path) || byAttr.has(f.path);
      f.fingerprint = workOid.get(f.path)
        ?? (f.unstaged !== "" || f.code === "??" ? "" : indexOid.get(f.path) ?? "");
    }
    ws.send(JSON.stringify({ type: "git_status", cwd, files, state: await operationState(cwd), ahead, behind, upstream }));
  },
  async get_git_branches(ws, msg) {
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    if (!(await isGitWorktree(cwd))) {
      ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: false, current: null, branches: [], remotes: [] }));
      return;
    }
    // One for-each-ref for everything: the refname prefix tells local from
    // remote (a "/" test on the short name misreads "feat/login" as a remote),
    // and %(HEAD) marks the checked-out ref — absent means detached HEAD.
    const refs = await forEachRef(cwd);
    const branches = refs.filter((r) => r.kind === "local").map((r) => r.short);
    // Remote-tracking refs (local refs/remotes snapshot, no network): "origin/xxx" form;
    // symbolic origin/HEAD entries are dropped
    const remotes = refs.filter((r) => r.kind === "remote").map((r) => r.short).filter((b) => !b.endsWith("/HEAD"));
    const head = refs.find((r) => r.isHead);
    let current = head?.short ?? "";
    let detached = false;
    if (!current) {
      // No ref carries %(HEAD): either detached at a commit, or a branch with no
      // commit yet (unborn). An unborn branch still names a branch, so ask for it
      // directly instead of showing an oid as if it were a branch.
      const sym = await gitRead(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
      const unborn = sym.ok ? sym.stdout.trim() : "";
      if (unborn) {
        current = unborn;
      } else {
        detached = true;
        const headOid = await gitRead(cwd, ["rev-parse", "--short", "HEAD"]);
        current = headOid.ok ? headOid.stdout.trim() : "HEAD";
      }
    }
    ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: true, current, branches, remotes, detached }));
  },
  async switch_git_branch(ws, msg) {
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const targetBranch = String(msg.branch ?? "").trim();
    if (!targetBranch) throw new Error(hostI18n.t("errors.param.missingBranch"));
    const refused = await checkAllowed(cwd, "checkout");
    if (refused) throw new Error(refused);
    // Local-vs-remote comes from the refname prefix, never from a "/" test on
    // the short name: "feat/login" is a perfectly ordinary local branch, and
    // `checkout --track feat/login` would not fail — it would quietly create a
    // second branch "login" tracking it and leave the user on the wrong one.
    const refs = await forEachRef(cwd);
    const local = refs.find((r) => r.kind === "local" && r.short === targetBranch);
    let args: string[];
    let branch: string;
    if (local) {
      args = ["checkout", targetBranch];
      branch = targetBranch;
    } else {
      const remote = refs.find((r) => r.kind === "remote" && r.short === targetBranch);
      if (!remote) throw new Error(hostI18n.t("errors.git.unknownBranch", { branch: targetBranch }));
      // DWIM: a remote-tracking ref checks out as a local branch named after the
      // part below the remote. If that branch already exists, switch to it
      // rather than re-creating a duplicate.
      const name = remote.short.slice(remote.short.indexOf("/") + 1);
      branch = name;
      args = refs.some((r) => r.kind === "local" && r.short === name)
        ? ["checkout", name]
        : ["checkout", "--track", remote.short];
    }
    const p = await gitWrite(cwd, args);
    if (!p.ok) {
      throw new Error(hostI18n.t("errors.git.checkoutFailed", { detail: gitError(p, 200) }));
    }
    ws.send(JSON.stringify({ type: "git_branch_switched", cwd, branch }));
  },
};
