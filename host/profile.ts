// Profile / 桌面环境 / 桌面项目清单：随 activeProfile 动态重载的配置域。
// applyProfile 是重载入口：清空会话池、重建底座（authStorage/modelRegistry/settings）、
// 重读 env 与项目清单、刷新模型目录。
import { setProfile, getAgentDir, normalizeProfileName } from "@oh-my-pi/pi-utils";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { H, DesktopEnv, DesktopProjects, defaultCwd, sessions } from "./state.ts";
import { Settings, ModelRegistry, discoverAuthStorage, saveProfileToDisk, initializeWithSettings } from "./bootstrap.ts";
import { rebuildScopedModels } from "./models.ts";

// ---------- 桌面环境（agentDir 下 desktop-env.json：代理/CA 证书） ----------
export function defaultDesktopEnv(): DesktopEnv {
  return { httpProxy: "", noProxy: "", caCerts: "" };
}

export function readDesktopEnv(): DesktopEnv {
  try {
    const raw = JSON.parse(fs.readFileSync(H.desktopEnvPath, "utf8"));
    return {
      httpProxy: typeof raw.httpProxy === "string" ? raw.httpProxy : "",
      noProxy: typeof raw.noProxy === "string" ? raw.noProxy : "",
      caCerts: typeof raw.caCerts === "string" ? raw.caCerts : "",
    };
  } catch {
    return defaultDesktopEnv();
  }
}

export function applyDesktopEnv(env: DesktopEnv) {
  if (env.httpProxy) {
    process.env.HTTP_PROXY = env.httpProxy;
    process.env.HTTPS_PROXY = env.httpProxy;
    process.env.http_proxy = env.httpProxy;
    process.env.https_proxy = env.httpProxy;
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  }
  if (env.noProxy) {
    process.env.NO_PROXY = env.noProxy;
    process.env.no_proxy = env.noProxy;
  } else {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  }
  if (env.caCerts) process.env.NODE_EXTRA_CA_CERTS = env.caCerts;
  else delete process.env.NODE_EXTRA_CA_CERTS;
}

// ---------- 桌面项目清单（当前 profile 配置目录下 omp-desktop.json，全路径记录） ----------
export function readDesktopProjects(): DesktopProjects {
  try {
    const raw = JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8"));
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    const mcpSharing: Record<string, "session" | "project" | "global"> = {};
    if (raw.mcpSharing && typeof raw.mcpSharing === "object") {
      for (const [k, v] of Object.entries<any>(raw.mcpSharing)) {
        if (v === "session" || v === "project" || v === "global") {
          mcpSharing[k] = v;
        }
      }
    }
    return {
      allProjects: strs(raw.allProjects),
      removedProjects: strs(raw.removedProjects),
      expandedProjects: strs(raw.expandedProjects),
      pinnedSessions: strs(raw.pinnedSessions),
      archivedSessions: strs(raw.archivedSessions),
      mcpSharing,
    };
  } catch {
    return { allProjects: [], removedProjects: [], expandedProjects: [], pinnedSessions: [], archivedSessions: [], mcpSharing: {} };
  }
}

export async function saveDesktopProjects() {
  // 先读磁盘原对象再覆盖托管键：用户手写的非托管段（如 acp 配置）必须原样保留
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8"));
  } catch {}
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...base, ...H.desktopProjects }, null, 2));
}

export function computeMcpSharingKey(sourcePath: string, name: string): string {
  return `${path.resolve(sourcePath)}::${name.trim()}`;
}

export function getMcpSharingConfig(sourcePath?: string, name?: string): "session" | "project" | "global" | undefined {
  if (!sourcePath || !name) return undefined;
  const key = computeMcpSharingKey(sourcePath, name);
  const val = H.desktopProjects?.mcpSharing?.[key];
  if (val === "session" || val === "project" || val === "global") return val;
  return undefined;
}

export async function setMcpSharingConfig(sourcePath: string, name: string, mode: "session" | "project" | "global" | null): Promise<void> {
  if (!H.desktopProjects.mcpSharing) H.desktopProjects.mcpSharing = {};
  const key = computeMcpSharingKey(sourcePath, name);
  if (!mode || mode === "session") {
    // 缺省/会话级不冗余落盘（未记录者即默认 session，保持配置精炼）
    delete H.desktopProjects.mcpSharing[key];
  } else {
    H.desktopProjects.mcpSharing[key] = mode;
  }
  await saveDesktopProjects();
}

export async function deleteMcpSharingConfig(sourcePath?: string, name?: string): Promise<void> {
  if (!sourcePath || !name || !H.desktopProjects.mcpSharing) return;
  const key = computeMcpSharingKey(sourcePath, name);
  if (key in H.desktopProjects.mcpSharing) {
    delete H.desktopProjects.mcpSharing[key];
    await saveDesktopProjects();
  }
}

export async function migrateMcpSharingConfig(oldSourcePath: string, oldName: string, newSourcePath: string, newName: string): Promise<void> {
  const current = getMcpSharingConfig(oldSourcePath, oldName);
  if (current) {
    await deleteMcpSharingConfig(oldSourcePath, oldName);
    await setMcpSharingConfig(newSourcePath, newName, current);
  }
}

// 历史扫描出的新 project 并入所有项目列表（尾部追加）；返回是否有新增。
// 严格过滤：系统临时目录、根目录/家目录、不存在路径及已被移除的项目不并入。
export function mergeHistoryProjects(cwds: string[]): boolean {
  let added = false;
  const home = os.homedir();
  for (const cwd of cwds) {
    if (!cwd || typeof cwd !== "string") continue;
    if (cwd === "/" || cwd === home) continue;
    if (cwd.startsWith("/tmp") || cwd.startsWith("/private/tmp") || cwd.startsWith("/var/folders")) continue;
    if (H.desktopProjects.removedProjects.includes(cwd)) continue;
    if (!fs.existsSync(cwd)) continue;
    if (!H.desktopProjects.allProjects.includes(cwd)) {
      H.desktopProjects.allProjects.push(cwd);
      added = true;
    }
  }
  return added;
}

// ---------- 防睡眠（caffeinate，随 power.sleepPrevention 设置启停） ----------
let sleepProc: ReturnType<typeof Bun.spawn> | null = null;
export function applySleepPrevention(level: string) {
  try {
    sleepProc?.kill();
  } catch {}
  sleepProc = null;
  if (process.platform !== "darwin" || level === "off") return;
  const args = level === "system" ? ["-i", "-s"] : level === "display" ? ["-i", "-d"] : ["-i"];
  sleepProc = Bun.spawn(["caffeinate", ...args, "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
}

// ---------- Profile 列表与切换 ----------
export async function refreshAvailableProfiles(): Promise<string[]> {
  const root = path.join(os.homedir(), ".omp", "profiles");
  const result: string[] = ["default"];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "default") {
        result.push(e.name);
      }
    }
  } catch {}
  if (!result.includes(H.currentProfile)) result.push(H.currentProfile);
  if (!result.includes("omp-desktop")) result.push("omp-desktop");
  H.cachedProfiles = Array.from(new Set(result)).sort((a, b) => {
    if (a === "omp-desktop") return -1;
    if (b === "omp-desktop") return 1;
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
  return H.cachedProfiles;
}

export async function applyProfile(profileName: string) {
  const t0 = performance.now();
  let target = "default";
  try {
    const norm = normalizeProfileName(profileName);
    target = norm || "default";
  } catch (e) {
    throw new Error(`Profile 名称不合法: ${(e as any)?.message || e}`);
  }
  H.currentProfile = target;
  saveProfileToDisk(target);
  setProfile(target === "default" ? undefined : target);

  // 清空现有会话池
  for (const [, entry] of sessions) {
    try {
      entry.unsubscribe?.();
    } catch {}
  }
  sessions.clear();

  H.agentDir = getAgentDir();
  // 启动分段计时（performance.now() 以进程启动为 0 点）：定位 ready 帧前的耗时大头
  let t = performance.now();
  H.authStorage = await discoverAuthStorage(H.agentDir);
  process.stderr.write(`[host][启动计时] discoverAuthStorage: ${(performance.now() - t).toFixed(0)}ms (t=${t.toFixed(0)})\n`);
  t = performance.now();
  H.modelRegistry = new ModelRegistry(H.authStorage);
  // 对齐 CLI 启动语义（main.ts 的 refreshInBackground）：构造函数已同步装载磁盘缓存
  // 目录（models.yml + SQLite 快照），在线发现放后台、不阻塞 ready 帧（实测全量
  // await refresh 要 4s，其中在线目录发现是大头）。刷新完成后重取目录并触发
  // onModelsRefreshed，由 host 侧补推 models 帧。
  const reg = H.modelRegistry;
  reg.refreshInBackground();
  void reg.awaitBackgroundRefresh().then(() => {
    if (H.modelRegistry !== reg) return; // 刷新期间又切了 profile：旧 registry 回调直接弃
    H.availableModels = reg.getAvailable();
    rebuildScopedModels();
    process.stderr.write(`[host][启动计时] 模型目录后台刷新完成: +${(performance.now() - t).toFixed(0)}ms, 可用模型数 ${H.availableModels.length}\n`);
    H.onModelsRefreshed?.();
  });
  process.stderr.write(`[host][启动计时] modelRegistry 构造(缓存目录)+后台刷新启动: ${(performance.now() - t).toFixed(0)}ms (t=${t.toFixed(0)})\n`);
  t = performance.now();
  H.settings = await Settings.init({ cwd: defaultCwd, agentDir: H.agentDir });
  process.stderr.write(`[host][启动计时] Settings.init: ${(performance.now() - t).toFixed(0)}ms (t=${t.toFixed(0)})\n`);
  // 同步能力发现注册表：disabledProviders/enabledProviders → 内存 registry（CLI 入口同款调用，
  // 缺了这步用户禁用的第三方来源在发现层仍显示/按启用处理）
  initializeWithSettings(H.settings);

  H.desktopEnvPath = path.join(H.agentDir, "desktop-env.json");
  H.desktopEnvFilePresent = fs.existsSync(H.desktopEnvPath);
  H.desktopEnv = H.desktopEnvFilePresent ? readDesktopEnv() : defaultDesktopEnv();
  if (H.desktopEnvFilePresent) applyDesktopEnv(H.desktopEnv);

  H.desktopProjectsPath = path.join(H.agentDir, "omp-desktop.json");
  H.desktopProjects = readDesktopProjects();

  const sleep = String(H.settings.get("power.sleepPrevention") ?? "off");
  if (H.settings.isConfigured("power.sleepPrevention") && sleep !== "off") applySleepPrevention(sleep);
  else applySleepPrevention("off");

  H.availableModels = H.modelRegistry.getAvailable();
  rebuildScopedModels();
  H.modelOverride = process.env.OMP_DESKTOP_MODEL
    ? H.availableModels.find((m) => `${m.provider}/${m.id}` === process.env.OMP_DESKTOP_MODEL)
    : undefined;

  if (process.env.OMP_DESKTOP_MODEL && !H.modelOverride) {
    process.stderr.write(`[host] 模型覆盖失败：找不到 ${process.env.OMP_DESKTOP_MODEL}，回退默认选择\n`);
  }
  if (H.scopedModels.length === 0) {
    process.stderr.write("[host] 当前 profile 无可用模型（尚未配置 API Key 或 models.yml）\n");
  }

  await refreshAvailableProfiles();
  process.stderr.write(
    `[host] 已激活 Profile: ${target}, agentDir=${H.agentDir}, 可用模型数: ${H.availableModels.length} [t=${t0.toFixed(0)}ms→${performance.now().toFixed(0)}ms, 总耗时 ${(performance.now() - t0).toFixed(0)}ms]\n`,
  );
}
