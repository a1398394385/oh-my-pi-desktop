// MCP 实例共享模式与报错日志冒烟测试：验证 rules、保存校验、测试日志捕获
// 运行命令：OMP_PROFILE=omp-desktop-test bun scripts/smoke-mcp-sharing.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const profileMcpPath = path.join(agentDir, "mcp.json");
const testProjectDir = path.join("/tmp", `omp-mcp-test-${Date.now()}`);
mkdirSync(path.join(testProjectDir, ".omp"), { recursive: true });

const profileExisted = existsSync(profileMcpPath);
const profileBackup = profileExisted ? readFileSync(profileMcpPath, "utf8") : null;

let child: ReturnType<typeof spawn> | null = null;
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
  }
  try {
    if (profileExisted && profileBackup) writeFileSync(profileMcpPath, profileBackup);
    else if (existsSync(profileMcpPath)) unlinkSync(profileMcpPath);
    if (existsSync(testProjectDir)) rmSync(testProjectDir, { recursive: true, force: true });
  } catch {}
}

function fail(msg: string): never {
  console.error("✗ " + msg);
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

console.log("宿主已就绪:", wsUrl);

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => fail("超时未完成 MCP 共享冒烟断言"), 25_000);

let step = 0;

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "ready") {
    console.log("步骤 1: 测试失败进程探测日志捕获...");
    step = 1;
    // 测试一个一定会报错的 stdio 命令
    ws.send(JSON.stringify({
      type: "test_mcp_server",
      name: "faulty_server",
      server: {
        command: "sh",
        args: ["-c", "echo 'Error: Connection refused' >&2; exit 42"],
      },
    }));
  } else if (step === 1 && msg.type === "mcp_server_tested") {
    if (msg.status === "ok") fail("期望失败但返回了 ok");
    if (!msg.log || !msg.log.includes("Error: Connection refused") || !msg.log.includes("[退出码] 42")) {
      fail(`日志未捕获到真实 stderr 与退出码: ${msg.log}`);
    }
    console.log("✓ 步骤 1 验证通过: 成功捕获真实 stderr 与退出码");

    console.log("步骤 2: 验证规则 2 - 项目级 MCP 严禁配置为全局共享 (global)，强制纠偏...");
    step = 2;
    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "proj_forbidden",
      scope: `project:${testProjectDir}`,
      config: {
        type: "stdio",
        command: "node",
        sharing: "global",
      },
    }));
  } else if (step === 2 && msg.type === "agent_assets") {
    const projJsonPath = path.join(testProjectDir, ".omp", "mcp.json");
    if (!existsSync(projJsonPath)) fail("项目 mcp.json 未生成");
    const projJson = JSON.parse(readFileSync(projJsonPath, "utf8"));
    const saved = projJson.mcpServers?.["proj_forbidden"];
    if (!saved || saved.sharing === "global") {
      fail(`项目级 MCP 意外允许了 global 共享模式: ${JSON.stringify(saved)}`);
    }
    console.log(`✓ 步骤 2 验证通过: 项目级 global 配置被安全收敛为 ${saved.sharing}`);

    console.log("步骤 3: 验证规则 1 - 缺省时默认为会话级 (session)...");
    step = 3;
    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "profile_default",
      scope: "profile",
      config: {
        type: "stdio",
        command: "node",
        // 未传 sharing
      },
    }));
  } else if (step === 3 && msg.type === "agent_assets") {
    // 检查落盘文件中的 sharing 字段
    const profileJson = JSON.parse(readFileSync(profileMcpPath, "utf8"));
    const saved = profileJson.mcpServers?.["profile_default"];
    if (!saved || saved.sharing !== "session") {
      fail(`缺省值未被设为 session: ${JSON.stringify(saved)}`);
    }
    console.log("✓ 步骤 3 验证通过: 缺省 sharing 自动默认为 session");

    console.log("步骤 4: 验证 Profile 配置允许 global 模式...");
    step = 4;
    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "profile_global",
      scope: "profile",
      config: {
        type: "stdio",
        command: "node",
        sharing: "global",
      },
    }));
  } else if (step === 4 && msg.type === "agent_assets") {
    const profileJson = JSON.parse(readFileSync(profileMcpPath, "utf8"));
    const saved = profileJson.mcpServers?.["profile_global"];
    if (!saved || saved.sharing !== "global") {
      fail(`profile_global 未正确写入: ${JSON.stringify(saved)}`);
    }
    console.log("✓ 步骤 4 验证通过: Profile 级成功配置为 global 模式");

    console.log("步骤 5: 验证 Project 配置允许 project 模式...");
    step = 5;
    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "proj_ok",
      scope: `project:${testProjectDir}`,
      config: {
        type: "stdio",
        command: "node",
        sharing: "project",
      },
    }));
  } else if (step === 5 && msg.type === "agent_assets") {
    const projJsonPath = path.join(testProjectDir, ".omp", "mcp.json");
    const projJson = JSON.parse(readFileSync(projJsonPath, "utf8"));
    const saved = projJson.mcpServers?.["proj_ok"];
    if (!saved || saved.sharing !== "project") {
      fail(`proj_ok 未正确写入: ${JSON.stringify(saved)}`);
    }
    console.log("✓ 步骤 5 验证通过: Project 级成功配置为 project 模式");

    clearTimeout(timer);
    console.log("★ 全部 MCP 共享断言通过！");
    restore();
    process.exit(0);
  }
};
