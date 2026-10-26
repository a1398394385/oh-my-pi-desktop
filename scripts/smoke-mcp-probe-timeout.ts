// MCP health-probe regression: a stdio server that ignores SIGTERM must not
// stall the agent_assets frame. The probe feeds listAgentAssets through
// Promise.all, so one server whose `exited` never settles used to hang the whole
// skills/MCP settings payload indefinitely — the lists stayed empty while the
// servers themselves kept working.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-mcp-probe-timeout.ts
process.env.OMP_PROFILE = process.env.OMP_PROFILE || "omp-desktop-test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// OMP_PROFILE must be set before any host module loads (state.ts reads it at
// import time), so these cannot be static imports at the top of the file.
const { H } = await import("../host/state.ts");
const { refreshAvailableProfiles, applyProfile } = await import("../host/profile.ts");
const { probeMcpServerHealth } = await import("../host/mcp-assets.ts");

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// Stubborn server: replies to initialize, then traps SIGTERM and keeps running,
// exactly like the python MCP servers (mcp-atlassian) that triggered the hang.
// It records its own pid so the smoke can assert the probe reaped it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-probe-stubborn-"));
const pidFile = path.join(dir, "pid");
const serverPath = path.join(dir, "stubborn.mjs");
fs.writeFileSync(
  serverPath,
  `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {}); // ignore SIGTERM on purpose
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
);

H.currentProfile = process.env.OMP_PROFILE!;
await refreshAvailableProfiles();
await applyProfile(process.env.OMP_PROFILE!);

// Probe timeout itself is 5s; the cleanup budget is one 500ms SIGTERM grace plus
// one 500ms SIGKILL wait. Anything beyond that means the teardown is unbounded.
const budgetMs = 5_000 + 500 + 500 + 3_000;
const started = Date.now();
const result = await Promise.race([
  probeMcpServerHealth({ name: "stubborn", transport: "stdio", command: "node", args: [serverPath] }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`探测超过 ${budgetMs}ms 未返回`)), budgetMs)),
]).catch((e) => fail(e.message));
const elapsed = Date.now() - started;

if (result.status !== "connected") fail(`期望 connected,实际 ${JSON.stringify(result)}`);
console.log(`✓ 步骤 1 验证通过: 忽略 SIGTERM 的 stdio 服务器探测返回 connected(${elapsed}ms)`);

const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
try {
  process.kill(pid, 0);
  fail(`探测进程未被回收,仍在运行 (pid=${pid})`);
} catch {}
console.log(`✓ 步骤 2 验证通过: 探测进程已退出 (pid=${pid})`);

fs.rmSync(dir, { recursive: true, force: true });
console.log("★ MCP 探测超时回归冒烟全部通过");
process.exit(0);