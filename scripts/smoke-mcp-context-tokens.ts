// MCP context-token smoke: the context card's "MCP tools" row must price every
// shape an MCP cost can take. Device-mounted tools (tools.xdev on, the default)
// leave the request's tools array, so their cost moves into prompt text — the
// `xd://mcp__x` device catalog (project-context block) and, under
// tools.xdevDocs=inline (or builtins + a matching tools.xdevInlineDevices glob),
// the inlined `## mcp__x` docs block (system-prompt block). get_context_detail
// must report those three buckets separately, because the frontend subtracts each
// one from the row it was counted in.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-mcp-context-tokens.ts
process.env.OMP_PROFILE = process.env.OMP_PROFILE || "omp-desktop-test";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE;
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const mcpPath = path.join(agentDir, "mcp.json");
const configPath = path.join(agentDir, "config.yml");
const mcpBackup = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : null;
const configBackup = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

interface Frame {
  type?: string;
  sessionId?: string;
  path?: string;
  breakdown?: Record<string, unknown>;
  snapshot?: { mcp?: { tools?: number } };
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : -1);

// Same fake server for every mode: five tools, one-line descriptions — small
// enough that the buckets stay readable, large enough that schema and catalog
// tokens differ by an order of magnitude.
const dir = mkdtempSync(path.join(tmpdir(), "omp-ctx-tokens-"));
const serverPath = path.join(dir, "fake-mcp.mjs");
const tools = ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => ({
  name,
  description: `Tool ${name}: does ${name} work on the workspace index and returns a normalized result for downstream steps.`,
  inputSchema: { type: "object", properties: { query: { type: "string", description: "search text" }, limit: { type: "integer" } } },
}));
writeFileSync(
  serverPath,
  `const TOOLS = ${JSON.stringify(tools)};
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
    const out = msg.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe-fake", version: "1" } }
      : msg.method === "tools/list" ? { tools: TOOLS } : undefined;
    if (out) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: out }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);

// mode → expected buckets (empty means 0 tokens). "builtins+glob" re-inlines the
// MCP devices through tools.xdevInlineDevices, so it must match plain "inline".
const MODES: Array<{ name: string; config: string; tools: boolean; prompt: boolean; context: boolean }> = [
  { name: "off", config: "tools:\n  xdev: false\n", tools: true, prompt: false, context: false },
  { name: "catalog", config: "tools:\n  xdev: true\n  xdevDocs: catalog\n", tools: false, prompt: false, context: true },
  { name: "builtins", config: "tools:\n  xdev: true\n  xdevDocs: builtins\n", tools: false, prompt: false, context: true },
  { name: "inline", config: "tools:\n  xdev: true\n  xdevDocs: inline\n", tools: false, prompt: true, context: true },
  {
    name: "builtins+glob",
    config: "tools:\n  xdev: true\n  xdevDocs: builtins\n  xdevInlineDevices:\n    - mcp__probe_fake_*\n",
    tools: false,
    prompt: true,
    context: true,
  },
];

const writeMcpConfig = () =>
  writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: { "probe-fake": { type: "stdio", sharing: "global", command: "bun", args: [serverPath] } } }, null, 2),
  );

let child: ReturnType<typeof spawn> | null = null;
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  if (child?.pid && !child.killed) child.kill("SIGKILL");
  try {
    if (mcpBackup !== null) writeFileSync(mcpPath, mcpBackup);
    else rmSync(mcpPath, { force: true });
    if (configBackup !== null) writeFileSync(configPath, configBackup);
    else rmSync(configPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  } catch {}
};
const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  restore();
  process.exit(1);
};
process.on("SIGINT", () => {
  restore();
  process.exit(1);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(1);
});

/** Boot one host, create a session, read one context_detail frame, tear the host down. */
async function measure(mode: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  child = spawn("bun", ["host/host.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, OMP_PROFILE: profile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<string>();
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) resolveReady(m[1]);
  });
  const { promise: hostReadyTimeout, reject: rejectHostReady } = Promise.withResolvers<string>();
  const hostReadyTimer = setTimeout(() => rejectHostReady(new Error(`${mode}: 宿主 60s 未就绪`)), 60_000);
  const wsUrl = await Promise.race([ready, hostReadyTimeout]).catch((e: Error) => fail(e.message));
  clearTimeout(hostReadyTimer);

  // Frame matcher queue: several frame kinds arrive interleaved; resolve by predicate
  const waiters: Array<{ pred: (m: Frame) => boolean; resolve: (m: Frame) => void; timer: NodeJS.Timeout }> = [];
  const waitFrame = (pred: (m: Frame) => boolean, waitMs = 30_000) => {
    const { promise, resolve, reject } = Promise.withResolvers<Frame>();
    const timer = setTimeout(() => reject(new Error(`${mode}: 等待帧超时(${waitMs}ms)`)), waitMs);
    waiters.push({ pred, resolve, timer });
    return promise;
  };
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Frame;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  };
  const { promise: opened, resolve: resolveOpen } = Promise.withResolvers<void>();
  ws.onopen = () => resolveOpen();
  await opened;

  await waitFrame((m) => m.type === "ready");
  const proj = path.join(dir, `proj-${mode}`);
  mkdirSync(proj, { recursive: true });
  ws.send(JSON.stringify({ type: "add_project", cwd: proj }));
  ws.send(JSON.stringify({ type: "create_session", cwd: proj }));
  const created = await waitFrame((m) => m.type === "session_created");
  const sessionId = String(created.sessionId);

  // The mount is fire-and-forget at the pool boundary: poll until the fake
  // server's five tools are on the surface, then read the breakdown.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    ws.send(JSON.stringify({ type: "get_capabilities", sessionId }));
    const cap = await waitFrame((m) => m.type === "capabilities", 10_000);
    if (num(cap.snapshot?.mcp?.tools) >= 5) break;
    if (Date.now() > deadline) fail(`${mode}: MCP 未挂载 ${JSON.stringify(cap.snapshot?.mcp)}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 400);
    await promise;
  }
  ws.send(JSON.stringify({ type: "get_context_detail", sessionId }));
  const detail = await waitFrame((m) => m.type === "context_detail" && m.sessionId === sessionId, 20_000);
  ws.close();
  child.kill("SIGKILL");
  const b = detail.breakdown ?? {};
  return {
    mcpTools: num(b.mcpToolsTokens),
    mcpPrompt: num(b.mcpPromptTokens),
    mcpContext: num(b.mcpContextTokens),
    other: num(b.otherTokens),
    rowSum:
      num(b.systemToolsTokens) + num(b.systemPromptTokens) + num(b.skillsTokens) + num(b.systemContextTokens) + num(b.messagesTokens),
    used: num(b.usedTokens),
  };
}

for (const mode of MODES) {
  writeFileSync(configPath, mode.config);
  writeMcpConfig();
  const r = await measure(mode.name);
  const got = { tools: Number(r.mcpTools) > 0, prompt: Number(r.mcpPrompt) > 0, context: Number(r.mcpContext) > 0 };
  const want = { tools: mode.tools, prompt: mode.prompt, context: mode.context };
  if (got.tools !== want.tools || got.prompt !== want.prompt || got.context !== want.context) {
    fail(`${mode.name}: 预期 ${JSON.stringify(want)},实际 ${JSON.stringify(got)} (${JSON.stringify(r)})`);
  }
  if (Number(r.other) < 0) fail(`${mode.name}: otherTokens 缺失 (${JSON.stringify(r)})`);
  // The rows still have to add up to the anchored total: the prompt-side buckets
  // are subtracted from the rows that carried them, never double-counted.
  if (Number(r.rowSum) !== Number(r.used)) fail(`${mode.name}: 行合计 ${r.rowSum} ≠ usedTokens ${r.used}`);
  console.log(
    `✓ ${mode.name}: mcpTools=${r.mcpTools} mcpPrompt=${r.mcpPrompt} mcpContext=${r.mcpContext} (other=${r.other})`,
  );
}

console.log("★ MCP 上下文档位冒烟全部通过");
restore();
process.exit(0);
