// Smoke: canonical project grouping in list_sessions (2026-10 mklink incident fix).
// Two session files whose header cwd are different SPELLINGS of the same directory
// (case + separator variants — realpath-mergeable on every platform, no link needed)
// must collapse into ONE project row whose cwd is a real, on-disk spelling; a second
// real project stays separate. Runs the real host under the omp-desktop-test profile.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

if (process.env.OMP_PROFILE !== "omp-desktop-test") {
  console.error("✗ 必须以 OMP_PROFILE=omp-desktop-test 运行（测试 Profile 隔离红线）");
  process.exit(1);
}

// Projects live under os.tmpdir(): mergeHistoryProjects filters temp dirs out of
// allProjects, so the smoke never pollutes the test profile's project manifest.
const sessionsDir = path.join(os.homedir(), ".omp", "profiles", "omp-desktop-test", "agent", "sessions", "smoke-project-group");
const projA = path.join(os.tmpdir(), "omp-pg-" + Date.now(), "proj-group-a");
const projB = path.join(os.tmpdir(), "omp-pg-" + Date.now(), "proj-group-b");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(path.dirname(projA), { recursive: true });
mkdirSync(projA, { recursive: true });
mkdirSync(projB, { recursive: true });

// Two spellings of projA: backslash/lower vs forward-slash/upper.
const variantA = projA;
const variantB = projA.toUpperCase().replaceAll("\\", "/");

const mkSession = (id: string, cwd: string, msAgo: number) => {
  const when = new Date(Date.now() - msAgo).toISOString();
  const file = path.join(sessionsDir, `${when.replaceAll(":", "-").replaceAll(".", "-")}_${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: when, cwd }) + "\n", "utf8");
  return file;
};
const idA1 = "01a10a01-0000-7000-8000-00000000a001";
const idA2 = "01a10a02-0000-7000-8000-00000000a002";
const idB1 = "01a10a03-0000-7000-8000-00000000b001";
const files = [
  mkSession(idA1, variantA, 60_000), // older, canonical spelling
  mkSession(idA2, variantB, 10_000), // newer, variant spelling
  mkSession(idB1, projB, 30_000),
];

let child: ChildProcess | null = null;
function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  cleanup();
  process.exit(1);
}
function cleanup() {
  for (const f of files) rmSync(f, { force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(path.dirname(projA), { recursive: true, force: true });
}
const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env },
  stdio: ["ignore", "pipe", "inherit"],
});
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolve(m[1]);
    }
  });
}).catch((e) => fail(String(e)));
console.log("宿主已就绪:", wsUrl);

const failTimeout = setTimeout(() => fail("60s 内未完成全部断言"), 60_000);
const ws = new WebSocket(wsUrl!);
ws.onopen = () => ws.send(JSON.stringify({ type: "list_sessions" }));
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type !== "session_list") return;
  clearTimeout(failTimeout);

  const rowsA = msg.projects.filter((p: { cwd: string }) => norm(p.cwd) === norm(projA));
  if (rowsA.length !== 1) fail(`projA 应合并为 1 行,实际 ${rowsA.length} 行: ${JSON.stringify(msg.projects.map((p: { cwd: string }) => p.cwd))}`);
  const row = rowsA[0];
  if (row.sessions.length !== 2) fail(`projA 行应含 2 个会话,实际 ${row.sessions.length}`);
  if (!row.sessions.some((s: { id: string }) => s.id === idA1) || !row.sessions.some((s: { id: string }) => s.id === idA2))
    fail("projA 行会话 id 不全");
  if (norm(row.cwd) !== norm(projA) || row.cwd.includes("/")) fail(`projA 显示 cwd 应为真实盘符拼写,实际 ${row.cwd}`);
  const rowsB = msg.projects.filter((p: { cwd: string }) => norm(p.cwd) === norm(projB));
  if (rowsB.length !== 1 || rowsB[0].sessions.length !== 1) fail(`projB 应独立 1 行 1 会话,实际 ${JSON.stringify(rowsB)}`);

  console.log("冒烟通过 ✓（两种拼写合并为一行,显示拼写 =", row.cwd, "）");
  ws.close();
  if (child?.pid) child.kill("SIGTERM");
  cleanup();
  process.exit(0);
};
