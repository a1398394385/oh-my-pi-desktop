// File and git domain RPC: file page reads (text/image/dir tree), single-file
// diff, git status/branches/write operations.
// Moved over from the main.ts message dispatch (third slice).
import path from "node:path";
import fs from "node:fs";
import { defaultCwd } from "../state.ts";
import { isGitWorktree } from "../session-lifecycle.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";
import { quotePosixPath } from "../bootstrap.ts";
import { resolveRemoteTarget, readUserSshHost } from "../remote-workspaces.ts";
import { runSshCommand, formatSshError, type SshHostConfigShape } from "./ssh.ts";

// Shared by git write operations: argument arrays go straight to the
// subprocess (no shell concatenation, injection-proof by construction); on
// failure stderr is summarized into an error field for the caller's reply
// (no exception blows up the connection); on success stdout/stderr are
// returned
function runGitChecked(cwd: string, args: string[]): { ok: true; stdout: string; stderr: string } | { ok: false; error: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    return { ok: false, error: p.stderr.toString().trim().slice(0, 500) || hostI18n.t("errors.git.commandFailed", { command: args[0], exitCode: p.exitCode }) };
  }
  return { ok: true, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

// paths parameter of git write RPCs: string array, empties dropped
function stringPaths(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter((x) => x.trim()) : [];
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
      const top = Bun.spawnSync(["git", "-C", path.dirname(abs), "rev-parse", "--show-toplevel"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const topLevel = top.exitCode === 0 ? top.stdout.toString().trim() : "";
      if (topLevel && abs.startsWith(topLevel + path.sep)) repoCwd = topLevel;
    }
    const rel = path.relative(path.resolve(repoCwd), abs);
    // The tracked check must use rel (relative to repoCwd): tool calls often
    // pass absolute or repo-root-relative paths; feeding the raw filePath as
    // the pathspec makes git report outside repository — once tracked is
    // misjudged as false, the --no-index fallback renders the whole file as a
    // pure addition (the root cause of diff views disagreeing with +N-M
    // summaries)
    const tracked = Bun.spawnSync(["git", "-C", repoCwd, "ls-files", "--error-unmatch", "--", rel], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const args = tracked.exitCode === 0
      ? ["diff", "HEAD", "--", rel]
      : ["diff", "--no-index", "--", "/dev/null", abs];
    const p = Bun.spawnSync(["git", "-C", repoCwd, ...args], { stdout: "pipe", stderr: "pipe" });
    // exitCode=1 from --no-index with differences is normal
    if (p.exitCode > 1) throw new Error(hostI18n.t("errors.git.diffFailed", { detail: p.stderr.toString().trim().slice(0, 200) }));
    ws.send(
      JSON.stringify({
        type: "file_diff",
        cwd,
        path: filePath,
        diff: p.stdout.toString().slice(0, 500_000),
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
      const q = quotePosixPath(remote.remotePath);
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
      const q = quotePosixPath(remote.remotePath);
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
      const result = await runSshCommand(remote.config, `ls -1ap ${quotePosixPath(remote.remotePath)}`, 8_000);
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
  git_stage(ws, msg) {
    // Stage: git add -- <paths> (argument array passed straight through; -- prevents path injection)
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const r = runGitChecked(cwd, ["add", "--", ...paths]);
    if (!r.ok) ws.send(JSON.stringify({ type: "git_staged", cwd, error: r.error }));
    else ws.send(JSON.stringify({ type: "git_staged", cwd, ok: true }));
  },
  git_unstage(ws, msg) {
    // Unstage: git reset HEAD -- <paths>
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const r = runGitChecked(cwd, ["reset", "HEAD", "--", ...paths]);
    if (!r.ok) ws.send(JSON.stringify({ type: "git_unstaged", cwd, error: r.error }));
    else ws.send(JSON.stringify({ type: "git_unstaged", cwd, ok: true }));
  },
  git_discard(ws, msg) {
    // Discard working-tree changes (destructive, already double-confirmed on
    // the UI side, host executes directly):
    // tracked files restore via checkout --; untracked files delete exactly
    // via clean -f --; per-path processing, any failure replies with the error
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    let err = "";
    for (const p of paths) {
      const tracked = runGitChecked(cwd, ["ls-files", "--error-unmatch", "--", p]);
      const r = tracked.ok ? runGitChecked(cwd, ["checkout", "--", p]) : runGitChecked(cwd, ["clean", "-f", "--", p]);
      if (!r.ok) {
        err = r.error;
        break;
      }
    }
    if (err) ws.send(JSON.stringify({ type: "git_discarded", cwd, error: err }));
    else ws.send(JSON.stringify({ type: "git_discarded", cwd, ok: true }));
  },
  git_commit(ws, msg) {
    // Commit: message goes through the argument array (no shell
    // concatenation, injection-proof); paths omitted = commit everything
    // staged, given = pathspec commit (git auto-stages those paths' changes
    // and commits only them). The reply carries the new commit sha.
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const message = String(msg.message ?? "");
    if (!message.trim()) throw new Error(hostI18n.t("errors.param.missingMessage"));
    const paths = stringPaths(msg.paths);
    const args = ["commit", "-m", message, ...(paths.length > 0 ? ["--", ...paths] : [])];
    const r = runGitChecked(cwd, args);
    if (!r.ok) {
      ws.send(JSON.stringify({ type: "git_committed", cwd, error: r.error }));
      return;
    }
    const sha = runGitChecked(cwd, ["rev-parse", "HEAD"]);
    if (!sha.ok) {
      ws.send(JSON.stringify({ type: "git_committed", cwd, error: sha.error }));
      return;
    }
    ws.send(JSON.stringify({ type: "git_committed", cwd, ok: true, commit: sha.stdout.trim() }));
  },
  git_push(ws, msg) {
    // Push the current branch (no automatic -u): without an upstream git errors, stderr passes through as error
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const r = runGitChecked(cwd, ["push"]);
    if (!r.ok) ws.send(JSON.stringify({ type: "git_pushed", cwd, error: r.error }));
    else {
      // push's progress/result output (branch update lines) lands on stderr; take it as result on success
      ws.send(JSON.stringify({ type: "git_pushed", cwd, ok: true, result: r.stderr.trim() || r.stdout.trim() }));
    }
  },
  get_git_diff(ws, msg) {
    // Changed-files list of the current session's project (for tree/flat display)
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const p = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(hostI18n.t("errors.git.statusFailed", { detail: p.stderr.toString().trim().slice(0, 200) || hostI18n.t("errors.git.notARepo") }));
    const files = p.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        let path = line.slice(3);
        const arrow = path.indexOf(" -> "); // rename: R  old -> new
        if (arrow >= 0) path = path.slice(arrow + 4);
        // Split the XY columns (X = index/staged state, Y = working-tree
        // state) so the UI can decide per-row stage/unstage buttons;
        // untracked (??) is essentially an unstaged new file: count as
        // unstaged, never staged
        const xy = line.slice(0, 2);
        return {
          code: line.slice(0, 2).trim() || "?",
          path,
          staged: xy[0] === " " || xy[0] === "?" ? "" : xy[0],
          unstaged: xy[1] === " " ? "" : xy[1],
        };
      });
    ws.send(JSON.stringify({ type: "git_status", cwd, files }));
  },
  get_git_branches(ws, msg) {
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const isGit = isGitWorktree(cwd);
    if (!isGit) {
      ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: false, current: null, branches: [] }));
      return;
    }
    const currP = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
    let current = currP.stdout.toString().trim();
    if (!current) {
      const headP = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
      current = headP.stdout.toString().trim() || "HEAD";
    }
    const bP = Bun.spawnSync(["git", "-C", cwd, "branch", "--format=%(refname:short)"], { stdout: "pipe", stderr: "ignore" });
    const branches = bP.stdout.toString().split("\n").map((b) => b.trim()).filter(Boolean);
    ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: true, current, branches }));
  },
  switch_git_branch(ws, msg) {
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const targetBranch = String(msg.branch ?? "").trim();
    if (!targetBranch) throw new Error(hostI18n.t("errors.param.missingBranch"));
    const p = Bun.spawnSync(["git", "-C", cwd, "checkout", targetBranch], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) {
      throw new Error(hostI18n.t("errors.git.checkoutFailed", { detail: p.stderr.toString().trim().slice(0, 200) }));
    }
    ws.send(JSON.stringify({ type: "git_branch_switched", cwd, branch: targetBranch }));
  },
};
