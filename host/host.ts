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
import { readdir, readFile, writeFile } from "node:fs/promises";

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
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
  await import("@oh-my-pi/pi-coding-agent");
const { Tokenizer } = await import("@oh-my-pi/pi-agent-core");
import { fetchSessionLimits } from "./limits/index.ts";

// MCP 工具 schema token 估算缓存:tools roster 身份不变就不重算
const mcpTokensCache = new WeakMap<object, number>();

const defaultCwd = os.homedir();

// ---------- 会话池类型与实例（前置声明，方便 profile 切换时清理） ----------
type TranscriptItem = {
  role: "user" | "assistant" | "tool" | "thinking";
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
    desktopEnv,
    activeProfile: currentProfile,
    availableProfiles: cachedProfiles,
    profileAgentDir: agentDir,
  };
}

function modelCatalog() {
  const enabled = new Set(enabledDefaults.keys());
  const allEnabled = enabled.size === 0;
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

async function listAgentAssets() {
  const memoriesDir = path.join(agentDir, "memories");
  const skills = [];
  for (const d of await listNamedDirs(path.join(agentDir, "skills"))) {
    skills.push({ name: d.name, path: d.path, description: await firstHeading(path.join(d.path, "SKILL.md")) });
  }
  const commands = await listNamedFiles(path.join(agentDir, "commands"), ".md");
  const agents = [];
  for (const d of [...(await listNamedDirs(path.join(agentDir, "agents"))), ...(await listNamedFiles(path.join(agentDir, "agents"), ".md"))]) {
    const file = d.path.endsWith(".md") ? d.path : path.join(d.path, "AGENT.md");
    agents.push({ name: d.name, path: d.path, description: await firstHeading(file) });
  }
  const hooks: { name: string; path: string; phase: string }[] = [];
  for (const phase of ["pre", "post"]) {
    for (const f of await listNamedFiles(path.join(agentDir, "hooks", phase), ".ts")) hooks.push({ ...f, phase });
    for (const f of await listNamedFiles(path.join(agentDir, "hooks", phase), ".js")) hooks.push({ ...f, phase });
  }
  let mcp: { name: string; command: string }[] = [];
  try {
    const raw = JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"));
    const servers = raw.mcpServers ?? raw.servers ?? {};
    mcp = Object.entries(servers).map(([name, v]: [string, any]) => ({
      name,
      command: [v?.command, ...(v?.args ?? [])].filter(Boolean).join(" ") || v?.url || "",
    }));
  } catch {}
  let memories: { name: string; path: string }[] = [];
  try {
    const entries = await readdir(memoriesDir, { withFileTypes: true });
    memories = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(memoriesDir, e.name) }));
  } catch {}
  return {
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
  | { kind: "tool"; name: string; toolCallId?: string; args?: Record<string, unknown>; files?: string[] }
  | { kind: "tool_update"; name: string; toolCallId?: string; files?: string[]; added?: number; removed?: number; todo?: TranscriptItem["todo"] }
  | { kind: "turn_end" };

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
  push(pathOf(args));
  if (typeof args?.input === "string" && (name === "apply_patch" || name === "edit")) {
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.input))) push(m[1].trim());
  }
  if (Array.isArray(details?.perFileResults)) for (const f of details.perFileResults) push(f?.path);
  if (typeof details?.path === "string") push(details.path);
  if (typeof details?.resolvedPath === "string") push(details.resolvedPath);
  return out;
}

function toolArgsForUi(name: string, args: any): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  if (name === "bash" || name === "shell") return { command: String(args.command ?? "").slice(0, 4000) };
  if (name === "todo") return { op: args.op, task: args.task, i: args.i };
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

function flushAssistantDraft(entry: PoolEntry) {
  if (!entry.assistantDraft) return;
  entry.transcript.push({ role: "assistant", text: entry.assistantDraft });
  entry.assistantDraft = "";
}

function uiToolPayload(item: TranscriptItem): Extract<UiEvent, { kind: "tool" }> {
  return { kind: "tool", name: item.name ?? item.text, toolCallId: item.toolCallId, args: item.args, files: item.files };
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
        return null;
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
      };
    }
    case "agent_end":
      // isTerminal === false 表示 maintenance/异步投递还会续跑，不是真正结束
      if (ev.isTerminal === false) return null;
      flushAssistantDraft(entry);
      return { kind: "turn_end" };
    default:
      return null;
  }
}

// 磁盘历史条目 → 前端 transcript（思考块可展开；工具带路径/命令/行数）
function entriesToTranscript(entries: any[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  for (const e of entries) {
    if (e.type !== "message") continue;
    const msg = e.message ?? {};
    const { role, content } = msg;
    if (role === "toolResult") {
      const item = byId.get(msg.toolCallId);
      if (item) Object.assign(item, summarizeResult(msg.toolName, item.args, msg));
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content === "string") {
      out.push({ role, text: content });
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text") out.push({ role: role === "user" ? "user" : "assistant", text: block.text });
      else if (block.type === "thinking" && block.thinking) {
        out.push({
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
        out.push(item);
      }
    }
  }
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
          case "prompt":
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""));
            break;
          case "get_messages":
            handleGetMessages(ws, msg.sessionId);
            break;
          case "get_file_diff": {
            // 单文件详细 diff：tracked 走 git diff HEAD，untracked 用 --no-index 生成纯新增
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const filePath = String(msg.path ?? "");
            if (!filePath) throw new Error("缺少 path");
            const abs = path.resolve(cwd, filePath);
            if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw new Error(`路径越界: ${filePath}`);
            const tracked = Bun.spawnSync(["git", "-C", cwd, "ls-files", "--error-unmatch", "--", filePath], {
              stdout: "ignore",
              stderr: "ignore",
            });
            const isTracked = tracked.exitCode === 0;
            const args = isTracked
              ? ["diff", "HEAD", "--", filePath]
              : ["diff", "--no-index", "--", "/dev/null", abs];
            const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
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
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const ompProvider = entry.session.model?.provider;
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
            else if (key === "memory.backend") {
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
          case "list_agent_assets":
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
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
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, message: String(err) }));
        process.stderr.write(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
  },
});

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
  ws.send(JSON.stringify({ type: "session_list", projects }));
}

async function handlePrompt(ws: any, sessionId: string, text: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  if (!text) throw new Error("消息为空");
  entry.transcript.push({ role: "user", text });
  // 命令立即返回；turn 产物全部走事件流（omp 的 prompt 在流式中自带 steer/排队语义）
  entry.session.prompt(text).catch((err) => {
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
