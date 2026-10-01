// Git 与文件链路冒烟：右栏 Git Diff 页 + 分支选择器 + 文件页（read/list/diff）。
// 用法：bun scripts/smoke-git-files.ts [宿主ws地址]
// 断言覆盖：
//   1. get_git_branches：isGit/current/branches（临时仓库 main）
//   2. get_git_diff：改动清单含已修改(M)与未跟踪(??)文件
//   3. read_file：file_content 透传文本内容
//   4. list_dir：dir_list 目录优先字母序、隐藏 .git
//   5. get_file_diff：tracked 走 git diff HEAD、untracked 走 --no-index 纯新增
//   6. switch_git_branch：切换回执 + 再查 current 已变、切回 main
// 零模型调用，跑完即退。
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
let repoDir = "";

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  if (repoDir) execSync(`rm -rf ${JSON.stringify(repoDir)}`);
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, // fixture-only host: git calls dodge the global hooksPath too
    stdio: ["ignore", "pipe", "inherit"],
  });
  wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
    child!.stdout!.setEncoding("utf8");
    child!.stdout!.on("data", function onLine(chunk) {
      const m = chunk.match(/READY (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        child!.stdout!.off("data", onLine);
        resolve(m[1]);
      }
    });
  }).catch((e) => fail(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

// fixture：临时 git 仓库，main 分支一个基线提交
// Isolate the fixture from the user's global git config: global core.hooksPath (~/.git-hooks) ships a
// git-lfs post-checkout hook, and git-lfs is not on PATH here — any checkout exits 1 without this.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@test", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@test" };
repoDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-git-"));
const g = (cmd: string) => execSync(`git -C ${JSON.stringify(repoDir)} ${cmd}`, { env: gitEnv });
g("init -b main");
await writeFile(path.join(repoDir, "a.txt"), "line1\nline2\n");
await writeFile(path.join(repoDir, "sub_b.txt"), "keep\n");
g("add .");
g("commit -m base");

const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("60s 内未完成全部断言"), 60_000);
const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
  console.log("✓ " + msg);
};

const frames: any[] = [];
const waitType = (t: string, after = 0, ms = 15_000) =>
  new Promise<any>((resolve, reject) => {
    const idx = () => frames.findIndex((f, i) => f.type === t && i >= after);
    if (idx() >= 0) return resolve(frames[idx()]);
    const timer = setTimeout(() => reject(new Error(`等待 ${t} 超时`)), ms);
    const iv = setInterval(() => {
      const i = idx();
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(iv);
        resolve(frames[i]);
      }
    }, 20);
  });

ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws 连接失败"));
}).catch((e) => fail(String(e)));
await waitType("ready");

// ---- 断言 1：分支查询 ----
let mark = frames.length;
ws.send(JSON.stringify({ type: "get_git_branches", cwd: repoDir }));
let br = await waitType("git_branches", mark).catch((e) => fail(String(e)));
assert(br.isGit === true && br.current === "main" && (br.branches ?? []).includes("main"), `get_git_branches isGit=${br.isGit} current=${br.current}`);

// 造改动：a.txt 修改 + untracked.txt 新增
await writeFile(path.join(repoDir, "a.txt"), "line1\nline2-changed\n");
await writeFile(path.join(repoDir, "untracked.txt"), "new file\n");

// ---- 断言 2：改动清单 ----
mark = frames.length;
ws.send(JSON.stringify({ type: "get_git_diff", cwd: repoDir }));
const st = await waitType("git_status", mark).catch((e) => fail(String(e)));
const stPaths = (st.files ?? []).map((f: any) => f.path);
const aCode = (st.files ?? []).find((f: any) => f.path === "a.txt")?.code;
const uCode = (st.files ?? []).find((f: any) => f.path === "untracked.txt")?.code;
assert(aCode === "M" && uCode === "??", `get_git_diff a.txt=${aCode} untracked.txt=${uCode}（清单: ${stPaths.join(",")}）`);

// ---- 断言 3：read_file ----
mark = frames.length;
ws.send(JSON.stringify({ type: "read_file", path: path.join(repoDir, "a.txt") }));
const fc = await waitType("file_content", mark).catch((e) => fail(String(e)));
assert(!fc.error && String(fc.text).includes("line2-changed"), `read_file 透传内容（error=${fc.error ?? "无"}）`);

// ---- 断言 4：list_dir ----
mark = frames.length;
ws.send(JSON.stringify({ type: "list_dir", path: repoDir }));
const dl = await waitType("dir_list", mark).catch((e) => fail(String(e)));
const names = (dl.entries ?? []).map((e: any) => e.name);
assert(
  names.includes("a.txt") && names.includes("untracked.txt") && !names.includes(".git") && (dl.entries ?? []).every((e: any) => typeof e.dir === "boolean"),
  `list_dir entries=[${names.join(",")}]（无 .git）`,
);

// ---- 断言 5：单文件 diff（tracked 与 untracked 两条路径）----
mark = frames.length;
ws.send(JSON.stringify({ type: "get_file_diff", cwd: repoDir, path: "a.txt" }));
const fd = await waitType("file_diff", mark).catch((e) => fail(String(e)));
assert(String(fd.diff).includes("-line2") && String(fd.diff).includes("+line2-changed"), "get_file_diff tracked 走 git diff HEAD");

mark = frames.length;
ws.send(JSON.stringify({ type: "get_file_diff", cwd: repoDir, path: "untracked.txt" }));
const fd2 = await waitType("file_diff", mark).catch((e) => fail(String(e)));
assert(String(fd2.diff).includes("+new file"), "get_file_diff untracked 走 --no-index 纯新增");

// ---- 断言 6：分支切换 ----
g("checkout -b feature");
mark = frames.length;
ws.send(JSON.stringify({ type: "switch_git_branch", cwd: repoDir, branch: "main" }));
const sw = await waitType("git_branch_switched", mark).catch((e) => fail(String(e)));
assert(sw.branch === "main", `switch_git_branch 回执 branch=${sw.branch}`);
mark = frames.length;
ws.send(JSON.stringify({ type: "get_git_branches", cwd: repoDir }));
br = await waitType("git_branches", mark).catch((e) => fail(String(e)));
assert(br.current === "main", `切换后 current=${br.current}（应回 main）`);

clearTimeout(failTimeout);
ws.close();
if (child?.pid) child.kill("SIGTERM");
await rm(repoDir, { recursive: true, force: true }).catch(() => {});
console.log("全部断言通过");
process.exit(0);
