// 插件总开关冒烟测试：验证 set_plugins_enabled RPC、持久化以及 settings/agent_assets 帧广播。
// 运行命令：OMP_PROFILE=omp-desktop-test bun scripts/smoke-plugins.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const cfgPath = path.join(homedir(), ".omp/profiles", profile, "agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;

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
    if (cfgExisted && cfgBackup) writeFileSync(cfgPath, cfgBackup);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
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
const timer = setTimeout(() => fail("超时未完成插件开关断言"), 15_000);

let stage = 0;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "get_settings" }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "settings") {
    const pluginsEnabled = !!msg.settings?.pluginsEnabled;
    console.log(`[test] 收到 settings 帧，pluginsEnabled: ${pluginsEnabled}`);
    if (stage === 0) {
      stage = 1;
      console.log("步骤 1: 发送 set_plugins_enabled -> true");
      ws.send(JSON.stringify({ type: "set_plugins_enabled", enabled: true }));
    } else if (stage === 1) {
      if (!pluginsEnabled) fail("期望 pluginsEnabled 为 true");
      stage = 2;
      console.log("步骤 2: 发送 set_plugins_enabled -> false");
      ws.send(JSON.stringify({ type: "set_plugins_enabled", enabled: false }));
    } else if (stage === 2) {
      if (pluginsEnabled) fail("期望 pluginsEnabled 为 false");
      stage = 3;
      console.log("步骤 3: 验证 agent_assets 刷新");
      ws.send(JSON.stringify({ type: "list_agent_assets" }));
    }
  } else if (msg.type === "agent_assets" && stage === 3) {
    const assets = msg.assets;
    console.log("[test] 收到 agent_assets 帧");
    if (!Array.isArray(assets?.plugins)) fail("agent_assets.plugins 必须是数组");
    if (assets?.flags?.disableExtensionDiscovery !== true) fail("关闭开关时 disableExtensionDiscovery 必须为 true");
    console.log("✓ 插件开关与资产帧断言全部通过");
    clearTimeout(timer);
    restore();
    process.exit(0);
  }
};
