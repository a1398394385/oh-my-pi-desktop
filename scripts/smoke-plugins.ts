// Plugin master-switch + discovery smoke test: verify the set_plugins_enabled RPC,
// persistence, the settings/agent_assets frame broadcasts, and that a plugin installed
// AFTER the host started shows up on a plain list_agent_assets refresh (no restart) —
// the base loader caches enabled plugins per cwd+home, so this is the regression that
// catches a missing cache invalidation as well as an empty plugin list.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-plugins.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const cfgPath = path.join(homedir(), ".omp/profiles", profile, "agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;

// The user plugin root is profile-independent (~/.omp/plugins). Keep the fixture out of
// the real one: a project-level plugin dir under a temp cwd is resolved by the base
// loader through the same code path and leaves no trace in the user's install tree.
const FIXTURE_CWD = path.join(homedir(), ".omp/profiles", profile, "run/smoke-plugins-fixture");
const FIXTURE_PLUGINS = path.join(FIXTURE_CWD, ".omp/plugins");
const FIXTURE_NAME = "omp-smoke-plugin-fixture";
const FIXTURE_MODULE = path.join(FIXTURE_PLUGINS, "node_modules", FIXTURE_NAME);

function installFixturePlugin(name = FIXTURE_NAME) {
  const moduleDir = path.join(FIXTURE_PLUGINS, "node_modules", name);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(
    path.join(moduleDir, "package.json"),
    JSON.stringify({ name, version: "1.2.3", description: "smoke fixture", pi: { extensions: ["./index.js"] } }),
  );
  writeFileSync(path.join(moduleDir, "index.js"), "export default () => {};\n");

  const pkgPath = path.join(FIXTURE_PLUGINS, "package.json");
  const pkg = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> })
    : {};
  pkg.dependencies = { ...pkg.dependencies, [name]: "1.2.3" };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  const lockPath = path.join(FIXTURE_PLUGINS, "omp-plugins.lock.json");
  const lock = existsSync(lockPath)
    ? (JSON.parse(readFileSync(lockPath, "utf8")) as { plugins?: Record<string, unknown> })
    : { plugins: {}, settings: {} };
  lock.plugins = { ...lock.plugins, [name]: { version: "1.2.3", enabledFeatures: null, enabled: true } };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
}

// The plugin scan walks the registered desktop projects, so the fixture has to be one.
const raw = cfgExisted && cfgBackup ? (JSON.parse(cfgBackup) as Record<string, unknown>) : {};
const projects = Array.isArray(raw.allProjects) ? (raw.allProjects as string[]) : [];
if (!projects.includes(FIXTURE_CWD)) projects.push(FIXTURE_CWD);
writeFileSync(cfgPath, JSON.stringify({ ...raw, allProjects: projects }, null, 2));
installFixturePlugin();

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
    rmSync(FIXTURE_CWD, { recursive: true, force: true });
  } catch {}
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
const timer = setTimeout(() => fail("超时未完成插件开关断言"), 15_000);

let stage = 0;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "get_settings" }));
};

interface PluginRow {
  name?: string;
  version?: string;
  path?: string;
  scope?: string;
  description?: string;
}

interface PluginsPayload {
  profile: PluginRow[];
  projects: { cwd: string; name: string; dir: string; plugins: PluginRow[] }[];
  profileDir: string;
  profileName?: string;
}

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
      console.log("步骤 3: 关闭开关后已收到其附带的 agent_assets 帧（用于下面断言）");
      stage = 3;
    }
  } else if (msg.type === "agent_assets" && stage === 3) {
    // The host broadcasts agent_assets on its own (set_plugins_enabled, profile switch,
    // asset writes), so this frame is not necessarily the reply to any request we sent.
    // Drain until the scene is quiet, then drive the checks off an explicit request/reply.
    stage = 4;
    console.log("步骤 3: 静置广播帧，改为按请求-应答配对断言");
    setTimeout(() => ws.send(JSON.stringify({ type: "list_agent_assets" })), 300);
  } else if (msg.type === "agent_assets" && stage === 4) {
    const assets = msg.assets;
    console.log("[test] 收到 agent_assets 帧");
    const payload = assets?.plugins as PluginsPayload | undefined;
    if (!payload || !Array.isArray(payload.profile) || !Array.isArray(payload.projects)) {
      fail(`agent_assets.plugins 必须是分段结构，实际: ${JSON.stringify(assets?.plugins)}`);
    }
    if (assets?.flags?.disableExtensionDiscovery !== true) fail("关闭开关时 disableExtensionDiscovery 必须为 true");
    if (typeof payload.profileDir !== "string" || !payload.profileDir) fail("plugins.profileDir 必须是非空字符串");

    // The fixture project is registered, so it must get its own section — and the
    // fixture was installed before the host started, so it must already be listed there.
    const sec = payload.projects.find((p) => p.cwd === FIXTURE_CWD);
    if (!sec) fail(`应存在夹具项目 ${FIXTURE_CWD} 的分段，实际项目: ${payload.projects.map((p) => p.cwd)}`);
    const listed = sec.plugins.find((p) => p.name === FIXTURE_NAME);
    if (!listed) fail(`项目分段应列出 ${FIXTURE_NAME}，实际: ${JSON.stringify(sec.plugins)}`);
    if (listed.version !== "1.2.3") fail(`插件版本应为 1.2.3，实际 ${listed.version}`);
    if (listed.scope !== "project") fail(`夹具插件 scope 应为 project，实际 ${listed.scope}`);
    if (listed.path !== FIXTURE_MODULE) fail(`插件路径应为 ${FIXTURE_MODULE}，实际 ${listed.path}`);
    console.log(`[test] 步骤 3 通过：项目分段列出 ${listed.name}@${listed.version} (${listed.scope})`);

    stage = 5;
    console.log("步骤 4: 宿主运行期间新装一个插件，验证刷新可感知（不重启）");
    installFixturePlugin(`${FIXTURE_NAME}-late`);
    setTimeout(() => ws.send(JSON.stringify({ type: "list_agent_assets" })), 300);
  } else if (msg.type === "agent_assets" && stage === 5) {
    const payload = msg.assets?.plugins as PluginsPayload | undefined;
    const sec = payload?.projects.find((p) => p.cwd === FIXTURE_CWD);
    const late = sec?.plugins.find((p) => p.name === `${FIXTURE_NAME}-late`);
    if (!late) {
      fail(`刷新后项目分段应出现运行期新装的 ${FIXTURE_NAME}-late，实际: ${JSON.stringify(sec?.plugins)}`);
    }
    console.log(`[test] 步骤 4 通过：刷新即见 ${late.name}@${late.version}（未重启宿主）`);
    console.log("✓ 插件开关、分段列表与刷新感知断言全部通过");
    clearTimeout(timer);
    restore();
    process.exit(0);
  }
};
