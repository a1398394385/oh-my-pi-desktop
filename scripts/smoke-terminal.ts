// 终端 PTY 冒烟：真起宿主 + WS 连入，走 terminal_create/write/resize/dispose 全链路。
// 断言：PTY 建帧回包；敲 echo 有回显数据帧（含期望输出）；resize 后 stty size 反映新尺寸；
// dispose 后桥进程退出（terminal_exit 帧或会话消失）。
// 用法：bun scripts/smoke-terminal.ts
import { spawn } from "node:child_process";

const child = spawn("bun", ["host/host.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "inherit"],
});
function fail(msg: string): never {
  console.error("✗ " + msg);
  child.kill("SIGTERM");
  process.exit(1);
}
const wsUrl = await (async () => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", function onLine(chunk) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); child.stdout!.off("data", onLine); resolve(m[1]); }
  });
  return promise;
})().catch((e) => fail(String(e)));
console.log("宿主已就绪:", wsUrl);

const ws = new WebSocket(wsUrl);
await (() => {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.onopen = () => resolve();
  return promise;
})();

let buf = "";
const dataFrames: string[] = [];
let created: { id: string; shell: string } | null = null;
let exitFrame: { id: string; code: number } | null = null;
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "terminal_created") created = msg;
  if (msg.type === "terminal_data") dataFrames.push(msg.data);
  if (msg.type === "terminal_exit") exitFrame = msg;
};

const send = (obj: unknown) => ws.send(JSON.stringify(obj));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const termId = "smoke-terminal";
send({ type: "terminal_create", id: termId, cwd: "/tmp", cols: 80, rows: 24 });

await sleep(1500);
if (!created) fail("未收到 terminal_created 回包");
if (created.id !== termId) fail(`terminal_created id 不符: ${created.id}`);
console.log(`✓ terminal_created（shell=${created.shell}）`);

// 敲命令：回显帧必须带 echo 的输出
send({ type: "terminal_write", id: termId, data: "echo pty-smoke-$((40+2))\n" });
await sleep(1200);
buf = dataFrames.join("");
if (!buf.includes("pty-smoke-42")) fail("回显帧缺少 echo 输出\n--- 实际输出 ---\n" + buf.slice(-400));
console.log("✓ echo 回显帧含 pty-smoke-42");

// resize：80x24 -> 100x30，stty size 应输出 "30 100"
send({ type: "terminal_resize", id: termId, cols: 100, rows: 30 });
await sleep(400);
send({ type: "terminal_write", id: termId, data: "stty size\n" });
await sleep(1200);
buf = dataFrames.join("");
if (!buf.includes("30 100")) fail("resize 未生效（stty size 无 30 100）");
console.log("✓ resize 生效（stty size -> 30 100）");

// 销毁：宿主杀桥进程，桥退出应推 terminal_exit
send({ type: "terminal_dispose", id: termId });
await sleep(1500);
if (!exitFrame) fail("dispose 后未收到 terminal_exit 帧");
if (exitFrame.id !== termId) fail(`terminal_exit id 不符: ${exitFrame.id}`);
console.log(`✓ dispose 后 terminal_exit（code=${exitFrame.code}）`);

ws.close();
child.kill("SIGTERM");
console.log("终端 PTY 冒烟全绿");
process.exit(0);
