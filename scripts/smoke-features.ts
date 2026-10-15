// New feature smoke test: the git write group (stage/unstage/discard/commit/push) plus session
// rename/archive + read_image + abort + compact.
// Usage: bun scripts/smoke-features.ts [host ws url]
// WARNING: reads and writes omp-desktop.json directly; every exit path (including assertion failures) restores the original file; the host is killed first,
//    so its in-memory state cannot write the test state back in an exit hook.
// WARNING: all git write operations land in a temp repo/temp bare repo (file:// remote); never tested against a real repo.
// Assertions cover:
//   1. git_stage / git_unstage: staging in and out (fixture-side git diff --cached verifies the on-disk truth)
//   2. git_discard: tracked files restored, untracked files gone
//   3. git_commit: committing with paths returns a sha; without paths commits everything staged
//   4. git_push: pushes to the local bare repo with the remote branch pointing at the new commit; write ops in a non-git dir return an error field
//   5. rename_session: renaming a lazily-created session takes effect on the list_sessions fallback entry
//   6. archive_session: archived flag takes effect, archiving unpins, unarchiving restores
//   6b. Historical sessions outside the pool (never opened): rename persists and archive works on a hand-made on-disk jsonl
//   7. read_image: png read as base64; oversized/non-image suffix returns error
//   8. abort_session: an idle session safely returns ok
//   9. compact_session: an empty session returns an error field (without killing the connection)
// Zero model calls; exits when done.
import { spawn, execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const cfgPath = path.join(homedir(), ".omp/agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;
const tmpDirs: string[] = [];

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
let restored = false;

// Restore must precede exit: kill the host (SIGTERM is async) -> wait out its exit window -> write the original back
function restoreCfg() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    try { execSync("sleep 0.8"); } catch {} // Sleep synchronously 800ms for the host to finish exiting before writing back (Bun main-thread Atomics.wait is unreliable)
  }
  try {
    if (cfgExisted) writeFileSync(cfgPath, cfgBackup);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
}

async function cleanup() {
  restoreCfg();
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restoreCfg();
  for (const d of tmpDirs) { try { spawn("rm", ["-rf", d]); } catch {} }
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env },
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

const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("90s 内未完成全部断言"), 90_000);
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

// ---------- fixture: temp git repo + local bare repo remote (all write operations isolated here) ----------
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@test", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@test" };
const repoDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-feat-"));
const bareDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-feat-remote-"));
tmpDirs.push(repoDir, bareDir);
const g = (cmd: string) => execSync(`git -C ${JSON.stringify(repoDir)} ${cmd}`, { env: gitEnv }).toString().trim();
g("init -b main");
execSync(`git init --bare -b main ${JSON.stringify(bareDir)}`, { env: gitEnv }); // Local bare repo as the remote
await writeFile(path.join(repoDir, "a.txt"), "line1\nline2\n");
g("add .");
g("commit -m base");
g(`remote add origin file://${bareDir}`);
g("push -u origin main"); // The fixture presets upstream; the RPC just does a regular push

// ---- Assertion 1: git_stage stages (on-disk truth: git diff --cached) ----
await writeFile(path.join(repoDir, "a.txt"), "line1\nline2-changed\n");
await writeFile(path.join(repoDir, "b.txt"), "new file\n");
let mark = frames.length;
ws.send(JSON.stringify({ type: "git_stage", cwd: repoDir, paths: ["a.txt", "b.txt"] }));
let r = await waitType("git_staged", mark).catch((e) => fail(String(e)));
assert(r.ok === true, `git_stage 回 ok（error=${r.error ?? "无"}）`);
const cached = g("diff --cached --name-only");
assert(cached.includes("a.txt") && cached.includes("b.txt"), `git_stage 后暂存区含 a.txt/b.txt（${cached.replace(/\n/g, ",")}）`);

// ---- Assertion 2: git_unstage unstages ----
mark = frames.length;
ws.send(JSON.stringify({ type: "git_unstage", cwd: repoDir, paths: ["a.txt", "b.txt"] }));
r = await waitType("git_unstaged", mark).catch((e) => fail(String(e)));
assert(r.ok === true, `git_unstage 回 ok（error=${r.error ?? "无"}）`);
const cached2 = g("diff --cached --name-only");
assert(!cached2.includes("a.txt") && !cached2.includes("b.txt"), `git_unstage 后暂存区已清空（${cached2 || "空"}）`);

// ---- Assertion 3: git_discard restores tracked + removes untracked ----
await writeFile(path.join(repoDir, "c.txt"), "throwaway\n");
mark = frames.length;
ws.send(JSON.stringify({ type: "git_discard", cwd: repoDir, paths: ["a.txt", "c.txt"] }));
r = await waitType("git_discarded", mark).catch((e) => fail(String(e)));
assert(r.ok === true, `git_discard 回 ok（error=${r.error ?? "无"}）`);
assert(readFileSync(path.join(repoDir, "a.txt"), "utf8") === "line1\nline2\n", "git_discard 后 a.txt 内容恢复基线");
assert(!existsSync(path.join(repoDir, "c.txt")), "git_discard 后 untracked c.txt 已删除");
assert(existsSync(path.join(repoDir, "b.txt")), "b.txt 不在 discard 清单，不受影响");

// ---- Assertion 4: git_commit with paths (returned sha matches HEAD) ----
await writeFile(path.join(repoDir, "a.txt"), "line1\nline2-committed\n");
mark = frames.length;
ws.send(JSON.stringify({ type: "git_commit", cwd: repoDir, message: "feat: 提交 a.txt（冒烟）", paths: ["a.txt"] }));
r = await waitType("git_committed", mark).catch((e) => fail(String(e)));
assert(r.ok === true && typeof r.commit === "string" && r.commit.length >= 7, `git_commit 回 ok + sha（commit=${r.commit ?? r.error}）`);
assert(r.commit === g("rev-parse HEAD"), "git_commit 返回的 sha 与 rev-parse HEAD 一致");

// ---- Assertion 5: git_commit without paths (commits everything staged) ----
g("add b.txt");
mark = frames.length;
ws.send(JSON.stringify({ type: "git_commit", cwd: repoDir, message: "chore: 提交全部已暂存（冒烟）" }));
r = await waitType("git_committed", mark).catch((e) => fail(String(e)));
assert(r.ok === true && r.commit === g("rev-parse HEAD"), `git_commit 无 paths 提交已暂存（commit=${r.commit ?? r.error}）`);
assert(g("log -1 --pretty=%s").includes("已暂存"), "最新提交为无 paths 提交");

// ---- Assertion 6: git_push pushes to the local bare repo; the remote points at the new commit ----
mark = frames.length;
ws.send(JSON.stringify({ type: "git_push", cwd: repoDir }));
r = await waitType("git_pushed", mark).catch((e) => fail(String(e)));
assert(r.ok === true, `git_push 回 ok（error=${r.error ?? "无"}）`);
const remoteHead = execSync(`git -C ${JSON.stringify(bareDir)} rev-parse main`).toString().trim();
assert(remoteHead === g("rev-parse HEAD"), "git_push 后裸仓库 main 指向本地 HEAD");

// ---- Assertion 7: write ops in a non-git dir return an error field (without killing the connection) ----
const plainDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-feat-plain-"));
tmpDirs.push(plainDir);
mark = frames.length;
ws.send(JSON.stringify({ type: "git_stage", cwd: plainDir, paths: ["x.txt"] }));
r = await waitType("git_staged", mark).catch((e) => fail(String(e)));
assert(!r.ok && typeof r.error === "string" && r.error.length > 0, `非 git 目录 git_stage 回 error 字段（${String(r.error).slice(0, 60)}）`);
// The connection is still alive: the immediately following query replies normally
mark = frames.length;
ws.send(JSON.stringify({ type: "get_git_branches", cwd: repoDir }));
await waitType("git_branches", mark).catch((e) => fail(String(e)));
assert(true, "error 回包后连接仍可用");

// ---- Assertion 8: rename_session (lazy session goes through the in-memory fallback entry) ----
const sessDir = await mkdtemp(path.join(tmpdir(), "omp-smoke-feat-sess-"));
tmpDirs.push(sessDir);
mark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: sessDir }));
let created = await waitType("session_created", mark).catch((e) => fail(String(e)));
mark = frames.length;
ws.send(JSON.stringify({ type: "rename_session", sessionId: created.sessionId, title: "冒烟重命名标题" }));
r = await waitType("session_renamed", mark).catch((e) => fail(String(e)));
assert(r.ok === true && r.title === "冒烟重命名标题", `rename_session 回 ok + title（${r.title ?? r.error}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
let list = await waitType("session_list", mark).catch((e) => fail(String(e)));
let item = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === created.path);
assert(item?.title === "冒烟重命名标题", `list_sessions 条目标题生效（title=${item?.title}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "delete_session", path: created.path }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
item = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === created.path);
assert(!item, "delete_session 后条目消失");

// ---- Assertion 9: archive_session (archive flag + unpin + unarchive) ----
mark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: sessDir }));
created = await waitType("session_created", mark).catch((e) => fail(String(e)));
ws.send(JSON.stringify({ type: "set_session_pinned", path: created.path, pinned: true })); // no reply frame
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert((list.pinnedSessions ?? []).includes(created.path), "set_session_pinned 进 pinnedSessions");
mark = frames.length;
ws.send(JSON.stringify({ type: "archive_session", sessionId: created.sessionId, archived: true }));
r = await waitType("session_archived", mark).catch((e) => fail(String(e)));
assert(r.ok === true && r.archived === true, `archive_session 回 ok + archived（${r.archived}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
item = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === created.path);
assert(item?.archived === true, `list_sessions 条目 archived=true（archived=${item?.archived}）`);
assert(!(list.pinnedSessions ?? []).includes(created.path), "归档后置顶被移除");
mark = frames.length;
ws.send(JSON.stringify({ type: "archive_session", sessionId: created.sessionId, archived: false }));
r = await waitType("session_archived", mark).catch((e) => fail(String(e)));
assert(r.ok === true && r.archived === false, "archive_session 取消归档回 ok");
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
item = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === created.path);
assert(item?.archived === false, `list_sessions 条目恢复 archived=false`);
mark = frames.length;
ws.send(JSON.stringify({ type: "delete_session", path: created.path }));
await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(true, "归档会话删除完成（delete_session 同步清理归档记录）");

// ---- Assertion 6b: rename + archive on historical sessions outside the pool (never opened) ----
// fixture: hand-write a jsonl containing only a session header into the session dir; listAll can scan out its id/path,
// but it has never entered the in-memory pool via create_session -- exactly the main scenario of right-click archiving any list item.
const fakeId = crypto.randomUUID();
const fakeSessionFile = path.join(path.dirname(created.path), `20260921T000000.000Z_${fakeId}.jsonl`);
await mkdir(path.dirname(fakeSessionFile), { recursive: true });
await writeFile(fakeSessionFile, `${JSON.stringify({ type: "session", version: 3, id: fakeId, timestamp: "2026-09-21T00:00:00.000Z", cwd: sessDir })}\n`);
mark = frames.length;
ws.send(JSON.stringify({ type: "rename_session", sessionId: fakeId, title: "离线重命名标题" }));
r = await waitType("session_renamed", mark).catch((e) => fail(String(e)));
assert(r.ok === true && r.title === "离线重命名标题", `池外 rename_session 回 ok + title（${r.title ?? r.error}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
let fakeItem = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === fakeSessionFile);
assert(fakeItem?.title === "离线重命名标题", `池外 rename 后 list_sessions 标题生效（title=${fakeItem?.title}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "archive_session", sessionId: fakeId, archived: true }));
r = await waitType("session_archived", mark).catch((e) => fail(String(e)));
assert(r.ok === true && r.archived === true, `池外 archive_session 回 ok + archived（${r.archived ?? r.error}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
fakeItem = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === fakeSessionFile);
assert(fakeItem?.archived === true, `池外归档后 list_sessions 条目 archived=true（archived=${fakeItem?.archived}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "delete_session", path: fakeSessionFile }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
fakeItem = (list.projects ?? []).find((p: any) => p.cwd === sessDir)?.sessions?.find((s: any) => s.path === fakeSessionFile);
assert(!fakeItem, "池外会话删除后条目消失");
// A pool-external session id that does not exist fails fast (error frame back, connection intact)
mark = frames.length;
ws.send(JSON.stringify({ type: "archive_session", sessionId: "no-such-session-id", archived: true }));
const errFrame = await waitType("error", mark).catch((e) => fail(String(e)));
assert(String(errFrame.message).includes("会话不存在"), `未知 sessionId 归档回 error（${errFrame.message}）`);

// ---- Assertion 10: read_image (png succeeds; oversized/non-image suffix errors) ----
const iconPath = path.join(Bun.fileURLToPath(new URL("..", import.meta.url)), "ui/app-icon.png");
mark = frames.length;
ws.send(JSON.stringify({ type: "read_image", path: iconPath }));
r = await waitType("image_content", mark).catch((e) => fail(String(e)));
assert(!r.error && r.mime === "image/png" && typeof r.data === "string" && r.data.length > 1000, `read_image png（mime=${r.mime}, base64 ${r.data?.length ?? 0} 字符）`);
const fakePng = path.join(sessDir, "oversized.png");
await writeFile(fakePng, Buffer.alloc(8_000_001, 1)); // Exceeds the 8MB cap
mark = frames.length;
ws.send(JSON.stringify({ type: "read_image", path: fakePng }));
r = await waitType("image_content", mark).catch((e) => fail(String(e)));
assert(typeof r.error === "string" && r.error.includes("过大"), `read_image 超限回 error（${r.error}）`);
const fakeTxt = path.join(sessDir, "not-an-image.txt");
await writeFile(fakeTxt, "hello");
mark = frames.length;
ws.send(JSON.stringify({ type: "read_image", path: fakeTxt }));
r = await waitType("image_content", mark).catch((e) => fail(String(e)));
assert(typeof r.error === "string" && r.error.includes("不支持"), `read_image 非图片后缀回 error（${r.error}）`);

// ---- Assertion 11: abort_session safely returns ok on an idle session ----
mark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: sessDir }));
created = await waitType("session_created", mark).catch((e) => fail(String(e)));
mark = frames.length;
ws.send(JSON.stringify({ type: "abort_session", sessionId: created.sessionId }));
r = await waitType("session_aborted", mark).catch((e) => fail(String(e)));
assert(r.ok === true, "abort_session 空闲会话回 ok");
mark = frames.length;
ws.send(JSON.stringify({ type: "delete_session", path: created.path }));
await waitType("session_list", mark).catch((e) => fail(String(e)));

// ---- Assertion 12: compact_session returns an error field on an empty session (structurally valid, connection intact) ----
mark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: sessDir }));
created = await waitType("session_created", mark).catch((e) => fail(String(e)));
mark = frames.length;
ws.send(JSON.stringify({ type: "compact_session", sessionId: created.sessionId }));
r = await waitType("session_compacted", mark).catch((e) => fail(String(e)));
assert(r.ok === true || (typeof r.error === "string" && r.error.length > 0), `compact_session 空会话结构合法（ok=${r.ok}, error=${r.error ?? "无"}）`);
mark = frames.length;
ws.send(JSON.stringify({ type: "delete_session", path: created.path }));
await waitType("session_list", mark).catch((e) => fail(String(e)));

clearTimeout(failTimeout);
ws.close();
await cleanup();
console.log("全部断言通过（omp-desktop.json 已还原）");
process.exit(0);
