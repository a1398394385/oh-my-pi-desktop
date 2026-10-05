// MCP instance sharing mode and error-log smoke test: verify rules, save validation, and test-log capture
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-mcp-sharing.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const profileMcpPath = path.join(agentDir, "mcp.json");
const testProjectDir = path.join(tmpdir(), `omp-mcp-test-${Date.now()}`);
mkdirSync(path.join(testProjectDir, ".omp"), { recursive: true });

const profileExisted = existsSync(profileMcpPath);
const profileBackup = profileExisted ? readFileSync(profileMcpPath, "utf8") : null;
const desktopJsonPath = path.join(agentDir, "omp-desktop.json");
const desktopExisted = existsSync(desktopJsonPath);
const desktopBackup = desktopExisted ? readFileSync(desktopJsonPath, "utf8") : null;
const fakeExternalSource = path.join(tmpdir(), `fake-ext-mcp-${Date.now()}.json`);

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
    if (desktopExisted && desktopBackup) writeFileSync(desktopJsonPath, desktopBackup);
    else if (existsSync(desktopJsonPath)) unlinkSync(desktopJsonPath);
    if (existsSync(fakeExternalSource)) unlinkSync(fakeExternalSource);
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

console.log("宿主已就绪:", wsUrl);

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => fail("超时未完成 MCP 共享冒烟断言"), 60_000);

let step = 0;

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "ready") {
    ws.send(JSON.stringify({ type: "add_project", cwd: testProjectDir }));
    console.log("步骤 1: 测试失败进程探测日志捕获...");
    step = 1;
    // Test a stdio command that is guaranteed to fail
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
    const serverInAssets = msg.assets?.mcp?.servers?.find((s: any) => s.name === "proj_forbidden");
    if (!serverInAssets || serverInAssets.sharing === "global") {
      fail(`agent_assets 中项目级 MCP 意外下发了 global: ${JSON.stringify(serverInAssets)}`);
    }
    console.log(`✓ 步骤 2 验证通过: 项目级 global 配置被安全收敛为 ${saved.sharing} (下发一致)`);

    console.log("步骤 3: 验证规则 1 - 缺省时默认为会话级 (session)...");
    step = 3;
    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "profile_default",
      scope: "profile",
      config: {
        type: "stdio",
        command: "node",
        // sharing not passed
      },
    }));
  } else if (step === 3 && msg.type === "agent_assets") {
    // Check the sharing field in the persisted file
    const profileJson = JSON.parse(readFileSync(profileMcpPath, "utf8"));
    const saved = profileJson.mcpServers?.["profile_default"];
    if (!saved || saved.sharing !== "session") {
      fail(`缺省值未被设为 session: ${JSON.stringify(saved)}`);
    }
    const serverInAssets = msg.assets?.mcp?.servers?.find((s: any) => s.name === "profile_default");
    if (!serverInAssets || serverInAssets.sharing !== "session") {
      fail(`agent_assets 中缺省 sharing 未下发 session: ${JSON.stringify(serverInAssets)}`);
    }
    console.log("✓ 步骤 3 验证通过: 缺省 sharing 自动默认为 session (落盘与下发一致)");

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
    const serverInAssets = msg.assets?.mcp?.servers?.find((s: any) => s.name === "profile_global");
    if (!serverInAssets || serverInAssets.sharing !== "global") {
      fail(`agent_assets 中 profile_global 未下发 global: ${JSON.stringify(serverInAssets)}`);
    }
    console.log("✓ 步骤 4 验证通过: Profile 级成功配置并下发 global 模式");

    console.log("步骤 4.5: 再次请求 list_agent_assets 模拟二次刷新，断言 global 模式不被项目扫描覆盖降级...");
    step = 41;
    ws.send(JSON.stringify({ type: "list_agent_assets" }));
  } else if (step === 41 && msg.type === "agent_assets") {
    const serverInAssets = msg.assets?.mcp?.servers?.find((s: any) => s.name === "profile_global");
    if (!serverInAssets || serverInAssets.sharing !== "global") {
      fail(`二次刷新后 profile_global 被错误篡改/降级: ${JSON.stringify(serverInAssets)}`);
    }
    if (serverInAssets.scope !== "profile") {
      fail(`二次刷新后 profile_global scope 被篡改: ${JSON.stringify(serverInAssets)}`);
    }
    console.log("✓ 步骤 4.5 验证通过: 二次扫描后依然保持 Profile 级 global 共享");

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
    const serverInAssets = msg.assets?.mcp?.servers?.find((s: any) => s.name === "proj_ok");
    if (!serverInAssets || serverInAssets.sharing !== "project") {
      fail(`agent_assets 中 proj_ok 未下发 project: ${JSON.stringify(serverInAssets)}`);
    }
    console.log("✓ 步骤 5 验证通过: Project 级成功配置并下发 project 模式");

    console.log("步骤 6: 验证 Profile 配置允许 project 模式 (全局定义按项目隔离)...");
    step = 6;
    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "profile_project",
      scope: "profile",
      config: {
        type: "stdio",
        command: "node",
        sharing: "project",
      },
    }));
  } else if (step === 6 && msg.type === "agent_assets") {
    const profileJson = JSON.parse(readFileSync(profileMcpPath, "utf8"));
    const saved = profileJson.mcpServers?.["profile_project"];
    if (!saved || saved.sharing !== "project") {
      fail(`profile_project 未正确写入: ${JSON.stringify(saved)}`);
    }
    const serverInAssets = msg.assets?.mcp?.servers?.find((s: any) => s.name === "profile_project");
    if (!serverInAssets || serverInAssets.sharing !== "project") {
      fail(`agent_assets 中 profile_project 未下发 project: ${JSON.stringify(serverInAssets)}`);
    }
    console.log("✓ 步骤 6 验证通过: Profile 级成功配置并下发 project 模式");

    console.log("步骤 7: 验证外部来源 MCP 共享模式解耦保存（记入 omp-desktop.json 且不生成 shadow mcp.json）...");
    step = 7;
    writeFileSync(fakeExternalSource, JSON.stringify({
      mcpServers: {
        ext_claude_server: {
          command: "node",
          args: ["-v"],
        },
      },
    }, null, 2));

    ws.send(JSON.stringify({
      type: "save_mcp_server",
      name: "ext_claude_server",
      scope: "profile",
      sourcePath: fakeExternalSource,
      config: {
        type: "stdio",
        command: "node",
        sharing: "project",
      },
    }));
  } else if (step === 7 && msg.type === "agent_assets") {
    if (!existsSync(desktopJsonPath)) fail("omp-desktop.json 未生成");
    const desktopJson = JSON.parse(readFileSync(desktopJsonPath, "utf8"));
    const key = `${path.resolve(fakeExternalSource)}::ext_claude_server`;
    if (desktopJson.mcpSharing?.[key] !== "project") {
      fail(`omp-desktop.json 中未正确记录外部 MCP 共享模式: ${JSON.stringify(desktopJson.mcpSharing)}`);
    }
    if (existsSync(profileMcpPath)) {
      const profileJson = JSON.parse(readFileSync(profileMcpPath, "utf8"));
      if (profileJson.mcpServers?.["ext_claude_server"]) {
        fail("外部 MCP 意外写入了当前 Profile 的 mcp.json，造成了 Shadow 覆盖！");
      }
    }
    console.log("✓ 步骤 7 验证通过: 外部 MCP 成功解耦记入 omp-desktop.json，未创建本地 shadow 文件");

    console.log("步骤 8: 验证删除外部来源 MCP 时，连带清理 omp-desktop.json 中的共享模式映射...");
    step = 8;
    ws.send(JSON.stringify({
      type: "delete_mcp_server",
      name: "ext_claude_server",
      sourcePath: fakeExternalSource,
    }));
  } else if (step === 8 && msg.type === "agent_assets") {
    const desktopJson = JSON.parse(readFileSync(desktopJsonPath, "utf8"));
    const key = `${path.resolve(fakeExternalSource)}::ext_claude_server`;
    if (desktopJson.mcpSharing?.[key] !== undefined) {
      fail(`删除外部 MCP 后，omp-desktop.json 中残留了共享映射: ${JSON.stringify(desktopJson.mcpSharing)}`);
    }
    console.log("✓ 步骤 8 验证通过: 删除外部 MCP 成功清理 omp-desktop.json 映射");

    clearTimeout(timer);
    console.log("★ 全部 MCP 共享断言通过！");
    restore();
    process.exit(0);
  }
};
