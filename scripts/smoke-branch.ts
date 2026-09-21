// 会话分叉冒烟：prompt 落盘 entryId 透传 → branch_session 池迁移 → 分支家族树 → 新分支续聊。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke-branch.ts [宿主ws地址]
// 真模型驱动；整轮断言设计为可重试一次（第二轮全新 tmp cwd + 新会话，断言不砍），
// 两轮都失败才退出非零。
// ⚠ 直接读写 omp-desktop.json，任何退出路径（含断言失败）都会还原原文件；还原前先杀 host，
//    避免 host 内存态在退出钩子里把测试状态写回。
// 断言覆盖：
//   1. prompt → turn_end 后 get_messages：user 消息带 entryId（agent_end 回填）
//   2. branch_session：ok、selectedText 非空且等于原 user 文本、newPath 文件存在、
//      池迁移后事件帧带新 sessionId（attachEntry 重建订阅生效）
//   3. get_session_tree：branches 数 = 2、isCurrent 命中新分支、parentSession 关系正确
//   4. 新分支 prompt 续聊：turn_end 正常到达（池迁移后链路完整）
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
const sessionFiles: string[] = []; // 测试产生的会话文件（delete_session 顺带清 artifacts）

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
let restored = false;

// 还原必须先于 exit：kill host（SIGTERM 异步）→ 等其退出窗口 → 写回原文
function restoreCfg() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    try { execSync("sleep 0.8"); } catch {} // 同步等 800ms 让 host 退完再写回（Bun 主线程 Atomics.wait 不可靠）
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
    cwd: new URL("..", import.meta.url).pathname,
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
// 等指定会话的 event 帧（turn_end 等）：增量 delta 与终止信号都要按 sessionId 归属
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

// 发一条 prompt，等该会话 turn_end，返回累积的 assistant 增量文本
async function askAndAwait(sessionId: string, text: string): Promise<string> {
  const mark = frames.length;
  ws.send(JSON.stringify({ type: "prompt", sessionId, text }));
  await waitEvent("turn_end", sessionId, mark);
  return frames
    .filter((f, i) => i >= mark && f.type === "event" && f.kind === "text_delta" && f.sessionId === sessionId)
    .map((f) => f.text)
    .join("");
}

// 一轮完整断言（可整轮重试）：全新 tmp cwd → 建会话 → 聊天 → 分叉 → 家族树 → 续聊
async function attempt(round: number): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), `omp-smoke-branch-${round}-`));
  tmpDirs.push(cwd);

  // ---- 1. create → prompt → turn_end → get_messages 带 entryId ----
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
  // 分叉后 host 推的 messages 帧应带新 sessionId（transcript 已切到分叉后视图）
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

  // ---- 4. 新分支续聊（池迁移后 prompt → 事件带新键 → turn_end） ----
  const ask2 = "请只回复四个字母：DONE";
  const reply2 = await askAndAwait(branched.newSessionId, ask2);
  console.log(`新分支回复: ${reply2.trim().slice(0, 60)}`);
  assert(reply2.trim().length > 0, "新分支续聊回复非空");

  // ---- 清理本轮会话文件（delete_session 顺带清 artifacts 目录） ----
  for (const p of sessionFiles.splice(0)) {
    mark = frames.length;
    ws.send(JSON.stringify({ type: "delete_session", path: p }));
    await waitType("session_list", mark);
  }
}

// 真模型可能偶发超时/拒答：整轮重试一次（全新 cwd + 新会话，两轮产物统一清理）
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
