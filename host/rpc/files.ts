// 文件与 git 域 RPC：文件页读取（文本/图片/目录树）、单文件 diff、git 状态/分支/写操作。
// 自 main.ts message 分发平移（第三刀）。
import path from "node:path";
import fs from "node:fs";
import { defaultCwd } from "../state.ts";
import { isGitWorktree } from "../session-lifecycle.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

// git 写操作共用：参数数组直传子进程（无 shell 拼接，天然防注入），失败时把 stderr
// 汇总成 error 字段交调用方回包（不抛异常炸连接），成功返回 stdout/stderr
function runGitChecked(cwd: string, args: string[]): { ok: true; stdout: string; stderr: string } | { ok: false; error: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    return { ok: false, error: p.stderr.toString().trim().slice(0, 500) || hostI18n.t("errors.git.commandFailed", { command: args[0], exitCode: p.exitCode }) };
  }
  return { ok: true, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

// git 写操作 RPC 的 paths 参数：字符串数组、去空
function stringPaths(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter((x) => x.trim()) : [];
}

export const filesHandlers: Record<string, RpcHandler> = {
  async get_file_diff(ws, msg) {
    // 单文件详细 diff：tracked 走 git diff HEAD，untracked/仓库外文件用 --no-index 生成纯新增。
    // cwd 外的文件（如 ~/.omp 全局配置）不拒绝：找它自己所在的 git 仓库；不在任何仓库就整文件当新增。
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
    // tracked 检查必须用 rel（相对 repoCwd）：工具调用常给绝对路径或仓库根相对路径，
    // 直接拿原始 filePath 当 pathspec 会让 git 报 outside repository——tracked 误判为
    // false 后走 --no-index 兜底，整个文件被渲染成纯新增（diff 显示与 +N-M 摘要不符的根因）
    const tracked = Bun.spawnSync(["git", "-C", repoCwd, "ls-files", "--error-unmatch", "--", rel], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const args = tracked.exitCode === 0
      ? ["diff", "HEAD", "--", rel]
      : ["diff", "--no-index", "--", "/dev/null", abs];
    const p = Bun.spawnSync(["git", "-C", repoCwd, ...args], { stdout: "pipe", stderr: "pipe" });
    // --no-index 有差异时 exitCode=1 属正常
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
    // 文件页全文件内容（读取行点击 / 文件树点击详情共用）；限 2MB 文本文件
    const p = String(msg.path ?? "");
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
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
    // 图片二进制读取（对话附件预览等）：后缀白名单 + 8MB 上限，base64 回传；
    // 路径校验对齐 read_file 的宽松度（仅要求非空且是文件）
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
    // 文件树单层列表：目录优先、字母序；隐藏 .git/.DS_Store
    const dir = String(msg.path ?? "");
    if (!dir) throw new Error(hostI18n.t("errors.param.missingPath"));
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
    // 暂存：git add -- <paths>（数组参数直传，-- 防路径注入）
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const r = runGitChecked(cwd, ["add", "--", ...paths]);
    if (!r.ok) ws.send(JSON.stringify({ type: "git_staged", cwd, error: r.error }));
    else ws.send(JSON.stringify({ type: "git_staged", cwd, ok: true }));
  },
  git_unstage(ws, msg) {
    // 取消暂存：git reset HEAD -- <paths>
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const paths = stringPaths(msg.paths);
    if (paths.length === 0) throw new Error(hostI18n.t("errors.param.missingPaths"));
    const r = runGitChecked(cwd, ["reset", "HEAD", "--", ...paths]);
    if (!r.ok) ws.send(JSON.stringify({ type: "git_unstaged", cwd, error: r.error }));
    else ws.send(JSON.stringify({ type: "git_unstaged", cwd, ok: true }));
  },
  git_discard(ws, msg) {
    // 丢弃工作区改动（破坏性，UI 侧已二次确认，host 直接执行）：
    // tracked 走 checkout -- 恢复，untracked 走 clean -f -- 精确路径删除；逐路径处理，任一失败即回错
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
    // 提交：message 经数组参数传（无 shell 拼接，防注入）；paths 省略 = 提交全部已暂存，
    // 给定 = pathspec 提交（git 自动暂存这些路径的改动并只提交它们）。回包带新提交 sha。
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
    // 推送当前分支（不自动 -u）：无 upstream 时 git 报错，stderr 透传为 error
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const r = runGitChecked(cwd, ["push"]);
    if (!r.ok) ws.send(JSON.stringify({ type: "git_pushed", cwd, error: r.error }));
    else {
      // push 的进度/结果输出（分支更新行）在 stderr，成功时取作 result
      ws.send(JSON.stringify({ type: "git_pushed", cwd, ok: true, result: r.stderr.trim() || r.stdout.trim() }));
    }
  },
  get_git_diff(ws, msg) {
    // 当前会话 project 的改动文件清单（树/平铺展示用）
    const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
    const p = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(hostI18n.t("errors.git.statusFailed", { detail: p.stderr.toString().trim().slice(0, 200) || hostI18n.t("errors.git.notARepo") }));
    const files = p.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        let path = line.slice(3);
        const arrow = path.indexOf(" -> "); // rename：R  old -> new
        if (arrow >= 0) path = path.slice(arrow + 4);
        // XY 两列拆开（X=暂存区/index 状态，Y=工作区状态），供 UI 行级暂存/取消暂存按钮判定；
        // untracked（??）本质是未暂存的新文件，归 unstaged、不给 staged
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
