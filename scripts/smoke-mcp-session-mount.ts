// Session-bound MCP mounting smoke: verify the pool-boundary lifecycle end to
// end against a real host — create_session mounts visible servers onto the
// tool surface (capabilities snapshot), mcp_detach releases them, and
// load_session (pool-reuse branch) re-mounts idempotently.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-mcp-session-mount.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const profileMcpPath = path.join(agentDir, "mcp.json");
const workDir = path.join("/tmp", `omp-mount-smoke-${Date.now()}`);
mkdirSync(path.join(workDir, "proj"), { recursive: true });

const profileExisted = existsSync(profileMcpPath);
const profileBackup = profileExisted ? readFileSync(profileMcpPath, "utf8") : null;

// Fake stdio MCP server: initialize / tools/list / tools/call(echo)
const serverScript = path.join(workDir, "fake-mcp-server.mjs");
writeFileSync(serverScript, `#!/usr/bin/env bun
import fs from "node:fs";
if (process.env.SMOKE_COUNT_FILE) { try { fs.appendFileSync(process.env.SMOKE_COUNT_FILE, "conn\\n"); } catch {} }
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function handle(msg) {
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { tools: [{ name: "echo", description: "Echo the input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
  } else if (msg.method === "tools/call") {
    reply(msg.id, { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] });
  }
}
`);

// Two fake servers: one global sharing, one project sharing — both must mount.
// Each server process appends a line to the count file on startup: the pool
// must build exactly one connection per server across preload + mount + remount.
const countFile = path.join(workDir, "conn-count.log");
writeFileSync(
  profileMcpPath,
  JSON.stringify(
    {
      mcpServers: {
        "fake-global": { type: "stdio", sharing: "global", command: "bun", args: [serverScript], env: { SMOKE_COUNT_FILE: countFile }, enabled: true },
        "fake-project": { type: "stdio", sharing: "project", command: "bun", args: [serverScript], env: { SMOKE_COUNT_FILE: countFile }, enabled: true },
      },
    },
    null,
    2,
  ),
);

let child: ReturnType<typeof spawn> | null = null;
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  if (child?.pid && !child.killed) child.kill("SIGKILL");
  try {
    if (profileExisted) writeFileSync(profileMcpPath, profileBackup!);
    else if (existsSync(profileMcpPath)) unlinkSync(profileMcpPath);
  } catch {}
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
}
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  restore();
  process.exit(1);
}
process.on("SIGINT", () => { restore(); process.exit(1); });
process.on("SIGTERM", () => { restore(); process.exit(1); });

child = spawn("bun", ["host/host.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, OMP_PROFILE: profile },
  stdio: ["ignore", "pipe", "inherit"],
});

const { promise: wsUrlPromise, resolve: resolveWs, reject: rejectWs } = Promise.withResolvers<string>();
{
  const timer = setTimeout(() => rejectWs(new Error("宿主 30s 未就绪")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolveWs(m[1]);
    }
  });
}
const wsUrl = await wsUrlPromise.catch((e) => fail(String(e)));
console.log("宿主已就绪:", wsUrl);

// Frame matcher queue: multiple frame kinds arrive interleaved, resolve waiters by predicate
const waiters: Array<{ pred: (msg: any) => boolean; resolve: (msg: any) => void; timer: NodeJS.Timeout }> = [];
function waitFrame(pred: (msg: any) => boolean, timeoutMs = 30_000): Promise<any> {
  const { promise, resolve, reject } = Promise.withResolvers<any>();
  const timer = setTimeout(() => {
    const idx = waiters.findIndex((w) => w.pred === pred);
    if (idx >= 0) waiters.splice(idx, 1);
    reject(new Error(`等待帧超时(${timeoutMs}ms)`));
  }, timeoutMs);
  waiters.push({ pred, resolve, timer });
  return promise;
}
const ws = new WebSocket(wsUrl);
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(msg)) {
      const w = waiters[i];
      clearTimeout(w.timer);
      waiters.splice(i, 1);
      w.resolve(msg);
    }
  }
};
ws.onerror = () => fail("WebSocket 连接失败");

{
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.onopen = () => resolve();
  await promise;
}

// Capabilities polling helper: the mount is async, poll until the predicate holds or timeout
async function pollCapabilities(sessionId: string, pred: (mcp: any) => boolean, label: string, timeoutMs = 45_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    ws.send(JSON.stringify({ type: "get_capabilities", sessionId }));
    const frame = await waitFrame((m) => m.type === "capabilities", 10_000);
    if (pred(frame.snapshot?.mcp)) return frame.snapshot.mcp;
    if (Date.now() > deadline) fail(`${label}: 轮询超时，最后快照 ${JSON.stringify(frame.snapshot?.mcp)}`);
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 500);
      await promise;
    }
  }
}

const hasFake = (mcp: any) =>
  Boolean(mcp?.servers?.some((s: any) => s.name === "fake-global")) &&
  Boolean(mcp?.servers?.some((s: any) => s.name === "fake-project"));
const lacksFake = (mcp: any) => !hasFake(mcp);
const fakeToolCount = (mcp: any) =>
  (mcp?.servers ?? []).filter((s: any) => s.name === "fake-global" || s.name === "fake-project").length;
const fakeTools = (mcp: any) => (mcp?.tools ?? 0) >= fakeToolCount(mcp) * 1; // ≥1 tool per fake server

await waitFrame((m) => m.type === "ready");
ws.send(JSON.stringify({ type: "add_project", cwd: path.join(workDir, "proj") }));

console.log("步骤 0: preload_mcp 预热共享池 ...");
ws.send(JSON.stringify({ type: "preload_mcp", cwd: path.join(workDir, "proj") }));
await new Promise((r) => setTimeout(r, 1500));

console.log("步骤 1: create_session 挂载 MCP ...");
ws.send(JSON.stringify({ type: "create_session", cwd: path.join(workDir, "proj") }));
const created = await waitFrame((m) => m.type === "session_created");
const sessionId: string = created.sessionId;
const sessionPath: string = created.path;
console.log(`  会话 ${sessionId.slice(0, 8)} (${path.basename(sessionPath)})`);

const mounted = await pollCapabilities(sessionId, (mcp) => hasFake(mcp) && fakeTools(mcp), "挂载");
const fakeServers = mounted.servers.filter((s: any) => s.name.startsWith("fake-"));
if (fakeServers.some((s: any) => s.status !== "connected")) fail(`fake 服务器状态异常: ${JSON.stringify(fakeServers)}`);
if (mounted.tools < 2) fail(`工具数不足: ${JSON.stringify(mounted)}`);
console.log(`✓ 步骤 1 验证通过: ${fakeServers.length} 台挂载 connected, tools=${mounted.tools}`);

console.log("步骤 2: mcp_detach 释放挂载 ...");
ws.send(JSON.stringify({ type: "mcp_detach", path: sessionPath }));
await waitFrame((m) => m.type === "capabilities_mcp" && m.sessionId === sessionId, 10_000).catch(() => {});
await pollCapabilities(sessionId, lacksFake, "释放");
console.log("✓ 步骤 2 验证通过: capabilities 快照中 fake 服务器已清空");

console.log("步骤 3: load_session 复用分支幂等重挂 ...");
ws.send(JSON.stringify({ type: "load_session", path: sessionPath }));
await waitFrame((m) => m.type === "session_created" && m.path === sessionPath);
const remounted = await pollCapabilities(sessionId, (mcp) => hasFake(mcp) && fakeTools(mcp), "重挂");
if (remounted.tools < 2) fail(`重挂后工具数不足: ${JSON.stringify(remounted)}`);
console.log(`✓ 步骤 3 验证通过: 重挂 tools=${remounted.tools}`);

// Pool-reuse invariant: preload + mount + detach + remount must have built
// exactly ONE connection per fake server (2 total). More means double mounts
// or a pool miss; fewer means a step silently skipped connecting.
{
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 300);
  await promise;
}
const conns = existsSync(countFile) ? readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
if (conns !== 2) fail(`连接数断言失败: 期望 2(每台 server 恰一次),实际 ${conns}`);
console.log("✓ 池复用断言通过: 全流程仅建立 2 条连接(preload 建连, mount/detach/remount 全程复用)");

console.log("★ 会话级 MCP 挂载冒烟全部通过");
restore();
process.exit(0);
