// Project management smoke test: add (merged at top) / reorder (order as the single source of truth) / pin (pinned sessions) / remove (out of the project list).
// Usage: bun scripts/smoke-projects.ts [host ws url]
// WARNING: reads and writes omp-desktop.json directly; every exit path (including assertion failures) restores the original file; the host is killed first,
//    so its in-memory state cannot write the test state back in an exit hook.
// Assertions cover:
//   1. add_project: the new project is unshifted to the top and immediately visible in session_list
//   2. add_project a second time: refreshed as the newest top (relative order B before A)
//   3. reorder_projects: the order sent by the UI wins (A overtakes B); items not covered keep their order
//   4. set_session_pinned: pinnedSessions is visible in the persisted file
//   5. remove_project: into removedProjects, out of allProjects
// Zero model calls.
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

// ---- Assertion 1: add merges at the top ----
let mark = frames.length;
ws.send(JSON.stringify({ type: "add_project", cwd: dirA }));
let list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(idxOf(list, dirA) === 0, `add_project A 置顶（allProjects[0]）`);

// ---- Assertion 2: a second add refreshes the top ----
mark = frames.length;
ws.send(JSON.stringify({ type: "add_project", cwd: dirB }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(idxOf(list, dirB) === 0 && idxOf(list, dirA) === 1, `add_project B 新置顶（B=0, A=1）`);

// ---- Assertion 3: the reorder order is the single source of truth ----
ws.send(JSON.stringify({ type: "reorder_projects", order: [dirA, dirB] })); // no reply frame
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert(idxOf(list, dirA) < idxOf(list, dirB), `reorder 后 A 反超 B（A=${idxOf(list, dirA)}, B=${idxOf(list, dirB)}）`);

// ---- Assertion 4: pin visible in the persisted file ----
mark = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd: dirA }));
const created = await waitType("session_created", mark).catch((e) => fail(String(e)));
ws.send(JSON.stringify({ type: "set_session_pinned", path: created.path, pinned: true })); // no reply frame
mark = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
list = await waitType("session_list", mark).catch((e) => fail(String(e)));
assert((list.pinnedSessions ?? []).includes(created.path), "set_session_pinned 进 pinnedSessions");

// ---- Assertion 5: remove flags the entry (keeping it in allProjects is by design: visible in Recent + recoverable via add) ----
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
