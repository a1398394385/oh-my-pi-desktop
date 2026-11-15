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
import { profileAgentPath, smokeEnv } from "./smoke-profile.ts";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const args = process.argv.slice(2);
let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];

// The list differs by design while ACP owns the context, so pin the switch instead
// of trusting whatever the profile happens to hold, then restore it on exit.
const cfgPath = profileAgentPath("omp-desktop.json");
const cfgBackup = readFileSync(cfgPath, "utf8");
function writeAcp(enabled: boolean): void {
  const doc = JSON.parse(cfgBackup) as Record<string, unknown>;
  doc.acp = { ...(doc.acp as object | undefined), enabled };
  writeFileSync(cfgPath, JSON.stringify(doc, null, 2));
}
function restoreConfig(): void {
  try {
    writeFileSync(cfgPath, cfgBackup);
  } catch {}
}
writeAcp(false);

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  for (const f of createdFiles) rm(f).catch(() => {});
  restoreConfig();
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: smokeEnv(),
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

// 3b) /computer is desktop-routed, not "removed": the toggle status line comes back
send({ type: "prompt", sessionId, text: "/computer status", images: [] });
const computerOut = await waitFor(
  (f) => f.type === "command_output" && String(f.text).startsWith("电脑控制："),
  "/computer status 的 command_output",
);
await waitFor((f) => f.type === "command_result" && f.text === "/computer status", "/computer status 的 command_result");
console.log(`✓ /computer 由桌面接管：${String(computerOut.text)}`);

// 4) Intercepted commands produce no event frames (no sneaky turn opened)
const eventsAfter = seen.filter((f) => f.type === "event").length;
if (eventsAfter !== eventsBefore) fail(`拦截的命令仍触发 ${eventsAfter - eventsBefore} 条事件帧`);

// 5) Non-removed commands execute as usual
send({ type: "prompt", sessionId, text: "/context", images: [] });
const ctxOut = await waitFor((f) => f.type === "command_output" && String(f.text).startsWith("Context window"), "/context 的 command_output");
await waitFor((f) => f.type === "command_result" && f.text === "/context", "/context 的 command_result");
console.log(`✓ /context 照常执行：${String(ctxOut.text).split("\n")[0]}`);

// 6) ACP owns the context: /compact leaves the list and hand-typed input is refused
const nextCommands = async (label: string): Promise<CommandEntry[]> => {
  const before = seen.filter((f) => f.type === "commands").length;
  send({ type: "list_commands", sessionId });
  const start = Date.now();
  for (;;) {
    const frames = seen.filter((f) => f.type === "commands");
    if (frames.length > before) return frames.at(-1)!.commands ?? [];
    if (Date.now() - start > 20_000) fail(`等待超时: ${label}`);
    await Bun.sleep(25);
  }
};
writeAcp(true);
const acpNames = (await nextCommands("ACP 开启的 commands 清单")).map((c) => c.name);
if (acpNames.includes("compact")) fail("ACP 开启时候选清单仍含 /compact");
if (!acpNames.includes("todo")) fail("ACP 开启时误删了保留命令");
send({ type: "prompt", sessionId, text: "/compact", images: [] });
const acpOut = await waitFor(
  (f) => f.type === "command_output" && String(f.text).includes("/compact 已移除"),
  "ACP 开启时 /compact 的 command_output",
);
await waitFor((f) => f.type === "command_result" && f.text === "/compact" && f.consumed === true, "ACP 开启时 /compact 的 command_result");
console.log(`✓ ACP 开启：清单不含 /compact，手打被拦 → ${String(acpOut.text).split("\n")[0]}`);
writeAcp(false);
if ((await nextCommands("ACP 关闭的 commands 清单")).some((c) => c.name === "compact") === false) {
  fail("ACP 关闭后 /compact 没有回到清单");
}
console.log("✓ ACP 关闭：/compact 回到清单");

console.log("\n全部断言通过");
if (child?.pid) {
  // Restore only after the child is gone: a late config flush from the host would
  // otherwise overwrite the backup with the pinned value.
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill("SIGTERM");
  await exited;
}
for (const f of createdFiles) await rm(f).catch(() => {});
restoreConfig();
process.exit(0);
