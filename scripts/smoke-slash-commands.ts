// 斜杠命令面冒烟：已移除的 8 条命令既不进候选清单、也不执行；其余命令分发不受影响。
// 用法：bun scripts/smoke-slash-commands.ts [宿主ws地址]
// 不传地址时本脚本自行拉起宿主子进程，退出时删除测试产生的会话文件。零模型调用。
// 断言覆盖：
//   1. list_commands 清单不含 model/models/switch/prewalk/fast/skillful/extended-context/computer/force
//   2. 清单仍含 compact/todo/context/usage/handoff/plan（过滤没有误伤；plan 是桌面注入的
//      TUI-only 条目，底座清单不含它）
//   3. 手输已移除命令（含别名 /models、冒号形式 /force:bash）→ command_output 提示 + command_result(consumed)
//   4. 已移除命令不产生任何事件帧（既不执行也不落成 prompt）
//   5. 未移除命令照常执行（/context 走 builtin 分发）
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const args = process.argv.slice(2);
let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  for (const f of createdFiles) rm(f).catch(() => {});
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
    child!.stdout!.on("data", function onLine(chunk: string) {
      const m = chunk.match(/READY (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        child!.stdout!.off("data", onLine);
        resolve(m[1]);
      }
    });
  }).catch((e) => fail(String(e)));
}

interface CommandEntry {
  name: string;
  aliases?: string[];
}
interface WireFrame {
  type: string;
  sessionId?: string;
  path?: string;
  text?: string;
  consumed?: boolean;
  commands?: CommandEntry[];
}

const REMOVED = ["model", "switch", "prewalk", "fast", "skillful", "extended-context", "computer", "force"];
const KEPT = ["compact", "todo", "context", "usage", "handoff", "plan"];

const seen: WireFrame[] = [];
const waiters: Array<{ pred: (f: WireFrame) => boolean; resolve: (f: WireFrame) => void; timer: NodeJS.Timeout }> = [];
function waitFor(pred: (f: WireFrame) => boolean, label: string, ms = 20_000): Promise<WireFrame> {
  const hit = seen.find(pred);
  if (hit) return Promise.resolve(hit);
  const { promise, resolve, reject } = Promise.withResolvers<WireFrame>();
  const timer = setTimeout(() => reject(new Error(`等待超时: ${label}`)), ms);
  waiters.push({
    pred,
    resolve: (f) => {
      clearTimeout(timer);
      resolve(f);
    },
    timer,
  });
  return promise;
}

const ws = new WebSocket(wsUrl);
ws.onmessage = (ev) => {
  const f = JSON.parse(String(ev.data)) as WireFrame;
  seen.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(f)) waiters.splice(i, 1)[0].resolve(f);
  }
};
const send = (msg: unknown) => ws.send(JSON.stringify(msg));

await waitFor((f) => f.type === "ready", "ready");
send({ type: "create_session" });
const created = await waitFor((f) => f.type === "session_created", "session_created");
const sessionId = created.sessionId!;
createdFiles.push(created.path!);

// 1)+2) 候选清单：已移除的不在列，该留的仍在
send({ type: "list_commands", sessionId });
const commandsFrame = await waitFor((f) => f.type === "commands", "commands 清单");
const names = (commandsFrame.commands ?? []).map((c) => c.name);
const aliases = (commandsFrame.commands ?? []).flatMap((c) => c.aliases ?? []);
for (const n of REMOVED) {
  if (names.includes(n)) fail(`候选清单仍含已移除命令 /${n}`);
}
if (aliases.includes("models")) fail("候选清单仍含别名 models");
for (const n of KEPT) {
  if (!names.includes(n)) fail(`候选清单丢了应保留的命令 /${n}`);
}
console.log(`✓ 候选清单 ${names.length} 条：已移除 ${REMOVED.join("/")} 均不在列，保留项齐备`);

// 3) 手输已移除命令：提示 + 消费（含别名与冒号形式）
const cases: Array<{ text: string; hint: string }> = [
  { text: "/model", hint: "/model 已移除" },
  { text: "/models", hint: "/models 已移除" },
  { text: "/switch deepseek/deepseek-flash", hint: "/switch 已移除" },
  { text: "/force:bash", hint: "/force 已移除" },
  { text: "/extended-context on", hint: "/extended-context 已移除" },
  { text: "/computer status", hint: "/computer 已移除" },
  { text: "/skillful on", hint: "/skillful 已移除" },
  { text: "/prewalk", hint: "/prewalk 已移除" },
  { text: "/fast status", hint: "/fast 已移除" },
];
const eventsBefore = seen.filter((f) => f.type === "event").length;
for (const c of cases) {
  send({ type: "prompt", sessionId, text: c.text, images: [] });
  const out = await waitFor(
    (f) => f.type === "command_output" && String(f.text).includes(c.hint),
    `${c.text} 的 command_output`,
  );
  await waitFor((f) => f.type === "command_result" && f.text === c.text && f.consumed === true, `${c.text} 的 command_result`);
  console.log(`✓ ${c.text} → ${out.text}`);
}

// 4) 拦截的命令不产生事件帧（没偷偷开 turn）
const eventsAfter = seen.filter((f) => f.type === "event").length;
if (eventsAfter !== eventsBefore) fail(`拦截的命令仍触发 ${eventsAfter - eventsBefore} 条事件帧`);

// 5) 未移除命令照常执行
send({ type: "prompt", sessionId, text: "/context", images: [] });
const ctxOut = await waitFor((f) => f.type === "command_output" && String(f.text).startsWith("Context window"), "/context 的 command_output");
await waitFor((f) => f.type === "command_result" && f.text === "/context", "/context 的 command_result");
console.log(`✓ /context 照常执行：${String(ctxOut.text).split("\n")[0]}`);

console.log("\n全部断言通过");
if (child?.pid) child.kill("SIGTERM");
for (const f of createdFiles) await rm(f).catch(() => {});
process.exit(0);
