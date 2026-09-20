// 项目管理链路冒烟：add（置顶并入）/ reorder（顺序唯一真源）/ pin（置顶会话）/ remove（移出项目列表）。
// 用法：bun scripts/smoke-projects.ts [宿主ws地址]
// ⚠ 直接读写 omp-desktop.json，任何退出路径（含断言失败）都会还原原文件；还原前先杀 host，
//    避免 host 内存态在退出钩子里把测试状态写回。
// 断言覆盖：
//   1. add_project：新项目 unshift 置顶，session_list 立即可见
//   2. add_project 二次：更新为最新置顶（相对顺序 B 在 A 前）
//   3. reorder_projects：以 UI 传序为准（A 反超 B），未涵盖项保持原序
//   4. set_session_pinned：pinnedSessions 落盘可见
//   5. remove_project：进 removedProjects、出 allProjects
// 零模型调用。
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

const dirA = await mkdtemp(path.join(tmpdir(), "omp-smoke-prjA-"));
const dirB = await mkdtemp(path.join(tmpdir(), "omp-smoke-prjB-"));
tmpDirs.push(dirA, dirB);
const idxOf = (l: any, c: string) => (l.allProjects ?? []).indexOf(c);

// ---- 断言 1：add 置顶并入 ----
let mark = frames.length;
ws.send(JSON.stringify({ type: "add_project", cwd: dirA }));
let list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(idxOf(list, dirA) === 0, `add_project A 置顶（allProjects[0]）`);

// ---- 断言 2：二次 add 更新置顶 ----
mark = frames.length;
ws.send(JSON.stringify({ type: "add_project", cwd: dirB }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(idxOf(list, dirB) === 0 && idxOf(list, dirA) === 1, `add_project B 新置顶（B=0, A=1）`);

// ---- 断言 3：reorder 顺序为唯一真源 ----
ws.send(JSON.stringify({ type: "reorder_projects", order: [dirA, dirB] })); // 无回包
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(idxOf(list, dirA) < idxOf(list, dirB), `reorder 后 A 反超 B（A=${idxOf(list, dirA)}, B=${idxOf(list, dirB)}）`);

// ---- 断言 4：pin 落盘可见 ----
mark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: dirA }));
const created = await waitType("session_created", mark).catch((e) => fail(String(e)));
ws.send(JSON.stringify({ type: "set_session_pinned", path: created.path, pinned: true })); // 无回包
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert((list.pinnedSessions ?? []).includes(created.path), "set_session_pinned 进 pinnedSessions");

// ---- 断言 5：remove 打标记（allProjects 保留条目是设计：最近视图可见 + add 可恢复）----
mark = frames.length;
ws.send(JSON.stringify({ type: "remove_project", cwd: dirA }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(
  (list.removedProjects ?? []).includes(dirA) && idxOf(list, dirB) >= 0,
  `remove_project A：进 removed（allProjects 保留、B 不受影响）`,
);

clearTimeout(failTimeout);
ws.close();
restoreCfg();
for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
console.log("全部断言通过（omp-desktop.json 已还原）");
process.exit(0);
