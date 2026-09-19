// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话落在独立 profile `omp-desktop` 下（~/.omp/profiles/omp-desktop/agent），
//   与用户 CLI 的 ~/.omp/agent 隔离；profile 沿用旧 RPC 版的认证（agent.db）
// - UI 壳通过 WebSocket 连入：命令（create/load/prompt/list/get_messages/get_limits 等）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
import { setProfile, getAgentDir, normalizeProfileName } from "@oh-my-pi/pi-utils";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";

const desktopProfileConfigFile = path.join(os.homedir(), ".omp", "desktop-profile.json");
function getSavedProfile(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(desktopProfileConfigFile, "utf8"));
    if (typeof raw.activeProfile === "string" && raw.activeProfile.trim()) {
      return raw.activeProfile.trim();
    }
  } catch {}
  return "omp-desktop";
}

function saveProfileToDisk(profile: string) {
  try {
    const dir = path.dirname(desktopProfileConfigFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(desktopProfileConfigFile, JSON.stringify({ activeProfile: profile }, null, 2), "utf8");
  } catch (err) {
    process.stderr.write(`[host] 保存 desktop-profile.json 失败: ${err}\n`);
  }
}

let currentProfile = getSavedProfile();
// setProfile 必须先于 coding-agent 的 import：其模块在 import 时读取 agentDir
setProfile(currentProfile === "default" ? undefined : currentProfile);

// theme 是 pi-tui 的延迟初始化单例（export var theme 初始 undefined），TUI 启动流程才会
// ensureThemeSync；headless 宿主必须在 coding-agent（含 ask 工具的 theme.status.success）加载前
// 初始化——Bun 对命名导入做快照，事后初始化救不了已加载的 ask.ts
const { ensureThemeSync } = await import("@oh-my-pi/pi-tui/theme");
ensureThemeSync();
const { getSupportedEfforts } = await import("@oh-my-pi/pi-catalog/model-thinking");
const { getProviderDefinition } = await import("@oh-my-pi/pi-ai");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
  await import("@oh-my-pi/pi-coding-agent");
const { Tokenizer } = await import("@oh-my-pi/pi-agent-core");
const { loadCapability } = await import("@oh-my-pi/pi-coding-agent/discovery");
const {
  setMcpServerEnabled,
  addMCPServer,
  updateMCPServer,
  removeMCPServer,
  readDisabledServers,
  readEnabledServers,
} = await import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
const { connectToServer, disconnectServer } = await import("@oh-my-pi/pi-coding-agent/mcp/client");
import { fetchSessionLimits, refreshAllLimits, listAllProviders } from "./limits/index.ts";

// MCP 工具 schema token 估算缓存:tools roster 身份不变就不重算
const mcpTokensCache = new WeakMap<object, number>();

const defaultCwd = os.homedir();

// ---------- 会话池类型与实例（前置声明，方便 profile 切换时清理） ----------
type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type TranscriptItem = {
  role: "user" | "assistant" | "tool" | "thinking" | "loop";
  text: string;
  name?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  files?: string[];
  added?: number;
  removed?: number;
  todo?: { content: string; done: number; total: number };
  thinking?: string;
  expandable?: boolean;
  output?: string; // bash 类工具的输出文本（截断后），供前端展开卡片展示
  details?: any; // read（文件预览）/hub 等工具的详细运行态元数据
  collapsed?: boolean; // loop 组默认收起；展开态由前端切换
  items?: TranscriptItem[]; // role==="loop" 时收纳本轮过程（thinking/tool/中间 assistant）
  durationSec?: number | null; // 本轮工作时长（秒）
  usage?: TurnUsage | null; // 本轮 LLM token 总消耗
};
type PoolEntry = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionResult: Awaited<ReturnType<typeof createAgentSession>>; // setToolUIContext 等宿主注入点
  unsubscribe: () => void;
  transcript: TranscriptItem[];
  assistantDraft: string; // 当前 turn 的流式文本累积，turn_end 时定稿
  thinkingDraft: string;
  thinkingStartedAt: number | null;
  path: string; // 会话文件路径（磁盘标识）
  cwd: string;
  isGit: boolean;
};
const sessions = new Map<string, PoolEntry>(); // key = 前端持有的 sessionId

// MCP 工具(mcp__ 前缀)schema token 单独估算;breakdown 的 systemToolsTokens 含全部工具,
// 前端展示时减去即得纯内置系统工具。roster 身份不变就不重算。
// 注:发布的 pi-coding-agent npm 包不含 modes/utils/context-usage,这里用
// Tokenizer 直接数 wire schema JSON(approximate 模式),不引 SDK 内部模块。
function estimateMcpToolsTokens(entry: PoolEntry): number {
  const tools = entry.session.state?.tools;
  if (!Array.isArray(tools)) return 0;
  const cached = mcpTokensCache.get(tools);
  if (cached !== undefined) return cached;
  const model = entry.session.model;
  if (!model) return 0;
  const fragments: string[] = [];
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || !tool.name.startsWith("mcp__")) continue;
    fragments.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  if (fragments.length === 0) return 0;
  const tokens = new Tokenizer(model).countTokens(fragments);
  mcpTokensCache.set(tools, tokens);
  return tokens;
}

// ---------- 进程级底座（全进程一份，随 activeProfile 动态重载） ----------
let agentDir = getAgentDir();
let authStorage: any;
let modelRegistry: any;
// OMP 登录流程(添加供应商默认入口)进行中标志与提示中转表
let loginInFlight = false;
let loginAbort: AbortController | null = null;
const loginPendingPrompts = new Map<number, (text: string) => void>();
let settings: any;

type DesktopEnv = { httpProxy: string; noProxy: string; caCerts: string };
function defaultDesktopEnv(): DesktopEnv {
  return { httpProxy: "", noProxy: "", caCerts: "" };
}
let desktopEnvPath = path.join(agentDir, "desktop-env.json");
let desktopEnvFilePresent = false;
let desktopEnv: DesktopEnv = defaultDesktopEnv();

function readDesktopEnv(): DesktopEnv {
  try {
    const raw = JSON.parse(fs.readFileSync(desktopEnvPath, "utf8"));
    return {
      httpProxy: typeof raw.httpProxy === "string" ? raw.httpProxy : "",
      noProxy: typeof raw.noProxy === "string" ? raw.noProxy : "",
      caCerts: typeof raw.caCerts === "string" ? raw.caCerts : "",
    };
  } catch {
    return defaultDesktopEnv();
  }
}
function applyDesktopEnv(env: DesktopEnv) {
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
type DesktopProjects = { allProjects: string[]; removedProjects: string[]; expandedProjects: string[]; pinnedSessions: string[] };
let desktopProjectsPath = path.join(agentDir, "omp-desktop.json");
let desktopProjects: DesktopProjects = { allProjects: [], removedProjects: [], expandedProjects: [], pinnedSessions: [] };

function readDesktopProjects(): DesktopProjects {
  try {
    const raw = JSON.parse(fs.readFileSync(desktopProjectsPath, "utf8"));
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return { allProjects: strs(raw.allProjects), removedProjects: strs(raw.removedProjects), expandedProjects: strs(raw.expandedProjects), pinnedSessions: strs(raw.pinnedSessions) };
  } catch {
    return { allProjects: [], removedProjects: [], expandedProjects: [], pinnedSessions: [] };
  }
}
async function saveDesktopProjects() {
  await writeFile(desktopProjectsPath, JSON.stringify(desktopProjects, null, 2));
}
// 历史扫描出的新 project 并入所有项目列表；返回是否有新增
function mergeHistoryProjects(cwds: string[]): boolean {
  let added = false;
  for (const cwd of cwds) {
    if (!desktopProjects.allProjects.includes(cwd)) {
      desktopProjects.allProjects.push(cwd);
      added = true;
    }
  }
  return added;
}

let sleepProc: ReturnType<typeof Bun.spawn> | null = null;
function applySleepPrevention(level: string) {
  try {
    sleepProc?.kill();
  } catch {}
  sleepProc = null;
  if (process.platform !== "darwin" || level === "off") return;
  const args = level === "system" ? ["-i", "-s"] : level === "display" ? ["-i", "-d"] : ["-i"];
  sleepProc = Bun.spawn(["caffeinate", ...args, "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
}

let availableModels: any[] = [];
const enabledDefaults = new Map<string, string | null>();
let scopedModels: any[] = [];
let modelOverride: any;
let cachedProfiles: string[] = ["default", "omp-desktop"];

async function refreshAvailableProfiles(): Promise<string[]> {
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
  if (!result.includes(currentProfile)) result.push(currentProfile);
  if (!result.includes("omp-desktop")) result.push("omp-desktop");
  cachedProfiles = Array.from(new Set(result)).sort((a, b) => {
    if (a === "omp-desktop") return -1;
    if (b === "omp-desktop") return 1;
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
  return cachedProfiles;
}

function rebuildScopedModels() {
  const enabledEntries: string[] = settings.get("enabledModels") ?? [];
  enabledDefaults.clear();
  for (const e of enabledEntries) enabledDefaults.set(e.split(":")[0], e.split(":")[1] ?? null);
  scopedModels =
    enabledDefaults.size > 0 ? availableModels.filter((m) => enabledDefaults.has(`${m.provider}/${m.id}`)) : availableModels;
}

async function applyProfile(profileName: string) {
  let target = "default";
  try {
    const norm = normalizeProfileName(profileName);
    target = norm || "default";
  } catch (e) {
    throw new Error(`Profile 名称不合法: ${(e as any)?.message || e}`);
  }
  currentProfile = target;
  saveProfileToDisk(target);
  setProfile(target === "default" ? undefined : target);

  // 清空现有会话池
  for (const [, entry] of sessions) {
    try {
      entry.unsubscribe?.();
    } catch {}
  }
  sessions.clear();

  agentDir = getAgentDir();
  authStorage = await discoverAuthStorage(agentDir);
  modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh();
  settings = await Settings.init({ cwd: defaultCwd, agentDir });

  desktopEnvPath = path.join(agentDir, "desktop-env.json");
  desktopEnvFilePresent = fs.existsSync(desktopEnvPath);
  desktopEnv = desktopEnvFilePresent ? readDesktopEnv() : defaultDesktopEnv();
  if (desktopEnvFilePresent) applyDesktopEnv(desktopEnv);

  desktopProjectsPath = path.join(agentDir, "omp-desktop.json");
  desktopProjects = readDesktopProjects();

  const sleep = String(settings.get("power.sleepPrevention") ?? "off");
  if (settings.isConfigured("power.sleepPrevention") && sleep !== "off") applySleepPrevention(sleep);
  else applySleepPrevention("off");

  availableModels = modelRegistry.getAvailable();
  rebuildScopedModels();
  modelOverride = process.env.OMP_DESKTOP_MODEL
    ? availableModels.find((m) => `${m.provider}/${m.id}` === process.env.OMP_DESKTOP_MODEL)
    : undefined;

  if (process.env.OMP_DESKTOP_MODEL && !modelOverride) {
    process.stderr.write(`[host] 模型覆盖失败：找不到 ${process.env.OMP_DESKTOP_MODEL}，回退默认选择\n`);
  }
  if (scopedModels.length === 0) {
    process.stderr.write("[host] 当前 profile 无可用模型（尚未配置 API Key 或 models.yml）\n");
  }

  await refreshAvailableProfiles();
  process.stderr.write(`[host] 已激活 Profile: ${target}, agentDir=${agentDir}, 可用模型数: ${availableModels.length}\n`);
}

await refreshAvailableProfiles();
await applyProfile(currentProfile);

function modelsPayload() {
  return scopedModels.map((m) => ({
    id: `${m.provider}/${m.id}`,
    name: m.name ?? m.id,
    efforts: getSupportedEfforts(m),
  }));
}

function settingsSnapshot() {
  return {
    hideThinkingBlock: !!(settings as any).get("hideThinkingBlock"),
    sleepPrevention: settings.isConfigured("power.sleepPrevention") ? (settings.get("power.sleepPrevention") ?? "off") : "off",
    computerEnabled: !!settings.get("computer.enabled"),
    memoryBackend: settings.get("memory.backend") ?? "off",
    approvalMode: settings.get("tools.approvalMode"),
    askTimeout: typeof settings.get("ask.timeout") === "number" ? settings.get("ask.timeout") : 0,
    desktopEnv,
    activeProfile: currentProfile,
    availableProfiles: cachedProfiles,
    profileAgentDir: agentDir,
  };
}

// 扫描 models.yml 的 providers 段,返回其中以 apiKey 显式配置认证的供应商 id。
// 该 key 在 getApiKey 优先级中高于存储凭证,因此视为「配置文件」来源;其余可用供应商
// 即「登录/API key 凭证」来源。models.yml 为手写配置,这里用缩进扫描而非完整 YAML 解析。
function configAuthProviders(): Set<string> {
  const result = new Set<string>();
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(agentDir, "models.yml"), "utf8");
  } catch {
    return result;
  }
  const lines = raw.split("\n");
  let inProviders = false;
  let sectionIndent = -1;
  let current: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inProviders) {
      if (/^providers\s*:\s*$/.test(trimmed)) {
        inProviders = true;
        sectionIndent = indent;
      }
      continue;
    }
    if (indent <= sectionIndent) break; // 离开 providers 段
    const entry = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*$/);
    if (entry && indent === sectionIndent + 2) {
      current = entry[1];
      continue;
    }
    if (current && /^apiKey\s*:/.test(trimmed)) result.add(current);
  }
  return result;
}

function modelCatalog() {
  const enabled = new Set(enabledDefaults.keys());
  const allEnabled = enabled.size === 0;
  const configSet = configAuthProviders();
  return availableModels.map((m) => {
    const id = `${m.provider}/${m.id}`;
    const ctx = (m as any).contextWindow ?? (m as any).contextLength ?? null;
    const vision = Array.isArray((m as any).input) ? (m as any).input.includes("image") : !!(m as any).vision;
    return {
      id,
      name: m.name ?? m.id,
      provider: m.provider,
      enabled: allEnabled || enabled.has(id),
      context: ctx,
      vision,
      efforts: getSupportedEfforts(m),
      // 认证来源:config = models.yml 显式 apiKey;cred = 登录/存储凭证
      authSource: configSet.has(m.provider) ? "config" : "cred",
    };
  });
}

async function firstHeading(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    const m = text.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// agent 定义描述：优先 YAML frontmatter 的 description，退回一级标题
async function agentFileDescription(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const m = fm[1].match(/^description:\s*(.+?)\s*$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
    const h = text.match(/^#\s+(.+)$/m);
    if (h) return h[1].trim();
  } catch {}
  return "";
}

// omp 发现规则：从项目目录向上找最近的 .omp 配置目录
function nearestProjectOmpDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  for (;;) {
    const cand = path.join(dir, ".omp");
    if (fs.existsSync(cand)) return cand;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

// 磁盘资产（agent 定义 / skill / mcp 配置）的三级可读写根：
// 全局 ~/.omp/agent/<sub>、当前 profile 的 agentDir/<sub>、
// 每个桌面项目向上最近的 .omp/<sub>（不存在则以 <项目>/.omp/<sub> 计，供新建落位）
type AssetKind = "agent" | "skill" | "mcp";

interface AssetRoot { dir: string; scope: string; cwd?: string }

function assetRoots(kind: AssetKind): AssetRoot[] {
  const sub = kind === "agent" ? "agents" : "skills";
  const roots: AssetRoot[] = [
    { dir: path.join(os.homedir(), ".omp", "agent", sub), scope: "global" },
    { dir: path.join(agentDir, sub), scope: "profile" },
  ];
  for (const cwd of desktopProjects.allProjects) {
    const ompDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    roots.push({ dir: path.join(ompDir, sub), scope: "project", cwd });
  }
  return roots;
}

// 某级作用域下的 omp 配置目录（mcp.json 所在目录）
function assetOmpDir(kind: AssetKind, scope: unknown, cwd?: unknown): string {
  const s = String(scope ?? "profile");
  if (s === "global") return path.join(os.homedir(), ".omp", "agent");
  if (s === "profile") return agentDir;
  if (s === "project") {
    const c = String(cwd ?? "");
    if (!desktopProjects.allProjects.includes(c)) throw new Error(`未知的项目: ${c}`);
    return nearestProjectOmpDir(c) ?? path.join(path.resolve(c), ".omp");
  }
  throw new Error(`未知的作用域: ${s}`);
}

// mcp.json 候选文件（带点的在前优先读，无前缀为主写入目标）
function mcpCandidates(dir: string): string[] {
  return [path.join(dir, "mcp.json"), path.join(dir, ".mcp.json")];
}

// 所有合法的技能根目录（含全局 OMP/Agents/Claude/Codex/OpenCode、Profile、项目各级）
function allSkillRoots(): string[] {
  const roots: string[] = [
    path.join(os.homedir(), ".omp", "agent", "skills"),
    path.join(os.homedir(), ".omp", "agent", "managed-skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".config", "opencode", "skills"),
    path.join(os.homedir(), ".opencode", "skills"),
    path.join(agentDir, "skills"),
    path.join(agentDir, "managed-skills"),
  ];
  try {
    const customDirs = (settings.get("skills.customDirectories") ?? []) as string[];
    for (const cd of customDirs) {
      const exp = cd.startsWith("~/") ? path.join(os.homedir(), cd.slice(2)) : path.resolve(cd);
      roots.push(exp);
    }
  } catch {}
  for (const cwd of desktopProjects.allProjects) {
    let cur = path.resolve(cwd);
    const root = path.parse(cur).root;
    while (cur && cur !== os.homedir() && cur !== root) {
      roots.push(
        path.join(cur, ".omp", "skills"),
        path.join(cur, ".agents", "skills"),
        path.join(cur, ".agent", "skills"),
        path.join(cur, ".claude", "skills"),
        path.join(cur, ".codex", "skills"),
        path.join(cur, ".opencode", "skills"),
        path.join(cur, ".github", "skills"),
      );
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return roots;
}

// 前端传来的路径必须落在允许的三级根内；目录式定义归一到其入口文件（AGENT.md/SKILL.md）
function resolveAssetFile(kind: AssetKind, p: unknown): string {
  const raw = String(p ?? "");
  let file = path.resolve(raw);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, kind === "skill" ? "SKILL.md" : "AGENT.md");
  if (kind === "mcp") {
    if (file.endsWith(".json") || file.endsWith(".toml")) {
      return file;
    }
    throw new Error(`仅支持 .json 或 .toml 配置文件: ${raw}`);
  }
  if (!file.endsWith(".md")) throw new Error(`仅支持 .md ${kind === "skill" ? "skill" : "agent"} 定义文件`);
  if (kind === "skill") {
    const ok = allSkillRoots().some((root) => {
      const rel = path.relative(root, file);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!ok) throw new Error(`路径不在允许的技能目录内: ${raw}`);
    return file;
  }
  const ok = assetRoots(kind).some((root) => {
    const rel = path.relative(root.dir, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!ok) throw new Error(`路径不在允许的 ${kind} 目录内: ${raw}`);
  return file;
}

async function listNamedDirs(dir: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

async function listNamedFiles(dir: string, ext: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(ext) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name.replace(new RegExp(ext.replace(".", "\\.") + "$"), ""), path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

// 递归发现目录下的所有 SKILL.md 文件（支持嵌套如 research/blocked-page-recovery）
async function findSkillFiles(dir: string, maxDepth = 3): Promise<string[]> {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  async function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".omp") continue;
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        const full = path.join(current, e.name);
        if (e.isDirectory() || e.isSymbolicLink()) {
          const skillMd = path.join(full, "SKILL.md");
          if (fs.existsSync(skillMd)) result.push(skillMd);
          await walk(full, depth + 1);
        }
      }
    } catch {}
  }
  const rootSkill = path.join(dir, "SKILL.md");
  if (fs.existsSync(rootSkill)) result.push(rootSkill);
  await walk(dir, 1);
  return Array.from(new Set(result));
}

// 解析单个 SKILL.md 文件为技能条目
async function parseSkillFile(filePath: string, provider: string, scope: string, isSkillDisabled: (name: string) => boolean) {
  try {
    const text = await readFile(filePath, "utf8");
    let name = path.basename(path.dirname(filePath));
    let description = "";
    const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const n = fmMatch[1].match(/^name:\s*(.+)$/m);
      if (n) name = n[1].trim().replace(/^["\x27]|["\x27]$/g, "");
      const d = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (d) description = d[1].trim().replace(/^["\x27]|["\x27]$/g, "");
    }
    if (!description) {
      const hMatch = text.match(/^#+\s+(.+)$/m);
      if (hMatch) description = hMatch[1].trim();
      else {
        const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*/, "").trim();
        const firstLine = body.split("\n").find((l) => l.trim().length > 0);
        if (firstLine) description = firstLine.trim();
      }
    }
    return {
      name,
      description,
      path: filePath,
      dir: path.dirname(filePath),
      provider,
      scope,
      enabled: !isSkillDisabled(name),
    };
  } catch {
    return null;
  }
}

// 依据 omp 源码 discovery 逻辑，扫描全局、Profile 及各项目的多来源技能
async function loadAllSkillsScoped() {
  const disabled = new Set<string>(((settings.get("disabledExtensions") ?? []) as string[]));
  const ignored = new Set<string>(((settings.get("skills.ignoredSkills") ?? []) as string[]));
  const isSkillDisabled = (name: string) => disabled.has(`skill:${name}`) || ignored.has(name);

  // 全局目录源（兼容 omp、agents、claude、codex、opencode、自定义目录）
  const globalSources = [
    { dir: path.join(os.homedir(), ".omp", "agent", "skills"), provider: "native" },
    { dir: path.join(os.homedir(), ".omp", "agent", "managed-skills"), provider: "managed-skills" },
    { dir: path.join(os.homedir(), ".agents", "skills"), provider: "agents" },
    { dir: path.join(os.homedir(), ".agent", "skills"), provider: "agents" },
    { dir: path.join(os.homedir(), ".claude", "skills"), provider: "claude" },
    { dir: path.join(os.homedir(), ".codex", "skills"), provider: "codex" },
    { dir: path.join(os.homedir(), ".config", "opencode", "skills"), provider: "opencode" },
    { dir: path.join(os.homedir(), ".opencode", "skills"), provider: "opencode" },
  ];
  try {
    const customDirs = (settings.get("skills.customDirectories") ?? []) as string[];
    for (const cd of customDirs) {
      const exp = cd.startsWith("~/") ? path.join(os.homedir(), cd.slice(2)) : path.resolve(cd);
      globalSources.push({ dir: exp, provider: "custom" });
    }
  } catch {}

  const scanSources = async (sources: { dir: string; provider: string }[], scope: string) => {
    const skillMap = new Map<string, any>();
    for (const src of sources) {
      const files = await findSkillFiles(src.dir);
      for (const f of files) {
        const item = await parseSkillFile(f, src.provider, scope, isSkillDisabled);
        if (item && !skillMap.has(item.name)) {
          skillMap.set(item.name, item);
        }
      }
    }
    return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  };

  const scannedGlobal = await scanSources(globalSources, "global");
  const globalItemsMap = new Map<string, any>();
  for (const it of scannedGlobal) globalItemsMap.set(it.name, it);

  try {
    const capRes = await loadCapability<any>("skills", { cwd: agentDir, includeDisabled: true });
    for (const s of capRes.all ?? []) {
      if ((s.level === "user" || s._source?.level === "user") && !globalItemsMap.has(s.name)) {
        const p = s.path || s._source?.path;
        if (p) {
          globalItemsMap.set(s.name, {
            name: s.name,
            description: s.frontmatter?.description || "",
            path: p,
            dir: path.dirname(p),
            provider: s._source?.provider || "native",
            scope: "global",
            enabled: !isSkillDisabled(s.name),
          });
        }
      }
    }
  } catch {}
  const globalItems = Array.from(globalItemsMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const profileSources = [
    { dir: path.join(agentDir, "skills"), provider: "native" },
    { dir: path.join(agentDir, "managed-skills"), provider: "managed-skills" },
  ];
  const profileItems = await scanSources(profileSources, "profile");

  const projects: { cwd: string; name: string; dir: string; skills: any[] }[] = [];
  for (const cwd of desktopProjects.allProjects) {
    const pSources: { dir: string; provider: string }[] = [];
    let cur = path.resolve(cwd);
    const root = path.parse(cur).root;
    while (cur && cur !== os.homedir() && cur !== root) {
      pSources.push(
        { dir: path.join(cur, ".omp", "skills"), provider: "native" },
        { dir: path.join(cur, ".agents", "skills"), provider: "agents" },
        { dir: path.join(cur, ".agent", "skills"), provider: "agents" },
        { dir: path.join(cur, ".claude", "skills"), provider: "claude" },
        { dir: path.join(cur, ".codex", "skills"), provider: "codex" },
        { dir: path.join(cur, ".opencode", "skills"), provider: "opencode" },
        { dir: path.join(cur, ".github", "skills"), provider: "github" },
      );
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const scannedProj = await scanSources(pSources, `project:${cwd}`);
    const projItemsMap = new Map<string, any>();
    for (const it of scannedProj) projItemsMap.set(it.name, it);

    try {
      const pCapRes = await loadCapability<any>("skills", { cwd, includeDisabled: true });
      for (const s of pCapRes.all ?? []) {
        if ((s.level === "project" || s._source?.level === "project") && !projItemsMap.has(s.name)) {
          const p = s.path || s._source?.path;
          if (p) {
            projItemsMap.set(s.name, {
              name: s.name,
              description: s.frontmatter?.description || "",
              path: p,
              dir: path.dirname(p),
              provider: s._source?.provider || "native",
              scope: `project:${cwd}`,
              enabled: !isSkillDisabled(s.name),
            });
          }
        }
      }
    } catch {}

    const skills = Array.from(projItemsMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const primaryDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp", "skills");
    projects.push({ cwd, name: path.basename(cwd), dir: primaryDir, skills });
  }

  return {
    global: globalItems,
    profile: profileItems,
    projects,
    globalDir: path.join(os.homedir(), ".omp", "agent", "skills"),
    profileDir: path.join(agentDir, "skills"),
    profileName: currentProfile,
  };
}

async function listAgentAssets() {
  const memoriesDir = path.join(agentDir, "memories");
  const commands = await listNamedFiles(path.join(agentDir, "commands"), ".md");
  // agent 定义按三级返回：全局 / 当前 profile / 各桌面项目
  interface AssetListPayload {
    global: any[];
    profile: any[];
    projects: { cwd: string; name: string; dir: string; agents?: any[] }[];
    globalDir: string;
    profileDir: string;
    profileName?: string;
  }
  const loadScopedAgents = async (): Promise<AssetListPayload> => {
    const payload: AssetListPayload = {
      global: [],
      profile: [],
      projects: [],
      globalDir: path.join(os.homedir(), ".omp", "agent", "agents"),
      profileDir: path.join(agentDir, "agents"),
    };
    for (const r of assetRoots("agent")) {
      const items = [];
      for (const d of await listNamedDirs(r.dir)) items.push({ name: d.name, path: d.path, description: await agentFileDescription(path.join(d.path, "AGENT.md")) });
      for (const f of await listNamedFiles(r.dir, ".md")) items.push({ name: f.name, path: f.path, description: await agentFileDescription(f.path) });
      if (r.scope === "global") payload.global = items;
      else if (r.scope === "profile") payload.profile = items;
      else payload.projects.push({ cwd: r.cwd!, name: path.basename(r.cwd!), dir: r.dir, agents: items });
    }
    payload.profileName = currentProfile;
    return payload;
  };
  const agents = await loadScopedAgents();
// MCP 健康探测缓存（60秒内避免重复建连）
const mcpHealthCache = new Map<string, { status: "connected" | "error"; error?: string; timestamp: number }>();

async function probeMcpServerHealth(server: {
  name: string;
  transport?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ status: "connected" | "error"; error?: string }> {
  const cached = mcpHealthCache.get(server.name);
  if (cached && Date.now() - cached.timestamp < 60_000) {
    return { status: cached.status, error: cached.error };
  }

  const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
  const config: any = {
    type: transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    cwd: server.cwd,
  };
  try {
    const conn = await Promise.race([
      connectToServer(`probe_${Date.now()}_${server.name}`, config),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("连接超时")), 2000)
      ),
    ]);
    await disconnectServer(conn);
    const res = { status: "connected" as const };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  } catch (err: any) {
    let msg = err?.message || String(err);
    if (msg.includes("Executable not found in $PATH") || msg.includes("ENOENT") || msg.includes("spawn")) {
      msg = "MCP 进程启动失败。";
    } else if (msg.includes("protocol") || msg.includes("version") || msg.includes("negotiation") || msg.includes("UnsupportedProtocolVersion")) {
      msg = "MCP 协议协商失败，服务器版本可能不兼容。可尝试编辑该服务器，将协议版本切换为「兼容旧版」。";
    } else if (msg.includes("ECONNREFUSED")) {
      msg = "MCP 连接失败：目标服务未启动或端口不可达。";
    } else if (msg.includes("连接超时")) {
      msg = "MCP 连接超时：未在 2 秒内响应。";
    }
    const res = { status: "error" as const, error: msg };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  }
}

// 依据 omp 源码的 mcps capability，发现并整合全局、Profile 及各工作区项目的全部 MCP 服务器
async function loadAllMcpScoped() {
  const userMcpPath = path.join(agentDir, "mcp.json");
  const [disabledList, forcedList] = await Promise.all([
    readDisabledServers(userMcpPath).catch(() => [] as string[]),
    readEnabledServers(userMcpPath).catch(() => [] as string[]),
  ]);
  const disabledSet = new Set(disabledList);
  const forcedSet = new Set(forcedList);

  const isServerEnabled = (name: string, rawEnabled?: boolean) => {
    if (disabledSet.has(name)) return false;
    if (rawEnabled === false && !forcedSet.has(name)) return false;
    return true;
  };

  type McpServerItem = {
    name: string;
    transport: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    cwd?: string;
    enabled: boolean;
    source: {
      provider: string;
      providerName: string;
      path: string;
      level: "user" | "project" | "native";
    };
    scope: string; // "profile" | `project:${cwd}`
    projectName?: string;
    status: "connected" | "error" | "disabled" | "unknown";
    error?: string;
  };

  const allServersMap = new Map<string, McpServerItem>();

  // 1. 用户级发现（当前 Profile 及全局外部源，如 ~/.claude.json、~/.cursor/mcp.json、~/.codex/config.toml 等）
  try {
    const userRes = await loadCapability<any>("mcps", { cwd: agentDir, includeDisabled: true });
    for (const s of userRes.items) {
      const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
      const enabled = isServerEnabled(s.name, s.enabled);
      allServersMap.set(s.name, {
        name: s.name,
        transport,
        command: s.command,
        args: s.args,
        url: s.url,
        headers: s.headers,
        env: s.env,
        cwd: s.cwd,
        enabled,
        source: {
          provider: s._source?.provider ?? "native",
          providerName: s._source?.providerName ?? "OMP",
          path: s._source?.path ?? userMcpPath,
          level: s._source?.level ?? "user",
        },
        scope: s._source?.level === "project" ? "project" : "profile",
        status: enabled ? "unknown" : "disabled",
      });
    }
  } catch (err) {
    process.stderr.write(`[host] MCP 用户级发现失败: ${err}\n`);
  }

  // 2. 项目工作区级发现（各个桌面打开的项目）
  const projectScopeList: { cwd: string; name: string; dir: string; count: number }[] = [];
  for (const cwd of desktopProjects.allProjects) {
    let count = 0;
    try {
      const projRes = await loadCapability<any>("mcps", { cwd, includeDisabled: true });
      for (const s of projRes.items) {
        const isProject = s._source?.level === "project";
        const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
        const enabled = isServerEnabled(s.name, s.enabled);
        const item: McpServerItem = {
          name: s.name,
          transport,
          command: s.command,
          args: s.args,
          url: s.url,
          headers: s.headers,
          env: s.env,
          cwd: s.cwd ?? cwd,
          enabled,
          source: {
            provider: s._source?.provider ?? "native",
            providerName: s._source?.providerName ?? "项目配置",
            path: s._source?.path ?? path.join(cwd, ".omp", "mcp.json"),
            level: s._source?.level ?? "project",
          },
          scope: isProject ? `project:${cwd}` : "profile",
          projectName: path.basename(cwd),
          status: enabled ? "unknown" : "disabled",
        };
        allServersMap.set(s.name, item);
        count++;
      }
    } catch (err) {
      process.stderr.write(`[host] MCP 项目级发现失败 (${cwd}): ${err}\n`);
    }

    // 额外兼容如 etower-agent 的 config/mcp-servers.json
    const etowerFile = path.join(cwd, "config", "mcp-servers.json");
    if (fs.existsSync(etowerFile)) {
      try {
        const raw = JSON.parse(await readFile(etowerFile, "utf8"));
        for (const [name, cfg] of Object.entries<any>(raw)) {
          if (!allServersMap.has(name)) {
            const transport = (cfg.url ? "http" : "stdio") as "stdio" | "http";
            const enabled = isServerEnabled(name, cfg.enabled);
            allServersMap.set(name, {
              name,
              transport,
              command: cfg.command,
              args: cfg.args,
              url: cfg.url,
              headers: cfg.headers,
              env: cfg.env,
              cwd,
              enabled,
              source: {
                provider: "etower",
                providerName: "项目配置",
                path: etowerFile,
                level: "project",
              },
              scope: `project:${cwd}`,
              projectName: path.basename(cwd),
              status: enabled ? "unknown" : "disabled",
            });
            count++;
          }
        }
      } catch {}
    }

    const primaryOmpDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    projectScopeList.push({ cwd, name: path.basename(cwd), dir: primaryOmpDir, count });
  }

  const serverList = Array.from(allServersMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  // 3. 并发健康检测（对启用状态的服务器发起快速探测，超时 2s）
  const enabledServers = serverList.filter((s) => s.enabled);
  const probeResults = await Promise.all(
    enabledServers.map(async (s) => {
      const probe = await probeMcpServerHealth(s);
      return { name: s.name, probe };
    })
  );
  const probeMap = new Map(probeResults.map((r) => [r.name, r.probe]));

  for (const s of serverList) {
    if (s.enabled) {
      const p = probeMap.get(s.name);
      if (p) {
        s.status = p.status;
        s.error = p.error;
      } else {
        s.status = "connected";
      }
    } else {
      s.status = "disabled";
      s.error = undefined;
    }
  }

  // 兼容原有资产字段
  const mcpGlobal = { path: path.join(os.homedir(), ".omp", "agent", "mcp.json"), servers: serverList.map((s) => ({ name: s.name, command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "" })) };
  const mcpProfile = { path: userMcpPath, servers: serverList.map((s) => ({ name: s.name, command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "" })) };
  const mcpProjects = projectScopeList.map((p) => ({
    cwd: p.cwd,
    name: p.name,
    path: path.join(p.dir, "mcp.json"),
    servers: serverList.filter((s) => s.scope === `project:${p.cwd}`).map((s) => ({ name: s.name, command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "" })),
  }));

  const scopes = [
    { id: "all", name: "全部工作区", count: serverList.length },
    { id: "profile", name: `Profile · ${currentProfile}`, count: serverList.filter((s) => s.scope === "profile").length, dir: userMcpPath },
    ...projectScopeList.map((p) => ({
      id: `project:${p.cwd}`,
      name: p.name,
      cwd: p.cwd,
      count: serverList.filter((s) => s.scope === `project:${p.cwd}`).length,
      dir: path.join(p.dir, "mcp.json"),
    })),
  ];

  return {
    servers: serverList,
    scopes,
    userMcpPath,
    global: mcpGlobal,
    profile: mcpProfile,
    projects: mcpProjects,
    profileName: currentProfile,
  };
}
  const skills = await loadAllSkillsScoped();
  const mcp = await loadAllMcpScoped();
  const hooks: { name: string; path: string; phase: string }[] = [];
  for (const phase of ["pre", "post"]) {
    for (const f of await listNamedFiles(path.join(agentDir, "hooks", phase), ".ts")) hooks.push({ ...f, phase });
    for (const f of await listNamedFiles(path.join(agentDir, "hooks", phase), ".js")) hooks.push({ ...f, phase });
  }
  // 记忆文件名是 omp 的 encodeProjectPath（cwd 去掉前导斜杠后把 / \ : 换成 -，首尾加 --），
  // 目录名本身含 - 无法前端反解，这里用项目 cwd 逐个匹配，给出末级目录名供展示
  const encodeProjectPath = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  let memories: { name: string; path: string; project?: string }[] = [];
  try {
    const entries = await readdir(memoriesDir, { withFileTypes: true });
    memories = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        const cwd = desktopProjects.allProjects.find((c) => encodeProjectPath(c) === e.name);
        return { name: e.name, path: path.join(memoriesDir, e.name), project: cwd ? path.basename(cwd) : undefined };
      });
  } catch {}  return {
    memories,
    skills,
    commands,
    agents,
    hooks,
    mcp,
    plugins: [] as { name: string }[],
    flags: { enableMCP: false, disableExtensionDiscovery: true, computerEnabled: !!settings.get("computer.enabled") },
  };
}

function streakFromDays(days: string[]): { current: number; longest: number } {
  const uniq = [...new Set(days)].sort();
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of uniq) {
    const t = Date.parse(d + "T00:00:00Z");
    if (prev != null && t - prev === 86400000) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prev = t;
  }
  const today = new Date();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  let current = 0;
  for (let i = 0; i < 400; i++) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    if (uniq.includes(iso(dt))) current += 1;
    else break;
  }
  return { current, longest };
}

async function collectUsageStats() {
  const all = await SessionManager.listAll();
  const byDay: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const heat: Record<string, number> = {};
  let totalTokens = 0;
  let peakTokens = 0;
  let longestMs = 0;
  const daySet: string[] = [];
  for (const s of all) {
    const day = s.modified.toISOString().slice(0, 10);
    daySet.push(day);
    heat[day] = (heat[day] ?? 0) + 1;
    try {
      const text = await readFile(s.path, "utf8");
      const lines = text.split("\n");
      let firstTs: number | null = null;
      let lastTs: number | null = null;
      let sessionTokens = 0;
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (Number.isFinite(ts)) {
          if (firstTs == null || ts < firstTs) firstTs = ts;
          if (lastTs == null || ts > lastTs) lastTs = ts;
        }
        const usage = obj.message?.usage ?? obj.usage;
        const tokens = Number(usage?.totalTokens ?? 0) || Number(usage?.input ?? 0) + Number(usage?.output ?? 0);
        if (tokens > 0) {
          sessionTokens += tokens;
          totalTokens += tokens;
          const model = obj.message?.model ?? obj.model ?? "unknown";
          byModel[model] = (byModel[model] ?? 0) + tokens;
          const d = Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : day;
          byDay[d] = (byDay[d] ?? 0) + tokens;
        }
      }
      if (sessionTokens > peakTokens) peakTokens = sessionTokens;
      if (firstTs != null && lastTs != null && lastTs - firstTs > longestMs) longestMs = lastTs - firstTs;
    } catch {}
  }
  const streak = streakFromDays(daySet);
  return {
    totalTokens,
    peakTokens,
    longestMs,
    sessionCount: all.length,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    byDay,
    byModel,
    heat,
  };
}

// omp 事件 → 前端窄事件（前端只认这些 kind，不依赖 omp 事件 shape 细节）
type UiEvent =
  | { kind: "turn_start" }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking"; phase: "start" | "end"; durationLabel?: string; thinking?: string; expandable?: boolean }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool"; name: string; toolCallId?: string; args?: Record<string, unknown>; files?: string[] }
  | { kind: "tool_update"; name: string; toolCallId?: string; files?: string[]; added?: number; removed?: number; todo?: TranscriptItem["todo"]; output?: string; details?: any }
  | { kind: "turn_end"; usage?: TurnUsage | null };

function pathOf(args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  return "";
}

function collectFiles(name: string, args: any, details?: any): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p !== "string" || !p) return;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm; // 相对路径与绝对路径视为同一文件，保留更完整的
  };
  if (Array.isArray(args?.edits)) for (const e of args.edits) push(e?.path ?? e?.file_path);
  if (Array.isArray(args?.paths)) for (const p of args.paths) push(p);
  if (Array.isArray(args?.files)) for (const f of args.files) push(f);
  if (Array.isArray(details?.files)) for (const f of details.files) push(f);
  if (typeof args?.input === "string" && (name === "apply_patch" || name === "edit")) {
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.input))) push(m[1].trim());
  }
  if (Array.isArray(details?.perFileResults)) for (const f of details.perFileResults) push(f?.path);
  if (typeof details?.path === "string") push(details.path);
  if (typeof details?.resolvedPath === "string") push(details.resolvedPath);
  const p = pathOf(args);
  if (p) push(p);
  return out;
}

function toolArgsForUi(name: string, args: any): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  if (name === "bash" || name === "shell") return { command: String(args.command ?? "").slice(0, 4000) };
  if (name === "eval") return { command: String(args.code ?? args.command ?? "").slice(0, 4000) }; // JS 求值，走终端卡片渲染
  if (name === "grep") return { pattern: String(args.pattern ?? args.query ?? "").slice(0, 500), path: pathOf(args) };
  if (name === "todo") return { op: args.op, task: args.task, i: args.i };
  if (name === "hub") {
    return {
      op: args.op,
      name: args.name,
      application: args.application,
      args: args.args,
      text: args.text,
      cwd: args.cwd,
      i: args.i,
      pty: args.pty,
      to: args.to,
      message: args.message,
    };
  }
  const files = collectFiles(name, args);
  const path = pathOf(args);
  const out: Record<string, unknown> = {};
  if (path) out.path = path;
  if (files.length) out.files = files;
  if (typeof args.content === "string") out.content = args.content.slice(0, 8000);
  return out;
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function thinkingLabel(sec: number): string {
  if (sec < 5) return "持续了几秒";
  if (sec < 60) return `持续了 ${sec} 秒`;
  return `持续了 ${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

function summarizeResult(name: string, args: any, result: any): Partial<TranscriptItem> {
  const details = result?.details ?? (result && typeof result === "object" && "diff" in result ? result : undefined);
  const patch: Partial<TranscriptItem> = {};
  const files = collectFiles(name, args, details);
  if (files.length) patch.files = files;
  if (name === "read") {
    // 透传 TUI 同款渲染数据：displayContent 是模型所见的原文（无行号前缀），行号范围来自 truncation.shownRange
    const dc = details?.displayContent;
    if (dc && typeof dc.text === "string" && dc.text) {
      const MAX = 200_000; // WebSocket 传输与前端渲染的现实边界，正常 read（自带截断）远达不到
      let text = dc.text;
      let lineNumbers = Array.isArray(dc.lineNumbers) ? dc.lineNumbers : undefined;
      if (text.length > MAX) {
        text = text.slice(0, MAX);
        const n = text.split("\n").length;
        if (lineNumbers) lineNumbers = lineNumbers.slice(0, n);
      }
      patch.details = {
        displayContent: { text, startLine: dc.startLine, lineNumbers },
        totalLines: details.totalLines,
        resolvedPath: details.resolvedPath ?? (details.meta?.source?.type === "path" ? details.meta.source.value : undefined),
        shownRange: details.meta?.truncation?.shownRange,
      };
    }
    return patch;
  }
  if (name === "bash" || name === "shell" || name === "eval") {
    // 终端/求值工具：把输出文本带给前端展开卡片（截断，详细走 artifact）
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
      .trim();
    if (text) patch.output = text.slice(0, 20_000);
    return patch;
  }
  if (name === "hub") {
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
      .trim();
    if (text) patch.output = text.slice(0, 20_000);
    if (details) patch.details = details;
    return patch;
  }
  if (name === "todo") {
    const tasks = (details?.phases ?? []).flatMap((p: any) => p.tasks ?? []);
    const done = tasks.filter((t: any) => t.status === "completed").length;
    const cur = tasks.find((t: any) => t.status === "in_progress") ?? tasks[0];
    patch.todo = {
      content: String(args?.task || cur?.content || args?.i || ""),
      done,
      total: tasks.length,
    };
    return patch;
  }
  if (Array.isArray(details?.perFileResults) && details.perFileResults.length > 1) {
    return patch; // 多文件「更改」不带行数
  }
  if (typeof details?.diff === "string") Object.assign(patch, diffStats(details.diff));
  else if ((name === "write" || name === "edit") && typeof args?.content === "string") {
    patch.added = Math.max(1, args.content.split("\n").length);
    patch.removed = 0;
  }
  return patch;
}

function isJunkPlaceholderText(text?: string | null): boolean {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

function flushAssistantDraft(entry: PoolEntry) {
  if (!entry.assistantDraft) return;
  if (!isJunkPlaceholderText(entry.assistantDraft)) {
    entry.transcript.push({ role: "assistant", text: entry.assistantDraft });
  }
  entry.assistantDraft = "";
}

function uiToolPayload(item: TranscriptItem): Extract<UiEvent, { kind: "tool" }> {
  return { kind: "tool", name: item.name ?? item.text, toolCallId: item.toolCallId, args: item.args, files: item.files };
}

// 累加本 run 全部 assistant 消息的 token 用量（agent_end.messages 只含本次 run 新增，不含载入的历史）
function sumRunUsage(messages: any[]): TurnUsage | null {
  let out: TurnUsage | null = null;
  for (const m of messages ?? []) {
    if (m?.role !== "assistant" || !m.usage) continue;
    out = out ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    out.input += m.usage.input || 0;
    out.output += m.usage.output || 0;
    out.cacheRead += m.usage.cacheRead || 0;
    out.cacheWrite += m.usage.cacheWrite || 0;
  }
  return out;
}

function translateEvent(ev: any, entry: PoolEntry): UiEvent | null {
  switch (ev.type) {
    case "agent_start":
      return { kind: "turn_start" };
    case "message_update": {
      const ame = ev.assistantMessageEvent;
      if (ame?.type === "text_delta") {
        entry.assistantDraft += ame.delta;
        return { kind: "text_delta", text: ame.delta };
      }
      if (ame?.type === "thinking_start") {
        flushAssistantDraft(entry);
        entry.thinkingDraft = "";
        entry.thinkingStartedAt = Date.now();
        entry.transcript.push({ role: "thinking", text: "思考" });
        return { kind: "thinking", phase: "start" };
      }
      if (ame?.type === "thinking_delta") {
        entry.thinkingDraft += ame.delta ?? "";
        // hideThinkingBlock 只影响 UI 默认展开与否，不影响数据下发：增量照常转发供流式展示
        return { kind: "thinking_delta", text: ame.delta ?? "" };
      }
      if (ame?.type === "thinking_end") {
        const last = [...entry.transcript].reverse().find((t) => t.role === "thinking");
        const thinking = (ame.content || entry.thinkingDraft || "").trim();
        const sec = entry.thinkingStartedAt ? Math.max(1, Math.round((Date.now() - entry.thinkingStartedAt) / 1000)) : 0;
        const durationLabel = thinkingLabel(sec);
        if (last) {
          last.text = `思考 · ${durationLabel}`;
          last.thinking = thinking;
          last.expandable = thinking.length > 0;
        }
        entry.thinkingDraft = "";
        entry.thinkingStartedAt = null;
        return { kind: "thinking", phase: "end", durationLabel, thinking, expandable: thinking.length > 0 };
      }
      return null;
    }
    case "tool_execution_start": {
      flushAssistantDraft(entry);
      const args = toolArgsForUi(ev.toolName, ev.args);
      const item: TranscriptItem = {
        role: "tool",
        text: ev.toolName,
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        args,
        files: collectFiles(ev.toolName, ev.args),
      };
      entry.transcript.push(item);
      return uiToolPayload(item);
    }
    case "tool_execution_end": {
      const item =
        entry.transcript.findLast?.((t) => t.role === "tool" && t.toolCallId === ev.toolCallId) ??
        [...entry.transcript].reverse().find((t) => t.role === "tool" && t.toolCallId === ev.toolCallId) ??
        [...entry.transcript].reverse().find((t) => t.role === "tool" && t.name === ev.toolName);
      if (item) Object.assign(item, summarizeResult(ev.toolName, { ...(item.args || {}), ...(ev.args || {}) }, ev.result));
      return {
        kind: "tool_update",
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        files: item?.files,
        added: item?.added,
        removed: item?.removed,
        todo: item?.todo,
        output: item?.output,
        details: item?.details,
      };
    }
    case "agent_end":
      // isTerminal === false 表示 maintenance/异步投递还会续跑，不是真正结束
      if (ev.isTerminal === false) return null;
      flushAssistantDraft(entry);
      return { kind: "turn_end", usage: sumRunUsage(ev.messages) };
    default:
      return null;
  }
}

// 磁盘历史条目 → 前端 transcript（思考块可展开；工具带路径/命令/行数）
// 轮次分组：一条用户消息开启一轮，轮内 thinking/tool/中间 assistant 收进 loop 组（收起显示），
// 只把最后一条 assistant 文本留在组外作为该轮的对外结果——与实时 turn_end 的收起行为一致。
function entriesToTranscript(entries: any[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  let run: { items: TranscriptItem[]; usage: TurnUsage | null; startMs: number; endMs: number } | null = null;

  const finalizeRun = () => {
    if (!run) return;
    const r = run;
    run = null;
    let lastA = -1;
    for (let i = r.items.length - 1; i >= 0; i--) {
      if (r.items[i].role === "assistant") {
        lastA = i;
        break;
      }
    }
    const finalOut = lastA >= 0 ? r.items.splice(lastA, 1) : [];
    if (r.items.length) {
      out.push({
        role: "loop",
        text: "",
        collapsed: true,
        items: r.items,
        durationSec: Math.max(1, Math.round((r.endMs - r.startMs) / 1000)),
        usage: r.usage,
      });
    }
    out.push(...finalOut);
  };

  for (const e of entries) {
    if (e.type !== "message") continue;
    const msg = e.message ?? {};
    const { role, content } = msg;
    const ts = Date.parse(e.timestamp ?? "") || 0;
    if (role === "toolResult") {
      if (run && ts) run.endMs = ts;
      const item = byId.get(msg.toolCallId);
      if (item) Object.assign(item, summarizeResult(msg.toolName, item.args, msg));
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    if (role === "user") {
      const text = typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      if (!isJunkPlaceholderText(text)) {
        finalizeRun(); // 有效用户输入开启新一轮
        out.push({ role: "user", text });
        run = { items: [], usage: null, startMs: ts, endMs: ts };
      }
      continue;
    }
    if (run) {
      run.endMs = ts || run.endMs;
      if (msg.usage) {
        run.usage = run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        run.usage.input += msg.usage.input || 0;
        run.usage.output += msg.usage.output || 0;
        run.usage.cacheRead += msg.usage.cacheRead || 0;
        run.usage.cacheWrite += msg.usage.cacheWrite || 0;
      }
    }
    const sink = run ? run.items : out; // run 外的孤儿 assistant（无轮首用户消息）直接平铺，保持旧行为
    if (typeof content === "string") {
      if (!isJunkPlaceholderText(content)) {
        sink.push({ role, text: content });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text") {
        if (!isJunkPlaceholderText(block.text)) {
          sink.push({ role: "assistant", text: block.text });
        }
      } else if (block.type === "thinking" && block.thinking) {
        sink.push({
          role: "thinking",
          text: "思考 · 持续了几秒",
          thinking: String(block.thinking),
          expandable: true,
        });
      } else if (block.type === "toolCall") {
        const item: TranscriptItem = {
          role: "tool",
          text: block.name,
          name: block.name,
          toolCallId: block.id,
          args: toolArgsForUi(block.name, block.arguments),
          files: collectFiles(block.name, block.arguments),
        };
        byId.set(block.id, item);
        sink.push(item);
      }
    }
  }
  finalizeRun();
  return out;
}

// 子代理事件 → 前端窄事件（纯转发，不落父会话 transcript；文本由前端按 subagentId 累积）
function translateSubagentEvent(ev: any): UiEvent | null {
  switch (ev.type) {
    case "agent_start":
      return { kind: "turn_start" };
    case "message_update":
      if (ev.assistantMessageEvent?.type === "text_delta") {
        return { kind: "text_delta", text: ev.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start": {
      const args = toolArgsForUi(ev.toolName, ev.args);
      return { kind: "tool", name: ev.toolName, toolCallId: ev.toolCallId, args, files: collectFiles(ev.toolName, ev.args) };
    }
    case "tool_execution_end":
      return {
        kind: "tool_update",
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        ...summarizeResult(ev.toolName, ev.args, ev.result),
      };
    case "agent_end":
      if (ev.isTerminal === false) return null;
      return { kind: "turn_end" };
    default:
      return null;
  }
}

function isGitWorktree(cwd: string): boolean {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[], initialModel?: any) {
  const result = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings,
    model: initialModel ?? modelOverride,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager,
    disableExtensionDiscovery: true,
    enableMCP: false,
    hasUI: true, // 审批 gate 的 fail-cold 判定走 runner.hasUI()：不开则非 yolo 模式下所有需审批工具直接报错
  });
  const { session } = result;
  const sessionId = crypto.randomUUID();
  const entry: PoolEntry = {
    session,
    sessionResult: result, // setToolUIContext 等宿主注入点
    unsubscribe: () => {},
    transcript,
    assistantDraft: "", // 当前 turn 的流式文本累积，turn_end 时定稿
    thinkingDraft: "",
    thinkingStartedAt: null,
    path: session.sessionFile,
    cwd,
    isGit: isGitWorktree(cwd),
  };
  return { sessionId, entry, eventBus: result.eventBus };
}

// ---------- WebSocket 服务 ----------
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // 动态端口：多 workspace 并行开同名应用时固定端口会撞
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.send(
        JSON.stringify({
          type: "ready",
          approvalMode: settings.get("tools.approvalMode"),
          models: modelsPayload(),
          settings: settingsSnapshot(),
        }),
      );
    },
    async message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "非法 JSON" }));
        return;
      }
      try {
        switch (msg.type) {
          case "create_session":
            await handleCreateSession(ws, msg.cwd, msg.model, msg.thinking);
            break;
          case "load_session":
            await handleLoadSession(ws, msg.path);
            break;
          case "list_sessions":
            await handleListSessions(ws);
            break;
          case "remove_project": {
            // 移出项目列表（会话仍保留在历史中，「最近」视图照常见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            if (!desktopProjects.removedProjects.includes(cwd)) desktopProjects.removedProjects.push(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "delete_session": {
            // 彻底删除会话（物理文件 + 对应 artifacts 目录 + 内存会话池与置顶记录）
            const p = String(msg.path ?? "").trim();
            if (!p) throw new Error("缺少 path");
            for (const [key, entry] of sessions.entries()) {
              if (entry.path === p) {
                try { entry.unsubscribe(); } catch {}
                sessions.delete(key);
              }
            }
            const pi = desktopProjects.pinnedSessions.indexOf(p);
            if (pi >= 0) {
              desktopProjects.pinnedSessions.splice(pi, 1);
              await saveDesktopProjects();
            }
            try {
              await fs.promises.unlink(p);
            } catch (err: any) {
              if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话文件失败: ${err}\n`);
            }
            if (p.endsWith(".jsonl")) {
              const artifactsDir = p.slice(0, -6);
              try {
                await fs.promises.rm(artifactsDir, { recursive: true, force: true });
              } catch (err: any) {
                if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话产物目录失败: ${err}\n`);
              }
            }
            await handleListSessions(ws);
            break;
          }
          case "set_project_expanded": {
            // 项目展开态持久化：记录在 omp-desktop.json expandedProjects，未记录的默认收起
            const cwd = String(msg.cwd ?? "").trim();
            const on = !!msg.expanded;
            if (!cwd) throw new Error("缺少 cwd");
            const i = desktopProjects.expandedProjects.indexOf(cwd);
            if (on && i < 0) desktopProjects.expandedProjects.push(cwd);
            if (!on && i >= 0) desktopProjects.expandedProjects.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "set_session_pinned": {
            // 置顶会话持久化：记录在 omp-desktop.json pinnedSessions，重启保持
            const p = String(msg.path ?? "").trim();
            const on = !!msg.pinned;
            if (!p) throw new Error("缺少 path");
            const i = desktopProjects.pinnedSessions.indexOf(p);
            if (on && i < 0) desktopProjects.pinnedSessions.push(p);
            if (!on && i >= 0) desktopProjects.pinnedSessions.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "add_project": {
            // 手动添加：命中已移除列表则移回所有项目列表，否则作为新项目并入
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            const ri = desktopProjects.removedProjects.indexOf(cwd);
            if (ri >= 0) desktopProjects.removedProjects.splice(ri, 1);
            if (!desktopProjects.allProjects.includes(cwd)) desktopProjects.allProjects.push(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "prompt":
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""), msg.files);
            break;
          case "get_messages":
            handleGetMessages(ws, msg.sessionId);
            break;
          case "get_file_diff": {
            // 单文件详细 diff：tracked 走 git diff HEAD，untracked/仓库外文件用 --no-index 生成纯新增。
            // cwd 外的文件（如 ~/.omp 全局配置）不拒绝：找它自己所在的 git 仓库；不在任何仓库就整文件当新增。
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const filePath = String(msg.path ?? "");
            if (!filePath) throw new Error("缺少 path");
            const abs = path.resolve(cwd, filePath);
            let repoCwd = cwd;
            if (!abs.startsWith(path.resolve(cwd) + path.sep)) {
              const top = Bun.spawnSync(["git", "-C", path.dirname(abs), "rev-parse", "--show-toplevel"], {
                stdout: "pipe",
                stderr: "ignore",
              });
              const topLevel = top.exitCode === 0 ? top.stdout.toString().trim() : "";
              if (topLevel && abs.startsWith(topLevel + path.sep)) repoCwd = topLevel;
            }
            const rel = path.relative(path.resolve(repoCwd), abs);
            const tracked =
              repoCwd === cwd
                ? Bun.spawnSync(["git", "-C", cwd, "ls-files", "--error-unmatch", "--", filePath], {
                    stdout: "ignore",
                    stderr: "ignore",
                  })
                : Bun.spawnSync(["git", "-C", repoCwd, "ls-files", "--error-unmatch", "--", rel], {
                    stdout: "ignore",
                    stderr: "ignore",
                  });
            const args = tracked.exitCode === 0
              ? ["diff", "HEAD", "--", rel]
              : ["diff", "--no-index", "--", "/dev/null", abs];
            const p = Bun.spawnSync(["git", "-C", repoCwd, ...args], { stdout: "pipe", stderr: "pipe" });
            // --no-index 有差异时 exitCode=1 属正常
            if (p.exitCode > 1) throw new Error(`git diff 失败: ${p.stderr.toString().trim().slice(0, 200)}`);
            ws.send(
              JSON.stringify({
                type: "file_diff",
                cwd,
                path: filePath,
                diff: p.stdout.toString().slice(0, 500_000),
              }),
            );
            break;
          }
          case "read_file": {
            // 文件页全文件内容（读取行点击 / 文件树点击详情共用）；限 2MB 文本文件
            const p = String(msg.path ?? "");
            if (!p) throw new Error("缺少 path");
            const stat = fs.statSync(p, { throwIfNoEntry: false });
            if (!stat?.isFile()) throw new Error(`不是文件: ${p}`);
            if (stat.size > 2_000_000) {
              ws.send(JSON.stringify({ type: "file_content", path: p, error: `文件过大（${(stat.size / 1e6).toFixed(1)} MB），仅支持 2MB 内的文本文件` }));
              break;
            }
            const buf = await fs.promises.readFile(p);
            const head = buf.subarray(0, 8000);
            if (head.includes(0)) {
              ws.send(JSON.stringify({ type: "file_content", path: p, error: "二进制文件，不支持文本预览" }));
              break;
            }
            ws.send(JSON.stringify({ type: "file_content", path: p, text: buf.toString("utf8") }));
            break;
          }
          case "list_dir": {
            // 文件树单层列表：目录优先、字母序；隐藏 .git/.DS_Store
            const dir = String(msg.path ?? "");
            if (!dir) throw new Error("缺少 path");
            const stat = fs.statSync(dir, { throwIfNoEntry: false });
            if (!stat?.isDirectory()) throw new Error(`不是目录: ${dir}`);
            const entries: { name: string; dir: boolean }[] = [];
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.name === ".git" || e.name === ".DS_Store") continue;
              entries.push({ name: e.name, dir: e.isDirectory() });
            }
            entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
            ws.send(JSON.stringify({ type: "dir_list", path: dir, entries }));
            break;
          }
          case "get_todos": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            ws.send(JSON.stringify({ type: "todos", sessionId: msg.sessionId, phases: entry.session.getTodoPhases() }));
            break;
          }
          case "get_context_detail": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const b = entry.session.getContextBreakdown();
            const st = entry.session.getSessionStats();
            ws.send(
              JSON.stringify({
                type: "context_detail",
                sessionId: msg.sessionId,
                breakdown: b ? { ...b, mcpToolsTokens: estimateMcpToolsTokens(entry) } : null,
                stats: {
                  tokens: st.tokens,
                  userMessages: st.userMessages,
                  assistantMessages: st.assistantMessages,
                  toolCalls: st.toolCalls,
                  totalMessages: st.totalMessages,
                  premiumRequests: st.premiumRequests,
                  cost: st.cost,
                },
              }),
            );
            break;
          }
          case "get_limits": {
            // 会话当前供应商的套餐限额(token-monitor 移植逻辑,host/limits/)
            // 无会话时(UI 输入框空环 hover)允许按 msg.provider 查询,只显示配额段
            const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
            const ompProvider = entry?.session.model?.provider || String(msg.provider ?? "");
            if (!ompProvider) throw new Error("会话尚未选择模型");
            let baseUrl = "";
            try {
              baseUrl = modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            const { vendor, label, row } = await fetchSessionLimits(authStorage, ompProvider, baseUrl);
            ws.send(
              JSON.stringify({
                type: "limits_result",
                sessionId: msg.sessionId,
                label,
                unsupported: vendor === null,
                status: row?.status ?? "unavailable",
                planLabel: row?.planLabel ?? "",
                accountLabel: row?.accountLabel ?? "",
                balance: row?.balance ?? null,
                windows: row?.windows ?? [],
                updatedAt: row?.updatedAt ?? null,
              }),
            );
            break;
          }
          case "get_provider_limits": {
            // 模型管理页按供应商读配额:命中 limits 60s 缓存,不重复打供应商
            const ompProvider = String(msg.provider ?? "");
            if (!ompProvider) throw new Error("缺少 provider");
            let baseUrl = "";
            try {
              baseUrl = modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            const { vendor, label, row } = await fetchSessionLimits(authStorage, ompProvider, baseUrl);
            ws.send(
              JSON.stringify({
                type: "provider_limits_result",
                provider: ompProvider,
                label,
                unsupported: vendor === null,
                status: row?.status ?? "unavailable",
                planLabel: row?.planLabel ?? "",
                accountLabel: row?.accountLabel ?? "",
                balance: row?.balance ?? null,
                windows: row?.windows ?? [],
                updatedAt: row?.updatedAt ?? null,
              }),
            );
            break;
          }
          case "get_git_diff": {
            // 当前会话 project 的改动文件清单（树/平铺展示用）
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const p = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
            if (p.exitCode !== 0) throw new Error(`git status 失败: ${p.stderr.toString().trim().slice(0, 200) || "非 git 仓库"}`);
            const files = p.stdout
              .toString()
              .split("\n")
              .filter((l) => l.trim())
              .map((line) => {
                let path = line.slice(3);
                const arrow = path.indexOf(" -> "); // rename：R  old -> new
                if (arrow >= 0) path = path.slice(arrow + 4);
                return { code: line.slice(0, 2).trim() || "?", path };
              });
            ws.send(JSON.stringify({ type: "git_status", cwd, files }));
            break;
          }
          case "get_git_branches": {
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const isGit = isGitWorktree(cwd);
            if (!isGit) {
              ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: false, current: null, branches: [] }));
              break;
            }
            const currP = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
            let current = currP.stdout.toString().trim();
            if (!current) {
              const headP = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
              current = headP.stdout.toString().trim() || "HEAD";
            }
            const bP = Bun.spawnSync(["git", "-C", cwd, "branch", "--format=%(refname:short)"], { stdout: "pipe", stderr: "ignore" });
            const branches = bP.stdout.toString().split("\n").map((b) => b.trim()).filter(Boolean);
            ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: true, current, branches }));
            break;
          }
          case "switch_git_branch": {
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const targetBranch = String(msg.branch ?? "").trim();
            if (!targetBranch) throw new Error("缺少 branch");
            const p = Bun.spawnSync(["git", "-C", cwd, "checkout", targetBranch], { stdout: "pipe", stderr: "pipe" });
            if (p.exitCode !== 0) {
              throw new Error(`切换分支失败: ${p.stderr.toString().trim().slice(0, 200)}`);
            }
            ws.send(JSON.stringify({ type: "git_branch_switched", cwd, branch: targetBranch }));
            break;
          }
          case "set_approval_mode": {
            const mode = msg.mode;
            if (mode !== "yolo" && mode !== "write" && mode !== "always-ask") {
              throw new Error(`非法审批模式: ${mode}`);
            }
            // execute-time 解析：无需重建会话，下一个工具调用即生效（对全部会话生效——settings 全进程共享）
            settings.override("tools.approvalMode", mode);
            ws.send(JSON.stringify({ type: "approval_mode", mode }));
            break;
          }
          case "approval_response": {
            const pending = pendingApprovals.get(msg.requestId);
            if (!pending) throw new Error(`审批请求不存在或已结束: ${msg.requestId}`);
            pending.resolve(typeof msg.answer === "string" ? msg.answer : undefined);
            ws.send(JSON.stringify({ type: "approval_resolved", requestId: msg.requestId }));
            break;
          }
          case "set_model": {
            const entry = sessions.get(msg.sessionId);
            process.stderr.write(`[host] set_model: ${msg.model} entry=${!!entry}\n`);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const target = scopedModels.find((m) => `${m.provider}/${m.id}` === msg.model);
            if (!target) throw new Error(`未知模型: ${msg.model}`);
            await entry.session.setModel(target); // persist 默认 false，仅本会话生效
            // enabledModels 条目带的 ":thinking" 默认级别与 CLI 行为一致地应用
            const defaultLevel = enabledDefaults.get(msg.model);
            if (defaultLevel) entry.session.setThinkingLevel(defaultLevel);
            const model = `${entry.session.model.provider}/${entry.session.model.id}`;
            // 模型切换后思考级别可能被能力钳制，一并回传生效值
            ws.send(
              JSON.stringify({
                type: "session_model",
                sessionId: msg.sessionId,
                model,
                thinking: entry.session.thinkingLevel ?? "auto",
              }),
            );
            break;
          }
          case "set_thinking": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            entry.session.setThinkingLevel(msg.level);
            // getter 返回按模型能力钳制后的生效值（如 medium→low），如实回传
            ws.send(
              JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.thinkingLevel ?? "auto" }),
            );
            break;
          }
          case "ui_error": {
            // 前端未捕获错误上报（WKWebView 无 console，dev 终端是唯一出口）
            process.stderr.write(`[ui] ${msg.message}\n`);
            break;
          }
          case "get_settings":
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            break;
          case "reload_settings": {
            // 本地 config 文件可能被手工修改：从磁盘重载（仅模型设置），并推送新模型列表
            try {
              await settings.reloadFromDisk();
              rebuildScopedModels();
              ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            } catch (err) {
              process.stderr.write(`[host] reload_settings 失败: ${err}\n`);
            }
            break;
          }
          case "set_setting": {
            const key = String(msg.key ?? "");
            const value = msg.value;
            if (key === "hideThinkingBlock") {
              try {
                (settings as any).set("hideThinkingBlock", !!value);
              } catch (err) {
                process.stderr.write(`[host] hideThinkingBlock 未写入 schema: ${err}\n`);
              }
            } else if (key === "power.sleepPrevention") {
              const level = value === "system" || value === "display" || value === "idle" || value === "off" ? value : "off";
              settings.set("power.sleepPrevention", level);
              applySleepPrevention(level);
            } else if (key === "computer.enabled") settings.set("computer.enabled", !!value);
            else if (key === "ask.timeout") {
              const secs = Number(value);
              if (!Number.isFinite(secs) || secs < 0) throw new Error("ask.timeout 必须是非负秒数");
              settings.set("ask.timeout", secs);
            } else if (key === "memory.backend") {
              const backend =
                value === "off" || value === "local" || value === "hindsight" || value === "mnemopi" || value === "sharpshooter"
                  ? value
                  : "off";
              settings.set("memory.backend", backend);
            } else throw new Error(`不支持的设置项: ${key}`);
            await settings.flush();
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            break;
          }
          case "set_desktop_env": {
            const next: DesktopEnv = {
              httpProxy: String(msg.httpProxy ?? "").trim(),
              noProxy: String(msg.noProxy ?? "").trim(),
              caCerts: String(msg.caCerts ?? "").trim(),
            };
            await writeFile(desktopEnvPath, JSON.stringify(next, null, 2));
            desktopEnv = next;
            desktopEnvFilePresent = true;
            applyDesktopEnv(next);
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot(), restartHint: true }));
            break;
          }
          case "get_models_catalog":
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          case "get_all_providers":
            ws.send(
              JSON.stringify({
                type: "all_providers",
                providers: listAllProviders().map((p) => ({
                  ...p,
                  // 登录能力:OAuth/login 流存在即可(API key 对所有供应商可用)
                  login: !!getProviderDefinition(p.id)?.login,
                })),
              }),
            );
            break;
          case "provider_login": {
            // OMP 登录流程(AuthStorage.login):浏览器授权 + 需要粘贴码时经 UI 弹窗中转
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            if (loginInFlight) throw new Error("已有登录流程进行中，请完成或稍后再试");
            loginInFlight = true;
            loginAbort = new AbortController();
            const reqId = msg.reqId ?? null;
            const wsRef = ws;
            const reply = (obj: Record<string, unknown>) => {
              try {
                wsRef.send(JSON.stringify({ reqId, ...obj }));
              } catch {}
            };
            reply({ type: "login_progress", provider, message: "正在启动登录…" });
            let promptSeq = 0;
            try {
              const identity = await authStorage.login(provider, {
                signal: loginAbort.signal,
                onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
                  if (loginAbort?.signal.aborted) return;
                  const url = info.launchUrl ?? info.url;
                  if (url) {
                    try {
                      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
                    } catch {}
                  }
                  reply({
                    type: "login_progress",
                    provider,
                    message: info.instructions || "已在浏览器打开登录页面，请完成授权…",
                    url: url ?? "",
                  });
                },
                onProgress: (message: string) => reply({ type: "login_progress", provider, message: String(message) }),
                onPrompt: (prompt: { message?: string; secret?: boolean }) =>
                  new Promise<string>((resolve, reject) => {
                    const id = ++promptSeq;
                    loginPendingPrompts.set(id, resolve);
                    loginAbort?.signal.addEventListener(
                      "abort",
                      () => {
                        loginPendingPrompts.delete(id);
                        reject(new Error("aborted"));
                      },
                      { once: true },
                    );
                    reply({ type: "login_prompt", provider, id, message: String(prompt.message ?? ""), secret: !!prompt.secret });
                  }),
              });
              // 登录成功:重新拉取模型目录(新凭证使供应商可用),并推送最新列表
              await modelRegistry.refresh();
              availableModels = modelRegistry.getAvailable();
              rebuildScopedModels();
              reply({ type: "models", models: modelsPayload() });
              reply({ type: "models_catalog", models: modelCatalog() });
              reply({ type: "login_done", provider, ok: true, identity: identity ?? null });
            } catch (err) {
              const aborted = loginAbort?.signal.aborted;
              reply({
                type: "login_done",
                provider,
                ok: false,
                cancelled: !!aborted,
                message: aborted ? "登录已取消" : String((err as any)?.message ?? err),
              });
            } finally {
              loginInFlight = false;
              loginAbort = null;
            }
            break;
          }
          case "provider_login_cancel": {
            // 用户显式取消(如关闭了登录页):中断进行中的登录流程
            if (loginInFlight && loginAbort) loginAbort.abort();
            else throw new Error("当前没有进行中的登录流程");
            break;
          }
          case "provider_set_key": {
            // 配置 API key:写入 authStorage(api_key 凭证),随后刷新模型目录
            const provider = String(msg.provider ?? "");
            const key = String(msg.key ?? "").trim();
            if (!provider) throw new Error("缺少 provider");
            if (!key) throw new Error("API key 不能为空");
            authStorage.upsertCredential(provider, { type: "api_key", key });
            await modelRegistry.refresh();
            availableModels = modelRegistry.getAvailable();
            rebuildScopedModels();
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            ws.send(JSON.stringify({ type: "provider_key_done", provider, ok: true }));
            break;
          }
          case "login_prompt_reply": {
            const resolve = loginPendingPrompts.get(Number(msg.id));
            if (resolve) {
              loginPendingPrompts.delete(Number(msg.id));
              resolve(String(msg.text ?? ""));
            }
            break;
          }
          case "open_models_config": {
            // 「手动添加供应商」:打开配置层 models.yml(不存在则创建空文件)
            const modelsPath = path.join(agentDir, "models.yml");
            try {
              if (!fs.existsSync(modelsPath)) fs.writeFileSync(modelsPath, "# omp 供应商配置,参考文档编辑\n");
              Bun.spawn(["open", modelsPath], { stdout: "ignore", stderr: "ignore" });
            } catch {}
            ws.send(JSON.stringify({ type: "models_config_path", path: modelsPath }));
            break;
          }
          case "open_folder": {
            const raw = String(msg.path ?? "");
            if (raw) {
              try {
                if (!fs.existsSync(raw)) await mkdir(raw, { recursive: true });
                Bun.spawn(["open", raw], { stdout: "ignore", stderr: "ignore" });
              } catch {}
            }
            break;
          }
          case "set_enabled_model": {
            const id = String(msg.id ?? "");
            const on = !!msg.enabled;
            if (!availableModels.some((m) => `${m.provider}/${m.id}` === id)) throw new Error(`未知模型: ${id}`);
            let entries: string[] = (settings.get("enabledModels") ?? []).slice();
            if (entries.length === 0) {
              entries = availableModels.map((m) => `${m.provider}/${m.id}`);
            }
            const without = entries.filter((e) => e.split(":")[0] !== id);
            if (on) {
              const prev = entries.find((e) => e.split(":")[0] === id);
              without.push(prev ?? id);
            }
            if (without.length === 0) throw new Error("至少保留一个启用模型");
            settings.set("enabledModels", without);
            await settings.flush();
            rebuildScopedModels();
            if (scopedModels.length === 0) throw new Error("启用列表过滤后没有可用模型");
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          }
          case "get_usage_stats":
            ws.send(JSON.stringify({ type: "usage_stats", stats: await collectUsageStats() }));
            break;
          case "list_agent_assets": {
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_file_read": {
            const kind = String(msg.kind ?? "agent") as AssetKind;
            const file = resolveAssetFile(kind, msg.path);
            const content = await readFile(file, "utf8");
            ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
            break;
          }
          case "memory_file_read": {
            const raw = String(msg.path ?? "");
            const file = path.resolve(raw);
            const rel = path.relative(path.resolve(path.join(agentDir, "memories")), file);
            if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径不在允许的记忆目录内: ${raw}`);
            // 工作区记忆是目录：返回顶层 .md 清单（按修改时间新→旧）并默认读最新的一个
            let target = file;
            let files: string[] | undefined;
            let rollouts: string[] | undefined;
            if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
              const mtime = (dir: string, n: string) => {
                try {
                  return fs.statSync(path.join(dir, n)).mtimeMs;
                } catch {
                  return 0;
                }
              };
              files = (await readdir(file))
                .filter((n) => n.endsWith(".md") && !n.startsWith("."))
                .sort((a, b) => mtime(file, b) - mtime(file, a));
              if (!files.length) throw new Error(`记忆目录内没有 .md 文件: ${raw}`);
              target = path.join(file, files[0]);
              const rollDir = path.join(file, "rollout_summaries");
              rollouts = (await readdir(rollDir).catch(() => [] as string[]))
                .filter((n) => n.endsWith(".md") && !n.startsWith("."))
                .sort((a, b) => mtime(rollDir, b) - mtime(rollDir, a));
            }
            const content = await readFile(target, "utf8");
            ws.send(JSON.stringify({ type: "memory_file", path: file, file: path.basename(target), files, rollouts, content }));
            break;
          }
          case "asset_file_write": {
            const kind = String(msg.kind ?? "agent") as AssetKind;
            const file = resolveAssetFile(kind, msg.path);
            await writeFile(file, String(msg.content ?? ""), "utf8");
            ws.send(JSON.stringify({ type: "asset_file_saved", kind, path: file }));
            break;
          }
          case "asset_file_create": {
            // 按作用域与资产类型落位：agent=agents/<name>.md、skill=skills/<name>/SKILL.md、mcp=该级 mcp.json（幂等，已存在则直接返回内容）
            const kind = String(msg.kind ?? "agent") as AssetKind;
            if (kind === "mcp") {
              const file = mcpCandidates(assetOmpDir(kind, msg.scope, msg.cwd))[0];
              if (fs.existsSync(file)) {
                ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content: await readFile(file, "utf8") }));
                break;
              }
              await mkdir(path.dirname(file), { recursive: true });
              const content = `{\n  "mcpServers": {}\n}\n`;
              await writeFile(file, content, "utf8");
              ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
              break;
            }
            const name = String(msg.name ?? "").trim().toLowerCase();
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("名称仅允许小写字母、数字、-、_");
            const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), kind === "agent" ? "agents" : "skills");
            await mkdir(dir, { recursive: true });
            const file = kind === "agent" ? path.join(dir, `${name}.md`) : path.join(dir, name, "SKILL.md");
            if (fs.existsSync(file)) throw new Error(`${kind} 已存在: ${name}`);
            await mkdir(path.dirname(file), { recursive: true });
            const content =
              kind === "agent"
                ? `---\nname: ${name}\ndescription: \ntools: read, grep, glob\n---\n\n`
                : `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n`;
            await writeFile(file, content, "utf8");
            ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_skill_toggle": {
            const name = String(msg.name ?? "").trim();
            const enabled = Boolean(msg.enabled);
            if (!name) throw new Error("缺少技能名称");
            const disabled = new Set<string>(((settings.get("disabledExtensions") ?? []) as string[]));
            const ignored = new Set<string>(((settings.get("skills.ignoredSkills") ?? []) as string[]));
            const skillExtId = `skill:${name}`;
            if (enabled) {
              disabled.delete(skillExtId);
              ignored.delete(name);
            } else {
              disabled.add(skillExtId);
            }
            settings.set("disabledExtensions", Array.from(disabled));
            settings.set("skills.ignoredSkills", Array.from(ignored));
            await settings.flush();
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_skill_delete": {
            const rawPath = String(msg.path ?? "");
            const file = resolveAssetFile("skill", rawPath);
            if (!fs.existsSync(file)) throw new Error(`技能文件不存在: ${file}`);
            const skillDir = path.dirname(file);
            const parentDir = path.dirname(skillDir);
            // 如果是常规的 <skillName>/SKILL.md，安全删除整个技能目录
            if (path.basename(file).toLowerCase() === "skill.md" && parentDir && parentDir !== skillDir) {
              await rm(skillDir, { recursive: true, force: true });
            } else {
              await rm(file, { force: true });
            }
            ws.send(JSON.stringify({ type: "asset_file_deleted", kind: "skill", path: file }));
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "set_mcp_server_enabled": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const enabled = Boolean(msg.enabled);
            const userPath = path.join(agentDir, "mcp.json");
            const projectPath = msg.cwd
              ? (nearestProjectOmpDir(msg.cwd) ? path.join(nearestProjectOmpDir(msg.cwd)!, "mcp.json") : path.join(path.resolve(msg.cwd), ".omp", "mcp.json"))
              : undefined;
            await setMcpServerEnabled({
              userPath,
              projectPath: projectPath ?? userPath,
              sourcePath: msg.sourcePath ? String(msg.sourcePath) : undefined,
              name,
              enabled,
            });
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "test_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            mcpHealthCache.delete(name);
            const probe = await probeMcpServerHealth(msg.server || { name });
            ws.send(JSON.stringify({ type: "mcp_server_tested", name, status: probe.status, error: probe.error }));
            break;
          }
          case "save_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const cfg = msg.config || {};
            const scope = String(msg.scope ?? "profile");
            const targetDir = scope === "global"
              ? path.join(os.homedir(), ".omp", "agent")
              : scope === "profile"
              ? agentDir
              : scope.startsWith("project:")
              ? (nearestProjectOmpDir(scope.slice(8)) ?? path.join(path.resolve(scope.slice(8)), ".omp"))
              : agentDir;
            await mkdir(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, "mcp.json");
            await updateMCPServer(targetPath, name, cfg);
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "delete_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const src = msg.sourcePath ? String(msg.sourcePath) : undefined;
            const userPath = path.join(agentDir, "mcp.json");
            if (src && fs.existsSync(src) && (src.endsWith("mcp.json") || src.endsWith(".mcp.json"))) {
              await removeMCPServer(src, name);
            } else {
              await setMcpServerEnabled({
                userPath,
                projectPath: userPath,
                sourcePath: src,
                name,
                enabled: false,
              });
            }
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "switch_profile": {
            const p = String(msg.profile ?? "").trim();
            if (!p) throw new Error("Profile 名称不能为空");
            await applyProfile(p);
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            await handleListSessions(ws);
            try {
              ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            } catch {}
            ws.send(JSON.stringify({ type: "profile_switched", profile: currentProfile }));
            break;
          }
          default:
            ws.send(JSON.stringify({ type: "error", message: `未知命令: ${msg.type}` }));
        }
      } catch (err) {
        // 单条命令失败不拖垮宿主，错误如实上报前端
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, kind: msg.kind ?? null, message: String(err) }));
        process.stderr.write(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
  },
});

// ---------- 磁盘资产 ----------
// 取消 1s 指纹轮询自动推送:前端设置页(MCP/技能/子智能体)改用手动「刷新」按钮(list_agent_assets)

// 挂起的审批请求：requestId -> resolve（answer 为 undefined 即拒绝语义）
const pendingApprovals = new Map<string, { resolve: (v: string | undefined) => void }>();

function pushContext(ws: any, sessionId: string, entry: PoolEntry) {
  const u = entry.session.getContextUsage();
  if (u) {
    ws.send(
      JSON.stringify({
        type: "context",
        sessionId,
        tokens: u.tokens,
        window: u.contextWindow,
        percent: u.percent,
      }),
    );
  }
}

function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify({ type: "event", sessionId, ...ui }));
    // todo 工具落盘后推送最新任务清单（TodoTracker 在工具结果后更新）
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      ws.send(JSON.stringify({ type: "todos", sessionId, phases: entry.session.getTodoPhases() }));
    }
    // turn 真正结束后推送上下文占用（此时消息已定稿）
    if (ev.type === "agent_end" && ev.isTerminal !== false) {
      pushContext(ws, sessionId, entry);
    }
  });
  // 审批/对话框：非 yolo 模式下审批 gate 通过 ExtensionUIContext.select 挂起等用户选择
  const uiCtx = {
    // ask 等工具的 UI 超时从对话框呈现起算，而不是工具发起时
    timeoutStartsOnPresentation: true,
    select(title: string, options: any[], dialogOptions?: any): Promise<string | undefined> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        // agent 中止/工具取消：AbortSignal 到来即按取消（undefined）结束挂起
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title,
            options: options.map((o) => (typeof o === "string" ? o : o.label)),
          }),
        );
      });
    },
    confirm(title: string, message: string): Promise<boolean> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v === "OK");
        };
        pendingApprovals.set(requestId, { resolve: settle });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title: `${title}\n${message}`,
            options: ["OK", "Cancel"],
          }),
        );
      });
    },
    editor(title: string, prefill?: string, dialogOptions?: any): Promise<string | undefined> {
      // ask 的「Other」自定义输入走这里；缺实现会 undefined is not a function 直接挂工具
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title,
            options: ["提交", "取消"],
            editable: true,
            prefill: prefill ?? "",
          }),
        );
      });
    },
  };
  entry.sessionResult.setToolUIContext(uiCtx, true);
  // 关键一步（ACP 同款，acp-agent.ts:2631）：runner.hasUI() 判的是 initialize 注入的 uiContext，
  // 只调 setToolUIContext 不够——审批 gate 会 fail-closed「no interactive UI」
  entry.session.extensionRunner?.initialize({}, {}, {}, uiCtx, "rpc");
  // 整棵 spawn 树共享根会话的 eventBus（sdk.ts:1341）：子代理 lifecycle/event 帧都在上面
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    ws.send(
      JSON.stringify({
        type: "subagent_lifecycle",
        sessionId,
        subagentId: p.id,
        agent: p.agent,
        description: p.description,
        status: p.status,
      }),
    );
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify({ type: "subagent_event", sessionId, subagentId: id, ...ui }));
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubLifecycle();
    unsubEvents();
  };
  sessions.set(sessionId, entry);
}

async function handleCreateSession(ws: any, cwd?: string, modelStr?: string, thinkingLevel?: string) {
  const workDir = typeof cwd === "string" && cwd ? cwd : defaultCwd;
  const targetModel = modelStr ? scopedModels.find((m) => `${m.provider}/${m.id}` === modelStr) : undefined;
  const { sessionId, entry, eventBus } = await createSessionCore(
    workDir,
    SessionManager.create(workDir),
    [],
    targetModel,
  );
  if (thinkingLevel) {
    try {
      entry.session.setThinkingLevel(thinkingLevel);
    } catch {}
  }
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: workDir,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.thinkingLevel ?? "auto",
      isGit: entry.isGit,
    }),
  );
  process.stderr.write(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir} model=${modelStr ?? "default"} thinking=${thinkingLevel ?? "default"}（活跃 ${sessions.size}）\n`);
}

async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error("缺少 path");
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // 会话原始 cwd：getEntries() 不含 session header，用 peekSessionInit 读
  // （open 内部同源；目录不可达时它返回 null，兜底 HOME）
  const peek = await SessionManager.peekSessionInit(sessionPath);
  const workCwd = peek?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.thinkingLevel ?? "auto",
      isGit: entry.isGit,
    }),
  );
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  // 恢复会话的存量任务清单（TodoTracker 构造时从 transcript 分支同步）
  const restored = entry.session.getTodoPhases();
  if (restored.length > 0) {
    ws.send(JSON.stringify({ type: "todos", sessionId, phases: restored }));
  }
  // 恢复会话的初始上下文占用（system prompt + 历史）
  pushContext(ws, sessionId, entry);
  process.stderr.write(
    `[host] 加载会话 ${sessionId.slice(0, 8)} cwd=${entry.cwd} 历史 ${transcript.length} 条\n`,
  );
}

async function handleListSessions(ws: any) {
  const all = await SessionManager.listAll(); // 全部 project 目录，pinned 优先
  const byProject = new Map<string, any[]>();
  for (const s of all) {
    const list = byProject.get(s.cwd) ?? [];
    list.push(s);
    byProject.set(s.cwd, list);
  }
  // 历史扫描：新出现的 project 并入所有项目列表（启动/UI 重连时都会走到这里）
  if (mergeHistoryProjects([...byProject.keys()])) await saveDesktopProjects();
  const projects = [...byProject.entries()]
    .map(([cwd, list]) => ({
      cwd,
      sessions: list
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          id: s.id,
          path: s.path,
          title: s.title ?? null,
          firstMessage: s.firstMessage.slice(0, 80),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: desktopProjects.allProjects,
      removedProjects: desktopProjects.removedProjects,
      expandedProjects: desktopProjects.expandedProjects,
      pinnedSessions: desktopProjects.pinnedSessions,
    }),
  );
}

// 前端随 prompt 下发的附件：图片为 base64，文本类为文件内容
interface PromptAttachment {
  kind: "image" | "text";
  mime?: string;
  data?: string; // image：base64（无 data: 前缀）
  name?: string; // text：文件名
  text?: string; // text：文件内容
}

async function handlePrompt(
  ws: { send(data: string): unknown },
  sessionId: string,
  text: string,
  files?: PromptAttachment[],
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  // 附件：图片走 SDK ImageContent；文本类文件内容内联进 prompt（与 CLI 粘贴文件一致）
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const f of files ?? []) {
    if (f.kind === "image" && typeof f.data === "string") {
      images.push({ type: "image", data: f.data, mimeType: String(f.mime ?? "image/png") });
    }
  }
  const textBlocks = (files ?? [])
    .filter((f) => f.kind === "text" && typeof f.text === "string")
    .map((f) => {
      const name = String(f.name ?? "file").replace(/"/g, "&quot;");
      return `<attached-file name="${name}">\n${f.text}\n</attached-file>`;
    });
  let finalText = text;
  if (textBlocks.length > 0) {
    finalText = text ? `${textBlocks.join("\n\n")}\n\n${text}` : textBlocks.join("\n\n");
  }
  if (!finalText && images.length === 0) throw new Error("消息为空");
  if (!finalText) finalText = "请查看附件图片。";
  entry.transcript.push({ role: "user", text: finalText });
  // 命令立即返回；turn 产物全部走事件流（omp 的 prompt 在流式中自带 steer/排队语义）
  entry.session
    .prompt(finalText, images.length > 0 ? { images } : undefined)
    .catch((err: unknown) => {
      ws.send(JSON.stringify({ type: "error", sessionId, message: String(err) }));
    });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}

process.on("SIGTERM", async () => {
  // Tauri 壳退出兜底；dispose 触发落盘收尾
  await Promise.allSettled([...sessions.values()].map((e) => e.session.dispose()));
  process.exit(0);
});

// 父进程死亡自监测：tauri dev 杀进程树时壳的 Exit 回调可能来不及 kill，
// 宿主轮询 ppid，父进程消失就自行退出，杜绝孤儿进程
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
}, 2000);

console.log(`READY ws://127.0.0.1:${server.port}`);

// 配额后台刷新:启动时预载所有已配置供应商(模型目录里出现过的 provider),
// 此后每 5 分钟全量重拉;结果写入 limits 60s 缓存,hover 明细卡直接命中。
const LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
function configuredLimitProviders() {
  const seen = new Map<string, string>();
  for (const m of availableModels) {
    if (seen.has(m.provider)) continue;
    let baseUrl = "";
    try {
      baseUrl = modelRegistry.getProviderBaseUrl(m.provider) ?? "";
    } catch {}
    seen.set(m.provider, baseUrl);
  }
  return [...seen].map(([id, baseUrl]) => ({ id, baseUrl }));
}
const runLimitsRefresh = () => {
  const providers = configuredLimitProviders();
  void refreshAllLimits(authStorage, providers).then(() => {
    process.stderr.write(`[host] 配额预载/刷新完成: ${providers.length} 个供应商\n`);
  });
};
runLimitsRefresh();
setInterval(runLimitsRefresh, LIMITS_REFRESH_INTERVAL_MS);
