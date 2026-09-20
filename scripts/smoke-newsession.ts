// 新建会话契约冒烟：配置默认下发 + configured 回推 + 懒建会话的列表兜底。
// 用法：bun scripts/smoke-newsession.ts [宿主ws地址]
// 断言覆盖（对应 2026-09-20 系列修复，回归即失败）：
//   1. ready 帧携带 defaultModel/defaultThinking（host 侧配置下发契约）
//   2. create_session 带 thinking 时回推 configured 值（传 auto 回 auto，不是生效值 high）
//   3. create_session 不带 thinking 时回推 = ready 帧的 defaultThinking（底座默认与 UI 显示同源）
//   4. 新建后立即 list_sessions 必含该会话（BUG-005：底座懒建文件，内存池兜底）
// 不发 prompt，无真实模型调用，跑完即退。
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

// list_sessions 的历史扫描会把临时 cwd 并入 omp-desktop.json 的 allProjects 落盘，
// 退出前（含失败路径）必须还原，否则每次冒烟都在用户配置里留幽灵项目
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const cfgPath = path.join(homedir(), ".omp/agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const tmpDirs: string[] = [];

function restoreCfg() {
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    try { execSync("sleep 0.8"); } catch {} // 等 host 退完再写回，防退出钩子把测试态写回
  }
  try {
    if (cfgExisted) writeFileSync(cfgPath, cfgBackup!);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restoreCfg();
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
    const hit = () => frames.findIndex((f, i) => f.type === t && i >= after);
    if (hit() >= 0) return resolve(frames[hit()]);
    const timer = setTimeout(() => reject(new Error(`等待 ${t} 超时`)), ms);
    const iv = setInterval(() => {
      const i = hit();
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

// ---- 断言 1：ready 帧配置默认下发 ----
const ready = await waitType("ready").catch((e) => fail(String(e)));
assert(ready.defaultModel != null, `ready 帧 defaultModel=${ready.defaultModel}`);
assert(ready.defaultThinking != null, `ready 帧 defaultThinking=${ready.defaultThinking}`);

const cwd = await mkdtemp(path.join(tmpdir(), "omp-smoke-ns-"));
tmpDirs.push(cwd);

// ---- 断言 2：显式 thinking 回推 configured 值 ----
const mark1 = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd, thinking: "auto" }));
const created1 = await waitType("session_created", mark1).catch((e) => fail(String(e)));
assert(created1.thinking === "auto", `带 auto 建会话回推 configured=${created1.thinking}（应为 auto，不是生效值）`);

// ---- 断言 4：立即 list_sessions 含新会话（BUG-005 回归） ----
const mark2 = frames.length;
ws.send(JSON.stringify({ type: "list_sessions" }));
const list = await waitType("session_list", mark2).catch((e) => fail(String(e)));
const inList = (l: any, p: string) =>
  (l.projects ?? []).flatMap((pr: any) => pr.sessions ?? []).some((s: any) => s.path === p);
assert(inList(list, created1.path), "新建后立即 list_sessions 含该会话（内存池兜底）");

// ---- 断言 3：不带 thinking 建会话，回推与 ready 帧默认一致 ----
const mark3 = frames.length;
ws.send(JSON.stringify({ type: "create_session", cwd }));
const created2 = await waitType("session_created", mark3).catch((e) => fail(String(e)));
assert(
  created2.thinking === ready.defaultThinking,
  `不带 thinking 建会话回推=${created2.thinking}，与配置默认 ${ready.defaultThinking} 一致`,
);

// ---- 断言 5：reload_settings 的 models 帧也携带配置默认（点新建的重拉路径） ----
const mark4 = frames.length;
ws.send(JSON.stringify({ type: "reload_settings" }));
const models = await waitType("models", mark4).catch((e) => fail(String(e)));
assert(
  models.defaultModel === ready.defaultModel && models.defaultThinking === ready.defaultThinking,
  "reload_settings → models 帧携带 defaultModel/defaultThinking",
);

clearTimeout(failTimeout);
ws.close();
restoreCfg();
for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
console.log("全部断言通过（omp-desktop.json 已还原）");
process.exit(0);
