// Slash-command surface smoke test: the 8 removed commands neither enter the candidate list nor execute; other command dispatch is unaffected.
// Usage: bun scripts/smoke-slash-commands.ts [host ws url]
// Without an address the script spawns the host child process itself and deletes the session files it created on exit. Zero model calls.
// Assertions cover:
//   1. The list_commands list excludes model/models/switch/prewalk/fast/skillful/extended-context/computer/force
//   2. The list still contains compact/todo/context/usage/handoff/plan (the filter took no collateral; plan is desktop-injected
//      and TUI-only, absent from the base list)
//   3. Typing a removed command by hand (including the /models alias and the /force:bash colon form) -> command_output notice + command_result(consumed)
//   4. A removed command produces no event frames (neither executes nor lands as a prompt)
//   5. Non-removed commands execute as usual (/context goes through the builtin dispatch)
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
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
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

// 1)+2) Candidate list: removed ones absent, keepers still present
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

// 3) Typing a removed command: notice + consumed (including the alias and colon forms)
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

// 4) Intercepted commands produce no event frames (no sneaky turn opened)
const eventsAfter = seen.filter((f) => f.type === "event").length;
if (eventsAfter !== eventsBefore) fail(`拦截的命令仍触发 ${eventsAfter - eventsBefore} 条事件帧`);

// 5) Non-removed commands execute as usual
send({ type: "prompt", sessionId, text: "/context", images: [] });
const ctxOut = await waitFor((f) => f.type === "command_output" && String(f.text).startsWith("Context window"), "/context 的 command_output");
await waitFor((f) => f.type === "command_result" && f.text === "/context", "/context 的 command_result");
console.log(`✓ /context 照常执行：${String(ctxOut.text).split("\n")[0]}`);

console.log("\n全部断言通过");
if (child?.pid) child.kill("SIGTERM");
for (const f of createdFiles) await rm(f).catch(() => {});
process.exit(0);
