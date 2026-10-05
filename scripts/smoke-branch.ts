// Session branching smoke test: prompt's persisted entryId passthrough -> branch_session pool migration -> branch family tree -> continued chat on the new branch.
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-branch.ts [host ws url]
// Real-model driven; a full assertion round is retryable once (the second round uses a fresh tmp cwd + new session, no assertions trimmed),
// and only exits non-zero when both rounds fail.
// WARNING: reads and writes omp-desktop.json directly; every exit path (including assertion failures) restores the original file; the host is killed first,
//    so its in-memory state cannot write the test state back in an exit hook.
// Assertions cover:
//   1. After prompt -> turn_end, get_messages: the user message carries entryId (backfilled at agent_end)
//   2. branch_session: ok, selectedText non-empty and equal to the original user text, newPath file exists,
//      and after pool migration event frames carry the new sessionId (attachEntry's rebuilt subscription works)
//   3. get_session_tree: branches length = 2, isCurrent hits the new branch, parentSession relation correct
//   4. Continued chat on the new branch: turn_end arrives normally (the chain is intact after pool migration)
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const cfgPath = path.join(homedir(), ".omp/agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;
const tmpDirs: string[] = [];
const sessionFiles: string[] = []; // Session files created by the test (delete_session also cleans artifacts)

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
const failTimeout = setTimeout(() => fail("180s 内未完成全部断言"), 180_000);
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
  console.log("✓ " + msg);
}

const frames: any[] = [];
const waitType = (t: string, after = 0, ms = 60_000) =>
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
// Wait for event frames of the given session (turn_end etc.): both incremental deltas and terminal signals are attributed by sessionId
const waitEvent = (kind: string, sessionId: string, after = 0, ms = 60_000) => {
  const idx = () => frames.findIndex((f, i) => f.type === "event" && f.kind === kind && f.sessionId === sessionId && i >= after);
  if (idx() >= 0) return Promise.resolve(frames[idx()]);
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${kind}(会话 ${sessionId.slice(0, 8)}) 超时`)), ms);
    const iv = setInterval(() => {
      const i = idx();
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(iv);
        resolve(frames[i]);
      }
    }, 20);
  });
};

ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws 连接失败"));
}).catch((e) => fail(String(e)));
await waitType("ready");

// Send one prompt, wait for that session's turn_end, return the accumulated assistant delta text
async function askAndAwait(sessionId: string, text: string): Promise<string> {
  const mark = frames.length;
  ws.send(JSON.stringify({ type: "prompt", sessionId, text }));
  await waitEvent("turn_end", sessionId, mark);
  return frames
    .filter((f, i) => i >= mark && f.type === "event" && f.kind === "text_delta" && f.sessionId === sessionId)
    .map((f) => f.text)
    .join("");
}

// One full assertion round (retryable as a whole): fresh tmp cwd -> create session -> chat -> branch -> family tree -> continue chat
async function attempt(round: number): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), `omp-smoke-branch-${round}-`));
  tmpDirs.push(cwd);

  // ---- 1. create -> prompt -> turn_end -> get_messages carries entryId ----
  let mark = frames.length;
  ws.send(JSON.stringify({ type: "create_session", cwd }));
  const created = await waitType("session_created", mark).catch((e) => { throw e; });
  sessionFiles.push(created.path);
  const ask1 = "请只回复两个字母：OK";
  const reply1 = await askAndAwait(created.sessionId, ask1);
  console.log(`回复: ${reply1.trim().slice(0, 60)}`);
  assert(reply1.trim().length > 0, "第一轮回复非空");
  mark = frames.length;
  ws.send(JSON.stringify({ type: "get_messages", sessionId: created.sessionId }));
  const msgs = await waitType("messages", mark);
  const userItem = msgs.messages.find((m: any) => m.role === "user" && m.text === ask1);
  assert(!!userItem, "get_messages 含原 user 消息");
  assert(typeof userItem.entryId === "string" && userItem.entryId.length > 0, `user 消息带 entryId（${userItem.entryId?.slice(0, 12)}…）`);

  // ---- 2. branch_session ----
  mark = frames.length;
  ws.send(JSON.stringify({ type: "branch_session", sessionId: created.sessionId, entryId: userItem.entryId }));
  const branched = await waitType("session_branched", mark);
  assert(branched.ok === true, `branch_session 回 ok（error=${branched.error ?? "无"}）`);
  assert(typeof branched.newSessionId === "string" && branched.newSessionId.length > 0, "回包带 newSessionId");
  assert(typeof branched.newPath === "string" && existsSync(branched.newPath), `新会话文件已落盘（${path.basename(String(branched.newPath))}）`);
  assert(typeof branched.selectedText === "string" && branched.selectedText.trim().length > 0, `selectedText 非空（${String(branched.selectedText).slice(0, 30)}）`);
  assert(branched.selectedText === ask1, "selectedText 等于被分叉的 user 消息原文");
  sessionFiles.push(branched.newPath);
  // After branching, the messages frame pushed by the host should carry the new sessionId (the transcript has switched to the post-branch view)
  const rebuilt = frames.find((f, i) => i >= mark && f.type === "messages" && f.sessionId === branched.newSessionId);
  assert(!!rebuilt, "分叉后 messages 帧带新 sessionId");
  assert(
    !rebuilt.messages.some((m: any) => m.role === "user" && m.text === ask1),
    "分叉后 transcript 不含被分叉的 user 消息（它已被取出待回填输入框）",
  );

  // ---- 3. get_session_tree ----
  mark = frames.length;
  ws.send(JSON.stringify({ type: "get_session_tree", sessionId: branched.newSessionId }));
  const tree = await waitType("session_tree", mark);
  assert(tree.ok === true, `get_session_tree 回 ok（error=${tree.error ?? "无"}）`);
  assert(Array.isArray(tree.branches) && tree.branches.length === 2, `家族分支数 = 2（实际 ${tree.branches?.length}）`);
  const newBranch = tree.branches.find((b: any) => b.isCurrent);
  const oldBranch = tree.branches.find((b: any) => !b.isCurrent);
  assert(!!newBranch && newBranch.path === branched.newPath, "isCurrent 命中新分支");
  assert(!!oldBranch && oldBranch.path === created.path, "另一支是源会话文件");
  assert(newBranch.parentSession === created.path, `新分支 parentSession 指向源文件（${String(newBranch.parentSession)}）`);
  assert(oldBranch.parentSession === null, "源会话无 parent（族根）");
  assert(typeof newBranch.title !== "undefined" && typeof newBranch.messageCount === "number", "分支条目带 title/messageCount");

  // ---- 4. Continued chat on the new branch (after pool migration: prompt -> events carry the new key -> turn_end) ----
  const ask2 = "请只回复四个字母：DONE";
  const reply2 = await askAndAwait(branched.newSessionId, ask2);
  console.log(`新分支回复: ${reply2.trim().slice(0, 60)}`);
  assert(reply2.trim().length > 0, "新分支续聊回复非空");

  // ---- Clean up this round's session files (delete_session also cleans the artifacts dir) ----
  for (const p of sessionFiles.splice(0)) {
    mark = frames.length;
    ws.send(JSON.stringify({ type: "delete_session", path: p }));
    await waitType("session_list", mark);
  }
}

// A real model may occasionally time out or refuse: retry the whole round once (fresh cwd + new session; both rounds' artifacts cleaned up together)
let lastErr: unknown = null;
for (let round = 1; round <= 2; round++) {
  try {
    console.log(`—— 第 ${round} 轮 ——`);
    await attempt(round);
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
    console.log(`第 ${round} 轮失败: ${String(e)}`);
  }
}
if (lastErr) fail(`两轮均未通过: ${String(lastErr)}`);

clearTimeout(failTimeout);
ws.close();
await cleanup();
console.log("全部断言通过（omp-desktop.json 已还原，测试会话与临时目录已清理）");
process.exit(0);
