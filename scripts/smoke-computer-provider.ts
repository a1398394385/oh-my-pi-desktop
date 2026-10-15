// Computer-use provider smoke test: drives the real host over WebSocket and
// verifies the whole Kimi provider chain — set_computer_provider persistence
// (+ builtin warm), test_kimi_cu probing the code-owned kimi-cu connection
// (host/mcp-builtin.ts — mcp.json must stay untouched), the pool boundary NOT
// mounting it, and the composer-icon RPC set_computer_mode mounting/unmounting
// it mid-session from the builtin definition (per-session isolation included:
// a second session stays clean).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-computer-provider.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const cfgPath = path.join(agentDir, "omp-desktop.json");
const mcpPath = path.join(agentDir, "mcp.json");
const fixtureCwd = path.join(homedir(), ".omp/profiles", profile, "run/smoke-computer-provider-fixture");

const backup = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const cfgBackup = backup(cfgPath);
const mcpBackup = backup(mcpPath);

// Deterministic start: no provider pick, no kimi-cu entry (both are restored afterwards)
try {
  const raw = cfgBackup ? (JSON.parse(cfgBackup) as Record<string, unknown>) : {};
  delete raw.computer;
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
} catch {}
try {
  const raw = mcpBackup ? (JSON.parse(mcpBackup) as { mcpServers?: Record<string, unknown> }) : {};
  if (raw.mcpServers) delete raw.mcpServers["kimi-cu"];
  writeFileSync(mcpPath, JSON.stringify(raw, null, 2));
} catch {}
mkdirSync(fixtureCwd, { recursive: true });

const kimiCuOnDisk =
  process.platform === "win32"
    ? existsSync(path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "KimiCU", "kimi-cu.exe"))
    : ["/Applications", path.join(homedir(), "Applications")]
        .some((root) => existsSync(path.join(root, "KimiCU.app/Contents/MacOS/kimi-cu")));

let child: ChildProcess | null = null;
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
  }
  try {
    rmSync(fixtureCwd, { recursive: true, force: true });
  } catch {}
  for (const [p, b] of [
    [cfgPath, cfgBackup],
    [mcpPath, mcpBackup],
  ] as const) {
    try {
      if (b) writeFileSync(p, b);
      else if (existsSync(p)) unlinkSync(p);
    } catch {}
  }
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restore();
  process.exit(1);
}

process.on("SIGINT", () => {
  restore();
  process.exit(1);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(1);
});

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, OMP_PROFILE: profile },
  stdio: ["ignore", "pipe", "inherit"],
});

const wsUrl = await new Promise<string>((resolve, reject) => {
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

console.log("宿主已就绪:", wsUrl, `（KimiCU 安装: ${kimiCuOnDisk}）`);

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => fail("超时未完成供应商链路断言"), 60_000);

let stage = 0;
let session1 = "";
let session2 = "";
let sawSession2Clean = false;
let sawSession2Mode = false;
let sawUnmountClean = false;

// Session 2's capabilities_mcp (async mount callback) and its computer_mode
// (pushed synchronously at create) arrive in no guaranteed order: only start
// tearing down session 1 once both have been observed
function maybeProceedToOff(): void {
  if (stage === 7 && sawSession2Clean && sawSession2Mode) {
    stage = 8;
    console.log("步骤 6: set_computer_mode(off) — 会话中途卸载 kimi-cu");
    ws.send(JSON.stringify({ type: "set_computer_mode", sessionId: session1, enabled: false }));
  }
}

interface McpFrame {
  sessionId?: string;
  mcp?: { servers?: { name: string; status: string }[]; tools?: number };
}
const hasKimiCu = (m: McpFrame | undefined, sid: string): boolean =>
  !!m && m.sessionId === sid && !!m.mcp?.servers?.some((s) => s.name === "kimi-cu" && s.status === "connected");

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "get_settings" }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));

  if (msg.type === "settings") {
    const s = msg.settings ?? {};
    if (stage === 0) {
      if (s.computerProvider !== "default") fail(`初始 provider 应为 default，实际 ${s.computerProvider}`);
      if (s.kimiCuInstalled !== kimiCuOnDisk) fail(`kimiCuInstalled 应为 ${kimiCuOnDisk}，实际 ${s.kimiCuInstalled}`);
      stage = 1;
      console.log("步骤 1: set_computer_provider -> kimi（触发内置预热）");
      ws.send(JSON.stringify({ type: "set_computer_provider", provider: "kimi" }));
    } else if (stage === 1) {
      if (s.computerProvider !== "kimi") fail(`provider 应为 kimi，实际 ${s.computerProvider}`);
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as { computer?: { provider?: string } };
      if (onDisk.computer?.provider !== "kimi") fail(`omp-desktop.json computer.provider 应为 kimi，实际 ${JSON.stringify(onDisk.computer)}`);
      stage = 2;
      console.log("步骤 2: test_kimi_cu（预热即测试，回 mcp_server_tested）");
      ws.send(JSON.stringify({ type: "test_kimi_cu" }));
    }
    return;
  }

  if (msg.type === "mcp_server_tested") {
    if (stage === 2) {
      if (msg.name !== "kimi-cu") fail(`测试回包应为 kimi-cu，实际 ${msg.name}`);
      if (msg.status !== "ok") fail(`test_kimi_cu 应连接成功，实际 ${msg.status}（${msg.error ?? ""}）`);
      // Core cutover assertion: the builtin definition never lands in mcp.json
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        parsed = null;
      }
      const mcpServers = (parsed && typeof parsed === "object" && "mcpServers" in parsed ? parsed.mcpServers : null) as
        | Record<string, unknown>
        | null
        | undefined;
      if (mcpServers && "kimi-cu" in mcpServers) fail("mcp.json 不应包含 kimi-cu（内置定义不落盘）");
      stage = 3;
      console.log("步骤 3: 创建会话 1（池边界不应挂载内置 kimi-cu）");
      ws.send(JSON.stringify({ type: "create_session", cwd: fixtureCwd }));
    }
    return;
  }

  if (msg.type === "session_created") {
    if (stage === 3) {
      session1 = msg.sessionId;
      stage = 4;
      console.log(`[test] 会话 1 已创建 ${session1.slice(0, 8)}，等待其 capabilities_mcp`);
    } else if (stage === 6) {
      session2 = msg.sessionId;
      stage = 7;
      console.log(`[test] 会话 2 已创建 ${session2.slice(0, 8)}（会话 1 的 kimi 应保持开启）`);
    }
    return;
  }

  if (msg.type === "capabilities_mcp") {
    if (stage === 4 && msg.sessionId === session1) {
      if (hasKimiCu(msg, session1)) fail("池边界挂载不应包含 kimi-cu（内置服务器不进可见集）");
      stage = 5;
      console.log("步骤 4: set_computer_mode(on) — 会话中途挂载 kimi-cu");
      ws.send(JSON.stringify({ type: "set_computer_mode", sessionId: session1, enabled: true }));
    } else if (stage === 5 && msg.sessionId === session1) {
      // A mid-session mount lands two frames: capabilities_mcp first, computer_mode second
      if (!hasKimiCu(msg, session1)) fail("中途挂载后 capabilities_mcp 应含 kimi-cu connected");
      if (!(msg.mcp.tools > 0)) fail(`kimi-cu 工具数应 >0，实际 ${msg.mcp.tools}`);
    } else if (stage === 7 && msg.sessionId === session2) {
      if (hasKimiCu(msg, session2)) fail("会话 2 不应看到 kimi-cu（会话级隔离）");
      sawSession2Clean = true;
      maybeProceedToOff();
    } else if (stage === 8 && msg.sessionId === session1) {
      // Unmount pushes capabilities_mcp (kimi-cu gone) before computer_mode:
      // confirm the tool surface drop here; the final exit hangs off the
      // stage-8 computer_mode branch
      if (hasKimiCu(msg, session1)) fail("中途卸载后 capabilities_mcp 不应再含 kimi-cu connected");
      sawUnmountClean = true;
    }
    return;
  }

  if (msg.type === "computer_mode") {
    if (stage === 5 && msg.sessionId === session1) {
      if (msg.enabled !== true) fail("kimi 挂载后 computer_mode 应为 true");
      stage = 6;
      console.log("步骤 5: 会话 1 保持开启，创建会话 2 验证隔离");
      ws.send(JSON.stringify({ type: "create_session", cwd: fixtureCwd }));
    } else if (stage === 7 && msg.sessionId === session2) {
      sawSession2Mode = true;
      maybeProceedToOff();
    } else if (stage === 8 && msg.sessionId === session1) {
      if (msg.enabled !== false) fail("卸载后 computer_mode 应为 false");
      if (!sawUnmountClean) fail("卸载应先推 capabilities_mcp（kimi-cu 已摘除）再推 computer_mode");
      console.log("✓ 供应商选择+预热、测试连接、内置定义不落盘、按会话中途挂载/卸载、会话级隔离全部通过");
      clearTimeout(timer);
      restore();
      process.exit(0);
    }
    return;
  }
};
