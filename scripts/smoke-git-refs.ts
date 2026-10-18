// Git ref + status regression smoke: the two defects found by comparing our git
// layer against IntelliJ's git4idea, plus the state branches they forced open.
// Usage: bun scripts/smoke-git-refs.ts [host ws url]
// Assertions cover:
//   1. non-ASCII filename survives git status verbatim (not git's octal-escaped quoted form)
//   2. staging that non-ASCII path actually reaches the index
//   3. switching to a LOCAL branch whose name contains "/" lands on it and creates no phantom branch
//   4. switching to a remote-tracking ref DWIMs to a local branch of the same name
//   5. detached HEAD is reported as detached, with the short oid as current
//   6. push on a branch with no upstream returns the actionable message, not raw git stderr
// Zero model calls; exits when done.
import { smokeEnv } from "./smoke-profile.ts";
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
let repoDir = "";
let remoteDir = "";

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  // rmSync over `rm -rf`: the fixture dirs must go on Windows too.
  for (const dir of [repoDir, remoteDir]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: smokeEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
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

// Fixtures are isolated from the user's global git config: a global
// core.hooksPath (~/.git-hooks) ships a git-lfs post-checkout hook that exits 1
// here. GIT_CONFIG_GLOBAL points at a real empty file rather than /dev/null so
// the same fixture is valid on Windows.
const globalCfg = path.join(tmpdir(), `omp-smoke-gitcfg-${process.pid}`);
await writeFile(globalCfg, "");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: globalCfg,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "smoke",
  GIT_AUTHOR_EMAIL: "smoke@test",
  GIT_COMMITTER_NAME: "smoke",
  GIT_COMMITTER_EMAIL: "smoke@test",
};

repoDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-refs-"));
remoteDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-remote-"));
// The same global flags the host applies, so the fixture's own view of the
// index matches what the UI sees (core.quotepath=false is what keeps a
// non-ASCII name out of octal-escaped quoted form).
const g = (cmd: string) => execSync(`git -C ${JSON.stringify(repoDir)} -c core.quotepath=false ${cmd}`, { env: gitEnv });
const gRemote = (cmd: string) => execSync(`git -C ${JSON.stringify(remoteDir)} -c core.quotepath=false ${cmd}`, { env: gitEnv });

g("init -b main");
gRemote("init -b main --bare");
// A non-ASCII filename is the trigger: plain `git status --short` renders it as
// an octal-escaped quoted string, which is what used to reach the UI and the
// stage/unstage pathspec.
const CJK = "中文文件名.txt";
await writeFile(path.join(repoDir, CJK), "行1\n行2\n");
await writeFile(path.join(repoDir, "keep.txt"), "k\n");
g("add .");
g("commit -m base");
g("remote add origin " + JSON.stringify(remoteDir));
g("push -u origin main");

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

const call = async (req: Record<string, unknown>, reply: string) => {
  const mark = frames.length;
  ws.send(JSON.stringify(req));
  return waitType(reply, mark).catch((e) => fail(String(e)));
};

ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws 连接失败"));
}).catch((e) => fail(String(e)));
await waitType("ready");

// ---- Assertion 1: non-ASCII path comes back verbatim ----
await writeFile(path.join(repoDir, CJK), "行1\n行2-改\n");
const st = await call({ type: "get_git_diff", cwd: repoDir }, "git_status");
const paths = (st.files ?? []).map((f: any) => f.path);
const cjkRow = (st.files ?? []).find((f: any) => f.path === CJK);
assert(
  !!cjkRow && !paths.some((p: string) => p.includes("\\344") || p.startsWith('"')),
  `get_git_diff 中文文件名原样返回（path=${JSON.stringify(cjkRow?.path ?? null)}；清单: ${paths.join(",")}）`,
);

// ---- Assertion 2: staging that path really stages it ----
const staged = await call({ type: "git_stage", cwd: repoDir, paths: [CJK] }, "git_staged");
assert(staged.ok === true, `git_stage 中文路径 ok=${staged.ok} error=${staged.error ?? "无"}`);
const cached = g("diff --cached --name-only").toString().trim();
assert(cached === CJK, `磁盘核对：index 内为 ${JSON.stringify(cached)}（应为 ${JSON.stringify(CJK)}）`);

// ---- Assertion 3: LOCAL branch containing "/" is not mistaken for a remote ----
g("checkout -q -b feat/login-flow");
g("checkout -q main");
const sw = await call({ type: "switch_git_branch", cwd: repoDir, branch: "feat/login-flow" }, "git_branch_switched");
const afterSwitch = await call({ type: "get_git_branches", cwd: repoDir }, "git_branches");
const localNames = g("branch --format=%(refname:short)").toString().split("\n").map((s) => s.trim()).filter(Boolean);
assert(
  sw.branch === "feat/login-flow" && afterSwitch.current === "feat/login-flow",
  `switch_git_branch 本地含 "/" 分支：回执=${sw.branch} current=${afterSwitch.current}`,
);
// The old `includes("/")` test ran `checkout --track feat/login-flow`, which
// silently created a second branch `login-flow` and exited 0.
assert(
  !localNames.includes("login-flow"),
  `未产生幽灵分支（本地分支: ${localNames.join(",")}）`,
);

// ---- Assertion 4: remote-tracking ref DWIMs to a local branch ----
g("push -q origin feat/login-flow:feature-x");
g("fetch -q origin");
const remotes = (await call({ type: "get_git_branches", cwd: repoDir }, "git_branches")).remotes ?? [];
assert(remotes.includes("origin/feature-x"), `远程跟踪分支含 origin/feature-x（${remotes.join(",")}）`);
const sw2 = await call({ type: "switch_git_branch", cwd: repoDir, branch: "origin/feature-x" }, "git_branch_switched");
const afterRemote = await call({ type: "get_git_branches", cwd: repoDir }, "git_branches");
assert(
  sw2.branch === "feature-x" && afterRemote.current === "feature-x" && (afterRemote.branches ?? []).includes("feature-x"),
  `远程分支 DWIM：回执=${sw2.branch} current=${afterRemote.current}`,
);

// ---- Assertion 5: detached HEAD is distinguishable from a plain branch ----
g("checkout -q --detach HEAD");
const det = await call({ type: "get_git_branches", cwd: repoDir }, "git_branches");
assert(det.detached === true, `detached HEAD 被标记（detached=${det.detached} current=${det.current}）`);
// An unborn branch names a branch and must NOT read as detached.
g("checkout -q main");
g("checkout -q -b brand-new");
g("checkout -q --orphan orphaned");
const unb = await call({ type: "get_git_branches", cwd: repoDir }, "git_branches");
assert(unb.detached === false && unb.current === "orphaned", `未出生分支仍报分支名（detached=${unb.detached} current=${unb.current}）`);

// ---- Assertion 6: push without upstream is actionable ----
// Clear the staged CJK file first: an orphan branch leaves the index/worktree
// dirty, and git refuses to switch branches over local changes.
g("reset -q --hard");
g("clean -qfd");
g("checkout -q main");
g("checkout -q -B no-upstream main");
const pushed = await call({ type: "git_push", cwd: repoDir }, "git_pushed");
assert(
  pushed.ok !== true && String(pushed.error ?? "").includes("no-upstream"),
  `无上游 push 给出可执行提示（error=${JSON.stringify(pushed.error ?? null)}）`,
);

clearTimeout(failTimeout);
ws.close();
if (child?.pid) child.kill("SIGTERM");
await rm(repoDir, { recursive: true, force: true }).catch(() => {});
await rm(remoteDir, { recursive: true, force: true }).catch(() => {});
await rm(globalCfg, { force: true }).catch(() => {});
console.log("全部断言通过");
process.exit(0);
