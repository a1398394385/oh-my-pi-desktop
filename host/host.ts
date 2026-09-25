// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入（bootstrap.ts + profile.ts）
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话落在独立 profile `omp-desktop` 下（~/.omp/profiles/omp-desktop/agent），
//   与用户 CLI 的 ~/.omp/agent 隔离；profile 沿用旧 RPC 版的认证（agent.db）
// - UI 壳通过 WebSocket 连入：命令（create/load/prompt/list/get_messages/get_limits 等）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
//
// 模块分工：bootstrap.ts（SDK 加载顺序闸门）/ state.ts（共享可变状态 H）/ profile.ts（profile·env·项目清单）/
// models.ts（模型目录与设置快照）/ assets.ts（skills·mcp·agents 磁盘资产）/ stats.ts（使用统计）/
// translate.ts（omp 事件 → 前端窄事件）/ acp-*.ts（ACP 压缩工具面与视图改写）/
// session-context.ts（read_session_context 历史会话检索工具）。本文件只保留 WebSocket 服务与会话生命周期。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm, stat, open } from "node:fs/promises";
import {
  SessionManager,
  createAgentSession,
  AgentRegistry,
  Tokenizer,
  authPolicyFor,
  initialProfile,
  setMcpServerEnabled,
  addMCPServer,
  updateMCPServer,
  removeMCPServer,
  isUserQueuedMessage,
  isHiddenUserCompanion,
  toRestoredQueuedMessage,
  USER_INTERRUPT_LABEL,
  executeAcpBuiltinSlashCommand,
  buildAvailableSlashCommands,
  parseSlashCommand,
  parseSkillInvocation,
  buildSkillPromptMessage,
  SKILL_PROMPT_MESSAGE_TYPE,
  fuzzyFind,
  resolveApprovedPlan,
  autosaveApprovedPlan,
  resolveLocalUrlToPath,
  normalizeLocalScheme,
} from "./bootstrap.ts";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type {
  AvailableCommandsSession,
  InternalAvailableSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { createTerminal, disposeTerminalsOf, terminalFor } from "./pty.ts";
import { GoalController, type GoalSession } from "./goal.ts";
import { createAcpCompressTools } from "./acp-tools.ts";
import { createSessionContextTools } from "./session-context.ts";
import { AcpSessionState, parseAcpContextWindow, type AcpNudgeConfig } from "./acp-state.ts";
import { createAcpContextExtension } from "./acp-context.ts";
import {
  H,
  sessions,
  defaultCwd,
  enabledDefaults,
  loginPendingPrompts,
  type PoolEntry,
  type TranscriptItem,
  type DesktopEnv,
} from "./state.ts";
import {
  applyProfile,
  refreshAvailableProfiles,
  saveDesktopProjects,
  mergeHistoryProjects,
  applySleepPrevention,
  applyDesktopEnv,
} from "./profile.ts";
import { rebuildScopedModels, modelsPayload, settingsSnapshot, modelCatalog, modelRolesPayload, modelsDefaults } from "./models.ts";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings";

// models 帧统一组装：目录 + 新建会话配置默认（defaultModel/defaultThinking），
// 所有发送点共用，避免漏带默认字段
function modelsFrame() {
  return { type: "models", models: modelsPayload(), ...modelsDefaults() };
}
import {
  listAgentAssets,
  probeMcpServerHealth,
  mcpHealthCache,
  nearestProjectOmpDir,
  assetOmpDir,
  mcpCandidates,
  resolveAssetFile,
  type AssetKind,
} from "./assets.ts";
import { collectUsageStats } from "./stats.ts";
import { translateEvent, translateSubagentEvent, entriesToTranscript, treeToDisplay, sumRunDurationMs, PHASE_TEXT } from "./translate.ts";
import { fetchSessionLimits, fetchProviderAccountsLimits, refreshAllLimits, listAllProviders } from "./limits/index.ts";

// ---------- 启动序言：激活持久化 profile，装配进程级底座 ----------
H.currentProfile = initialProfile;
await refreshAvailableProfiles();
await applyProfile(H.currentProfile);

// MCP 工具 schema token 估算缓存:tools roster 身份不变就不重算
const mcpTokensCache = new WeakMap<object, number>();

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

function isGitWorktree(cwd: string): boolean {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

// 池外会话的磁盘解析：扫全部会话文件（与 list_sessions 同源），按底座会话 id 匹配
// 出文件路径。用于对未打开的历史会话做 rename/archive 等操作。
async function sessionPathFromDisk(sessionId: string): Promise<string> {
  const hit = (await SessionManager.listAll()).find((s: any) => s.id === sessionId);
  if (!hit) throw new Error(`会话不存在: ${sessionId}`);
  return hit.path;
}

// 复制会话工件目录（如生成的代码片段、图表等）：会话文件同名的无后缀目录
async function copySessionArtifactsIfAny(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
  if (!sourceSessionFile.endsWith(".jsonl") || !destinationSessionFile.endsWith(".jsonl")) return;
  const srcDir = sourceSessionFile.slice(0, -6);
  const dstDir = destinationSessionFile.slice(0, -6);
  if (path.resolve(srcDir) === path.resolve(dstDir)) return;
  try {
    const st = await fs.promises.stat(srcDir);
    if (st.isDirectory()) {
      await fs.promises.cp(srcDir, dstDir, { recursive: true });
    }
  } catch {}
}

// git 写操作共用：参数数组直传子进程（无 shell 拼接，天然防注入），失败时把 stderr
// 汇总成 error 字段交调用方回包（不抛异常炸连接），成功返回 stdout/stderr
function runGitChecked(cwd: string, args: string[]): { ok: true; stdout: string; stderr: string } | { ok: false; error: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    return { ok: false, error: p.stderr.toString().trim().slice(0, 500) || `git ${args[0]} 失败（exit ${p.exitCode}）` };
  }
  return { ok: true, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

// git 写操作 RPC 的 paths 参数：字符串数组、去空
function stringPaths(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter((x) => x.trim()) : [];
}

/** 读 omp-desktop.json 原始对象（读失败返回空对象）。 */
function readAcpRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readAcpNudgeConfig(): AcpNudgeConfig {
  const fallback: AcpNudgeConfig = { maxContextLimit: 0.55, minContextLimit: 0.45 };
  const acp = readAcpRaw().acp as Record<string, unknown> | undefined;
  if (!acp || typeof acp !== "object") return fallback;
  const parse = (v: unknown, dflt: number): number => {
    if (typeof v === "number" && v > 0 && v <= 1) return v;
    if (typeof v === "string") {
      const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(v);
      if (m) return Number(m[1]) / 100;
    }
    return dflt;
  };
  return {
    maxContextLimit: parse(acp.maxContextLimit, 0.55),
    minContextLimit: parse(acp.minContextLimit, 0.45),
  };
}

/** ACP 总开关（omp-desktop.json 的 acp.enabled）。缺省/非法值按开启处理，
 *  保持引入开关之前的行为——只有显式写 false 才关闭。 */
function readAcpEnabled(): boolean {
  const acp = readAcpRaw().acp as Record<string, unknown> | undefined;
  if (!acp || typeof acp !== "object") return true;
  return acp.enabled !== false;
}

/** 写回 acp.enabled：先读盘再覆盖，保留 omp-desktop.json 的其他键与 acp 段内其他字段。 */
async function writeAcpEnabled(enabled: boolean): Promise<void> {
  const raw = readAcpRaw();
  const acp = raw.acp && typeof raw.acp === "object" ? (raw.acp as Record<string, unknown>) : {};
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, acp: { ...acp, enabled } }, null, 2));
}

/** 历史会话检索（read_session_context）总开关（omp-desktop.json 的 sessionContext.enabled）。
 *  与 readAcpEnabled 同语义：缺省/非法值按开启处理，只有显式写 false 才关闭。 */
function readSessionContextEnabled(): boolean {
  const section = readAcpRaw().sessionContext as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object") return true;
  return section.enabled !== false;
}

/** 写回 sessionContext.enabled：先读盘再覆盖，保留 omp-desktop.json 的其他键与段内其他字段。 */
async function writeSessionContextEnabled(enabled: boolean): Promise<void> {
  const raw = readAcpRaw();
  const section =
    raw.sessionContext && typeof raw.sessionContext === "object" ? (raw.sessionContext as Record<string, unknown>) : {};
  await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, sessionContext: { ...section, enabled } }, null, 2));
}

/** 设置帧 = 底座设置快照 + host 侧实验开关（不下沉 models.ts，避免模块环）。 */
function settingsFrame() {
  return { ...settingsSnapshot(), acpEnabled: readAcpEnabled(), sessionContextEnabled: readSessionContextEnabled() };
}

// ---------- 输入框 sigil：命令清单与 @ 文件候选 ----------

// 桌面端不通过 sigil 提供的斜杠命令：模型/思考级别/会话开关这几类，能力分别由输入框胶囊
// （模型/思考/ModeMenu）与设置页承担，清单过滤与执行拦截共用本表（值为命中提示）。
// key 含别名（/models 是 /model 的别名；/force:xxx 经 parseSlashCommand 归到 force）。
const REMOVED_SLASH_COMMANDS: Record<string, string> = {
  model: "模型切换请用输入框的模型胶囊",
  models: "模型切换请用输入框的模型胶囊",
  switch: "模型切换请用输入框的模型胶囊",
  prewalk: "模型交接已移除",
  fast: "服务档（fast）切换已移除",
  skillful: "技能清单开关请到设置页操作",
  "extended-context": "扩展上下文开关请到设置页操作",
  computer: "电脑控制开关请到设置页操作",
  force: "强制工具选择已移除",
  fork: "会话分叉请点击回复下方的分叉按钮",
};

/** 已移除命令的提示文案；非已移除命令返回 null */
function removedSlashHint(text: string): string | null {
  const parsed = parseSlashCommand(text.trim());
  if (!parsed) return null;
  const hint = REMOVED_SLASH_COMMANDS[parsed.name];
  return hint ? `/${parsed.name} 已移除：${hint}` : null;
}

// 新建会话页隐藏的会话级命令：操作/统计「已存在的会话」，首条消息发出前无意义
// （压缩/交接/重试/会话管理/导出/统计等）。goal、memory、工具与插件管理、skill:* 等保留。
const NEW_SESSION_HIDDEN_SLASH_COMMANDS: Record<string, true> = {
  compact: true,
  handoff: true,
  shake: true,
  retry: true,
  fresh: true,
  rename: true,
  move: true,
  wt: true,
  "add-dir": true,
  "remove-dir": true,
  dirs: true,
  session: true,
  pin: true,
  jobs: true,
  usage: true,
  stats: true,
  context: true,
  trace: true,
  dump: true,
  share: true,
  export: true,
  todo: true,
};

// /goal：底座条目是 TUI-only（无 handle 不进清单），注入桌面实现的同名条目（执行走 dispatchSlashInput）
const GOAL_SLASH_COMMAND = {
  name: "goal",
  description: "Toggle goal mode (persistent autonomous objective for this session)",
  input: { hint: "[objective]" },
  source: "builtin" as const,
  subcommands: [
    { name: "set", description: "Set or replace the goal" },
    { name: "pause", description: "Pause the current goal" },
    { name: "resume", description: "Resume a paused goal" },
    { name: "drop", description: "Drop the current goal" },
    { name: "budget", description: "Adjust the token budget" },
  ],
};

// /plan：底座同样只有 handleTui（buildAvailableSlashCommands 的 `if (!command.handle) continue`
// 把它挡在清单外，手输还会被当普通 prompt 发给模型），注入桌面实现的同名条目。
const PLAN_SLASH_COMMAND = {
  name: "plan",
  description: "Toggle plan mode (agent plans before executing)",
  input: { hint: "[prompt]" },
  source: "builtin" as const,
};

// 命令清单帧：内置 + skill + 扩展 + 自定义 + 文件命令，可无 TUI 执行的那批
// （executeAcpBuiltinSlashCommand 的姊妹面）。映射成前端 PaletteMenu 直接消费的形状。
function sendCommandsFrame(
  ws: { send(data: string): unknown },
  sessionId: string | null,
  list: InternalAvailableSlashCommand[],
  hideSessionCommands: boolean,
) {
  const commands = list
    .filter((c) => !REMOVED_SLASH_COMMANDS[c.name] && (!hideSessionCommands || !NEW_SESSION_HIDDEN_SLASH_COMMANDS[c.name]))
    .concat(GOAL_SLASH_COMMAND, PLAN_SLASH_COMMAND);
  ws.send(
    JSON.stringify({
      type: "commands",
      sessionId,
      commands: commands.map((c) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        description: c.description ?? "",
        hint: c.input?.hint ?? null,
        source: c.source,
        subcommands: (c.subcommands ?? []).map((s) => ({ name: s.name, description: s.description ?? "" })),
      })),
    }),
  );
}

async function pushCommands(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  sendCommandsFrame(ws, sessionId, await buildAvailableSlashCommands(entry.session), false);
}

// 新建会话页的命令清单（无会话条目）：skills/自定义命令借用池内任一会话（同一套配置加载，
// 各会话一致）；文件命令按新建项目 cwd 扫描；隐藏会话级命令。池内无会话时 skills 回退空。
async function pushNewSessionCommands(ws: { send(data: string): unknown }, cwd: string) {
  const any = sessions.values().next().value as PoolEntry | undefined;
  const stub = {
    customCommands: any?.session.customCommands ?? [],
    skills: any?.session.skills ?? [],
    skillsSettings: any?.session.skillsSettings ?? { enableSkillCommands: true },
    setSlashCommands: () => {},
    sessionManager: { getCwd: () => cwd },
  } as unknown as AvailableCommandsSession;
  sendCommandsFrame(ws, null, await buildAvailableSlashCommands(stub), true);
}

// @ 候选：绝对路径/家目录前缀走 readdir 前缀列举（对齐 TUI autocomplete 的目录补全），
// 其余走 fuzzyFind 全仓模糊搜索；任何错误静默返回空（弹层显示无匹配）
async function listFileMatches(root: string, query: string): Promise<Array<{ path: string; dir: boolean }>> {
  if (query.startsWith("/") || query.startsWith("~")) {
    try {
      const expanded = query.startsWith("~") ? os.homedir() + query.slice(1) : query;
      const searchDir = query.endsWith("/") ? expanded : path.dirname(expanded);
      const base = query.endsWith("/") ? "" : path.basename(expanded);
      const dirents = await readdir(searchDir, { withFileTypes: true });
      const prefix = base.toLowerCase();
      const dirPart = query.endsWith("/") ? query : query.slice(0, query.length - path.basename(query).length);
      return dirents
        .filter((d) => d.name !== ".git" && d.name.toLowerCase().startsWith(prefix))
        .map((d) => ({ path: dirPart + d.name, dir: d.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path))
        .slice(0, 100);
    } catch {
      return [];
    }
  }
  try {
    const r = await fuzzyFind({ query, path: root, maxResults: 100, hidden: true, gitignore: true, cache: true });
    return r.matches.map((m) => ({ path: m.path, dir: m.isDirectory }));
  } catch {
    return [];
  }
}

// ---------- 计划模式（plan）----------
// 会话语义全在底座：模式状态 + 每轮自动注入的计划上下文 + plan-mode-guard 写保护。
// 宿主只做三件事：切状态、落 mode_change 持久化、把 agent 的 xd://propose 提案接到审批卡。
// 参考实现：modes/acp/acp-agent.ts 的 #applyModeChange / #handleAcpPlanProposal（无 TUI 版）。

const PLAN_MODE_NAME = "plan";
const PLAN_FILE_URL = "local://PLAN.md"; // 与 ACP 默认计划文件同址
const PLAN_APPROVE = "批准并执行";
const PLAN_REFINE = "继续修改";

/** command_output 帧：按 sessionId 找当前挂载连接推送（goal 控制器等跨连接输出用）。 */
function pushCommandOutput(sessionId: string, text: string) {
  const w = sessions.get(sessionId)?.attachedWs as { send(data: string): unknown } | null;
  if (w) w.send(JSON.stringify({ type: "command_output", sessionId, text }));
}

/** goal 状态帧：会话状态卡顶部目标区展示（无 goal 推 null，前端连分隔线一起隐藏）。 */
function pushGoal(sessionId: string) {
  const entry = sessions.get(sessionId);
  const w = entry?.attachedWs as { send(data: string): unknown } | null;
  if (!entry || !w) return;
  const state = entry.session.getGoalModeState();
  w.send(
    JSON.stringify({
      type: "goal",
      sessionId,
      goal: state?.goal
        ? {
            objective: state.goal.objective,
            status: state.goal.status,
            enabled: state.enabled === true,
            tokenBudget: state.goal.tokenBudget ?? null,
            tokensUsed: state.goal.tokensUsed,
            timeUsedSeconds: state.goal.timeUsedSeconds,
            costUsed: entry.goal.costUsed,
          }
        : null,
    }),
  );
}

/** 待办清单帧：冷加载/池内复用均推（TodoTracker 构造时已从 transcript 分支同步）。
    前端 session_created 重建对象后靠它回填历史存量；空清单不推（无卡）。 */
function pushTodos(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const phases = entry.session.getTodoPhases();
  if (phases.length > 0) {
    ws.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases })));
  }
}

/** 计划模式状态帧：UI 据此显示/隐藏权限胶囊右侧的「计划」退出按钮。 */
function pushPlanMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const state = entry.session.getPlanModeState();
  ws.send(
    JSON.stringify({
      type: "plan_mode",
      sessionId,
      enabled: state?.enabled === true,
      planFilePath: state?.planFilePath ?? null,
    }),
  );
}

/** local:// 计划文件的磁盘路径（对齐 ACP 的 #resolveAcpPlanFilePath） */
function planFilePathOnDisk(entry: PoolEntry, url: string): string {
  const normalized = url.startsWith("local:") ? normalizeLocalScheme(url) : url;
  return resolveLocalUrlToPath(normalized, {
    getArtifactsDir: () => entry.session.sessionManager.getArtifactsDir(),
    getSessionId: () => entry.session.sessionManager.getSessionId(),
  });
}

/** 读计划文件内容；不存在返回 null（resolveApprovedPlan 据此走兜底） */
async function readPlanContent(entry: PoolEntry, url: string): Promise<string | null> {
  try {
    return await Bun.file(planFilePathOnDisk(entry, url)).text();
  } catch {
    return null;
  }
}

/** 会话本地根下的计划文件（最新优先）：agent 丢了 extra.title 时 resolveApprovedPlan 的兜底 */
async function listPlanFilesOf(entry: PoolEntry): Promise<string[]> {
  try {
    const dir = planFilePathOnDisk(entry, "local://");
    const files = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && /plan\.md$/i.test(d.name));
    const stamped = await Promise.all(
      files.map(async (d) => ({ name: d.name, mtime: (await stat(path.join(dir, d.name))).mtimeMs })),
    );
    return stamped.sort((a, b) => b.mtime - a.mtime).map((f) => `local://${f.name}`);
  } catch {
    return [];
  }
}

// 提案处理器：agent 写 xd://propose 后由底座调用（返回的 tool result 回到模型侧）。
// 批准 → 记计划引用 + 自动保存计划 + 退出计划模式；驳回 → 保持计划模式继续打磨。
async function handlePlanProposal(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  title: string,
) {
  const state = entry.session.getPlanModeState();
  if (!state?.enabled) throw new Error("计划模式未激活");
  const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
    suppliedTitle: title,
    statePlanFilePath: state.planFilePath,
    readPlan: (url: string) => readPlanContent(entry, url),
    listPlanFiles: () => listPlanFilesOf(entry),
  });
  const details = { planFilePath, title: resolvedTitle, planExists: true };
  const answer = await requestApproval(ws, sessionId, `计划待审批：${resolvedTitle}\n${planFilePath}`, [
    PLAN_APPROVE,
    PLAN_REFINE,
  ]);
  if (answer !== PLAN_APPROVE) {
    // 驳回：把刚评审的路径提为状态路径，下一轮提案针对这份计划继续改
    if (state.planFilePath !== planFilePath) entry.session.setPlanModeState({ ...state, planFilePath });
    return {
      content: [{ type: "text" as const, text: `计划需要修改：更新 ${planFilePath} 后再次写入 xd://propose。` }],
      details,
    };
  }
  entry.session.setPlanReferencePath(planFilePath); // 下一轮把计划正文作为上下文注入
  const planContent = (await readPlanContent(entry, planFilePath)) ?? "";
  try {
    await autosaveApprovedPlan({
      settings: entry.session.settings,
      cwd: entry.session.sessionManager.getCwd(),
      title: resolvedTitle,
      planContent,
    });
  } catch (err) {
    process.stderr.write(`[host] 计划自动保存失败: ${String(err)}\n`);
  }
  setPlanMode(ws, sessionId, entry, false);
  return {
    content: [{ type: "text" as const, text: `计划已批准（${planFilePath}）。计划模式已退出，按计划开始实施。` }],
    details,
  };
}

/**
 * 进出计划模式。persist=false 用于从落盘 mode_change 恢复（不重复记账）。
 * 进模式后提案处理器负责 xd://propose 的审批闭环——不装它，agent 的提案无人接收。
 */
function setPlanMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  enabled: boolean,
  options?: { planFilePath?: string; persist?: boolean },
) {
  const persist = options?.persist !== false;
  if (enabled) {
    const previous = entry.session.getPlanModeState();
    const planFilePath = options?.planFilePath ?? previous?.planFilePath ?? PLAN_FILE_URL;
    entry.session.setPlanModeState({
      enabled: true,
      planFilePath,
      workflow: previous?.workflow ?? "parallel",
      reentry: previous !== undefined,
    });
    entry.session.setPlanProposalHandler?.((title: string) => handlePlanProposal(ws, sessionId, entry, title));
    if (persist) entry.manager.appendModeChange?.(PLAN_MODE_NAME, { planFilePath });
  } else {
    entry.session.setPlanProposalHandler?.(null);
    entry.session.setPlanModeState(undefined);
    if (persist) entry.manager.appendModeChange?.("none");
  }
  pushPlanMode(ws, sessionId, entry);
}

/**
 * /plan 的 args 分发（底座 TUI handlePlanModeCommand 的裁剪版：桌面无 paused 中间态，
 * 退出即清状态）。无参 = 反转当前状态；带 prompt = 开启后把 prompt 当首个计划轮次。
 * 返回 prompt（调用方转正常 prompt 链路）或 null（已消费）。
 */
function handlePlanCommand(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  args: string,
): string | null {
  if (entry.session.getGoalModeState()) {
    pushCommandOutput(sessionId, "目标模式下无法使用计划模式，先 /goal drop 退出目标模式。");
    return null;
  }
  if (!entry.session.settings.get("plan.enabled")) {
    pushCommandOutput(sessionId, "计划模式未启用：在设置中打开 plan.enabled 后再试。");
    return null;
  }
  if (entry.session.getPlanModeState()?.enabled) {
    setPlanMode(ws, sessionId, entry, false);
    pushCommandOutput(sessionId, "计划模式已退出。");
    return null;
  }
  setPlanMode(ws, sessionId, entry, true);
  const prompt = args.trim();
  if (prompt) return prompt;
  pushCommandOutput(
    sessionId,
    `计划模式已开启：只读探索后把计划写入 ${PLAN_FILE_URL} 并提案审批。退出：/plan（或权限胶囊右侧「计划」按钮）。`,
  );
  return null;
}

/** 会话重开时按最后一条 mode_change 恢复计划模式（TUI #reconcileModeFromSession 的桌面版） */
function reconcilePlanMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry, entries: any[]) {
  const last = [...entries].reverse().find((e) => e?.type === "mode_change");
  if (last?.mode !== PLAN_MODE_NAME) {
    pushPlanMode(ws, sessionId, entry); // 非计划模式也要推帧：UI 需要明确置 false
    return;
  }
  const planFilePath = typeof last.data?.planFilePath === "string" ? last.data.planFilePath : PLAN_FILE_URL;
  setPlanMode(ws, sessionId, entry, true, { planFilePath, persist: false });
}

async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[], initialModel?: any) {
  const acpState = new AcpSessionState();
  // 实验性功能页的总开关（omp-desktop.json 的 acp.enabled，默认开启）：只决定本会话
  // 是否注入 ACP 工具面与 context 视图改写；会话创建后无法热切换，故开关变更对新会话生效
  const acpEnabled = readAcpEnabled();
  // 历史会话检索开关（omp-desktop.json 的 sessionContext.enabled，实验性功能页可关）
  const sessionContextEnabled = readSessionContextEnabled();
  // nudge 分母：omp-desktop.json 的 acp.contextWindow（固定值，如 2000000 / "1M"）
  // 优先于模型注册表窗口；两者皆未知则 nudge 整体禁用
  const sessionModel = (initialModel ?? H.modelOverride) as { contextWindow?: number; contextLength?: number } | undefined;
  acpState.modelContextWindow =
    parseAcpContextWindow((readAcpRaw()?.acp as Record<string, unknown> | undefined)?.contextWindow) ||
    Number(sessionModel?.contextWindow ?? sessionModel?.contextLength ?? 0) ||
    0;
  acpState.nudge = readAcpNudgeConfig();
  const result = await createAgentSession({
    cwd,
    authStorage: H.authStorage,
    modelRegistry: H.modelRegistry,
    settings: H.settings,
    model: initialModel ?? H.modelOverride,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager, // host 侧 manager 必须注入 SDK：否则 rename/compact/branch 走 entry.manager（孤儿实例）操作到另一个会话文件
    // read_session_context（历史会话检索）：只读自身 profile 的会话，见 host/session-context.ts
    customTools: [
      ...(acpEnabled ? createAcpCompressTools(acpState) : []),
      ...(sessionContextEnabled ? createSessionContextTools() : []),
    ] as never, // ACP 压缩工具（compress/decompress/search_context/acp_status/acp_context_recap），见 host/acp-tools.ts；omptype/ArkType schema 与包类型 TSchema 品牌不兼容，运行时一致
    extensions: acpEnabled ? [createAcpContextExtension(acpState)] : [], // context 事件视图变换：ref 注入 + 压缩块替换，见 host/acp-context.ts
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
    attachedWs: null,
    providerSessionId: sessionManager.getSessionId?.() ?? sessionId, // 请求侧 getApiKey 的粘性键
    transcript,
    assistantDraft: "", // 当前 turn 的流式文本累积，turn_end 时定稿
    thinkingDraft: "",
    thinkingStartedAt: null,
    activeMs: 0,
    activeStartedAt: null,
    path: session.sessionFile,
    pollKnownSize: 0, // 外部写入检测：0 = 未首扫
    externalWrite: false,
    cwd,
    isGit: isGitWorktree(cwd),
    queuedTexts: [], // 排队消息文本快照（turn_end 竞态兜底）
    consumedTexts: [],
    parkedFollowUp: [], // followUp 暂存区（见 state.ts 类型注释）
    manager: sessionManager, // rename/compact 等需要直接操作 SessionManager 的 RPC 用
    title: null,
    mentionScanIndex: 0,
    goal: new GoalController({
      // SDK 具体会话类型与窄接口的泛型签名不完全结构兼容，边界处收敛为具名窄接口
      session: session as unknown as GoalSession,
      output: (text) => pushCommandOutput(sessionId, text),
      onChange: () => pushGoal(sessionId),
    }),
  };
  return { sessionId, entry, eventBus: result.eventBus };
}

// ---------- 事件流位置标识（借鉴 OBF 会话投影契约的最小落地） ----------
// hi = host 进程实例 ID：进程重启即更换，UI 据此整体重置视图状态而非错位拼接；
// seq = 全局单调递增事件序号：同 hi 内位置落后的帧（seq ≤ 已见）直接丢弃，
// 不做合并；跳号仅告警（观测期，重连补洞未实现）。RPC 请求-响应不盖戳。
const HOST_INSTANCE_ID = crypto.randomUUID();
let eventSeq = 0;
function stampEvent<T extends object>(payload: T): T & { hi: string; seq: number } {
  return { ...payload, hi: HOST_INSTANCE_ID, seq: ++eventSeq };
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
      process.stderr.write(`[host] WS 客户端接入（前端加载与连接全链路 OK）\n`);
      ws.send(
        JSON.stringify({
          type: "ready",
          hi: HOST_INSTANCE_ID, // 握手不占事件序号，但携带实例身份供 UI 立即比对
          approvalMode: H.settings.get("tools.approvalMode"),
          models: modelsPayload(),
          ...modelsDefaults(),
          settings: settingsFrame(),
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
          case "reload_session": {
            // 强制从磁盘重建（外部写入提示条的「重新加载」）：池复用分支只推内存快照，
            // 拿不到外部进程写入的内容；释放模式对齐 delete_session（unsubscribe + 出池）
            const p = String(msg.path ?? "").trim();
            if (!p) throw new Error("缺少 path");
            for (const [key, e] of sessions.entries()) {
              if (e.path !== p) continue;
              e.unsubscribe();
              sessions.delete(key);
            }
            await handleLoadSession(ws, p);
            break;
          }
          case "list_sessions":
            await handleListSessions(ws);
            break;
          case "remove_project": {
            // 移出项目列表（会话仍保留在历史中，「最近」视图照常见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            if (!H.desktopProjects.removedProjects.includes(cwd)) H.desktopProjects.removedProjects.push(cwd);
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
            const pi = H.desktopProjects.pinnedSessions.indexOf(p);
            if (pi >= 0) {
              H.desktopProjects.pinnedSessions.splice(pi, 1);
              await saveDesktopProjects();
            }
            // 归档记录随会话一并清理
            const ai = H.desktopProjects.archivedSessions.indexOf(p);
            if (ai >= 0) {
              H.desktopProjects.archivedSessions.splice(ai, 1);
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
            const i = H.desktopProjects.expandedProjects.indexOf(cwd);
            if (on && i < 0) H.desktopProjects.expandedProjects.push(cwd);
            if (!on && i >= 0) H.desktopProjects.expandedProjects.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "set_session_pinned": {
            // 置顶会话持久化：记录在 omp-desktop.json pinnedSessions，重启保持
            const p = String(msg.path ?? "").trim();
            const on = !!msg.pinned;
            if (!p) throw new Error("缺少 path");
            const i = H.desktopProjects.pinnedSessions.indexOf(p);
            if (on && i < 0) H.desktopProjects.pinnedSessions.push(p);
            if (!on && i >= 0) H.desktopProjects.pinnedSessions.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "archive_session": {
            // 归档持久化：按会话文件路径记入 omp-desktop.json archivedSessions（与
            // pinnedSessions 同键，delete_session 同步清理）；归档同时取消置顶。
            // 未打开的历史会话（不在内存池）扫磁盘按底座会话 id 解析路径，同样可归档。
            const on = !!msg.archived;
            const entry = sessions.get(msg.sessionId);
            const p = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
            const ai = H.desktopProjects.archivedSessions.indexOf(p);
            if (on && ai < 0) H.desktopProjects.archivedSessions.push(p);
            if (!on && ai >= 0) H.desktopProjects.archivedSessions.splice(ai, 1);
            if (on) {
              const pi = H.desktopProjects.pinnedSessions.indexOf(p);
              if (pi >= 0) H.desktopProjects.pinnedSessions.splice(pi, 1);
            }
            await saveDesktopProjects();
            ws.send(JSON.stringify({ type: "session_archived", sessionId: msg.sessionId, ok: true, archived: on }));
            break;
          }
          case "add_project": {
            // 手动添加：命中已移除列表则移回所有项目列表，否则作为新项目并入（置顶，立即可见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            const ri = H.desktopProjects.removedProjects.indexOf(cwd);
            if (ri >= 0) H.desktopProjects.removedProjects.splice(ri, 1);
            if (!H.desktopProjects.allProjects.includes(cwd)) H.desktopProjects.allProjects.unshift(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "reorder_projects": {
            // 拖拽排序：以 UI 传来的完整顺序为准；未涵盖的既有项（并发变更兜底）保持原序追加尾部
            const order = Array.isArray(msg.order) ? msg.order.filter((x: unknown) => typeof x === "string") : [];
            if (order.length === 0) throw new Error("缺少 order");
            const set = new Set(order);
            const rest = H.desktopProjects.allProjects.filter((c) => !set.has(c));
            H.desktopProjects.allProjects = [...order, ...rest];
            await saveDesktopProjects();
            break;
          }
          case "abort_session": {
            // 流式中断当前生成：reason 用 USER_INTERRUPT_LABEL，transcript 能把该轮
            // assistant 消息标记为用户主动中断；空闲会话 abort 同样安全（底座 waitForIdle 立即返回）。
            // 中断后底座自然走到 agent_end/turn 事件，无需额外收尾。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
            ws.send(JSON.stringify({ type: "session_aborted", sessionId: msg.sessionId, ok: true }));
            break;
          }
          case "rename_session": {
            // 会话重命名：走底座 SessionManager.setSessionName(source:"user") 落盘
            // （title slot + history.db 标题索引），CLI 等其他入口读到同一标题。
            // 打开中的会话用池内 manager；未打开的历史会话 open 磁盘文件后同样
            // 落盘（title slot 插入/原位更新均由底座处理）。
            // 懒建未落盘的会话仅内存生效，list_sessions 兜底条目经 entry.title 呈现。
            const title = String(msg.title ?? "").trim();
            if (!title) throw new Error("缺少 title");
            const entry = sessions.get(msg.sessionId);
            if (entry) {
              if (!(await entry.manager.setSessionName(title, "user"))) {
                throw new Error("标题无效（清洗后为空或会话已释放）");
              }
              entry.title = title;
            } else {
              const manager = await SessionManager.open(await sessionPathFromDisk(msg.sessionId));
              if (!(await manager.setSessionName(title, "user"))) {
                throw new Error("标题无效（清洗后为空或会话已释放）");
              }
            }
            ws.send(JSON.stringify({ type: "session_renamed", sessionId: msg.sessionId, ok: true, title }));
            break;
          }
          case "compact_session": {
            // 手动压缩：底座 compact 重写会话历史（LLM 摘要）。空会话前置快速失败
            // （没有可压缩的历史，避免无谓的模型调用）；不可压缩/压缩失败时底座抛错，
            // 以 error 字段回包提示前端；成功则从磁盘 entries 重建 transcript 并推送，
            // 前端立即换压缩后视图。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            if (entry.transcript.length === 0) {
              ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: "会话为空，没有可压缩的历史" }));
              break;
            }
            try {
              await entry.session.compact();
              entry.transcript = entriesToTranscript(entry.manager.getEntries());
              // 重建后的历史已含 mention 行：游标对齐，避免后续回读重发
              entry.mentionScanIndex = entry.manager.getEntries().length;
              ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
              ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, ok: true }));
            } catch (err) {
              ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: String(err) }));
            }
            break;
          }
          case "branch_session": {
            // 复制式会话分叉：以指定条目为锚点截取历史链路，生成独立新会话文件
            // （header.parentSession 指回源文件）。源会话在宿主池中保持不变，新会话加入池并通知前端切换。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const entryId = String(msg.entryId ?? "");
            if (!entryId) throw new Error("缺少 entryId");
            try {
              // 确保当前会话的最新数据已落盘
              await entry.manager.flush();
              const parentPath = entry.path ?? (await sessionPathFromDisk(msg.sessionId));
              if (!parentPath) throw new Error("无法定位源会话文件");

              // 用独立的 SessionManager 打开父会话文件进行分支切片，避免污染当前活跃的 entry.manager / entry.session
              const tempManager = await SessionManager.open(parentPath);
              const targetEntry = tempManager.getEntry(entryId);
              if (!targetEntry) throw new Error(`未找到条目: ${entryId}`);

              const isUser = targetEntry.type === "message" && targetEntry.message.role === "user";
              // 若是 user 消息分叉（兼容），分支点取其父节点并将该文本回填；若是 assistant 消息分叉，完整保留该轮回复
              const branchLeafId = isUser && targetEntry.parentId ? targetEntry.parentId : entryId;
              const newSessionFile = tempManager.createBranchedSession(branchLeafId);
              if (!newSessionFile) throw new Error("分叉创建新会话文件失败");

              // 复制工件目录（如存在）
              await copySessionArtifactsIfAny(parentPath, newSessionFile);

              // 为新会话建立独立的 AgentSession 实例并加入 sessions 池
              const newManager = await SessionManager.open(newSessionFile);
              const newEntries = newManager.getEntries();
              const newTranscript = entriesToTranscript(newEntries);
              const peek = await SessionManager.peekSessionInit(newSessionFile);
              const workCwd = peek?.cwd ?? entry.cwd;
              const { sessionId: newSessionId, entry: newEntry, eventBus: newBus } = await createSessionCore(
                workCwd,
                newManager,
                newTranscript,
                entry.session.model,
              );
              newEntry.mentionScanIndex = newEntries.length;
              newEntry.activeMs = sumRunDurationMs(newEntries);
              attachEntry(ws, newSessionId, newEntry, newBus);
              sessions.set(newSessionId, newEntry);

              // 提取选中文本（仅 user 消息需要回填输入框，assistant 回复分叉后输入框保持空白待提问）
              const selectedText = isUser
                ? (typeof targetEntry.message.content === "string"
                    ? targetEntry.message.content
                    : (targetEntry.message.content ?? [])
                        .filter((b: any) => b?.type === "text")
                        .map((b: any) => b.text)
                        .join("\n"))
                : null;

              // 推送新会话的 messages 快照和 session_branched 回执
              ws.send(JSON.stringify({ type: "messages", sessionId: newSessionId, messages: newTranscript }));
              ws.send(
                JSON.stringify({
                  type: "session_branched",
                  sessionId: msg.sessionId,
                  ok: true,
                  newSessionId,
                  newPath: newSessionFile,
                  selectedText,
                }),
              );
              await handleListSessions(ws); // 列表刷新信号：session_list 帧通知左栏项目树更新
            } catch (err) {
              ws.send(JSON.stringify({ type: "session_branched", sessionId: msg.sessionId, ok: false, error: String(err) }));
            }
            break;
          }
          case "get_session_tree": {
            // 跨文件分支家族：listAll 扫盘，按 header.parentSession（父文件路径）连图。
            // 从当前会话文件出发向上追根，再自根向下收集全部子孙；title 走 listAll 的
            // 底座解析（与 list_sessions 同源）。找不到会话（未落盘且不在池）回 error 字段。
            const entry = sessions.get(msg.sessionId);
            const curPath = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
            const all = await SessionManager.listAll();
            const byPath = new Map<string, any>(all.map((s: any) => [s.path, s]));
            const cur = byPath.get(curPath);
            if (!cur) {
              ws.send(JSON.stringify({ type: "session_tree", sessionId: msg.sessionId, ok: false, error: `会话文件不在磁盘上: ${curPath}` }));
              break;
            }
            // 向上追根（seenUp 防脏数据成环）
            let root = cur;
            const seenUp = new Set<string>([curPath]);
            while (root.parentSessionPath && byPath.has(root.parentSessionPath) && !seenUp.has(root.parentSessionPath)) {
              root = byPath.get(root.parentSessionPath);
              seenUp.add(root.path);
            }
            // 自根 BFS 收集家族（同层按修改时间升序，根在前）
            const family: any[] = [];
            const visited = new Set<string>([root.path]);
            const queue = [root];
            while (queue.length > 0) {
              const node = queue.shift()!;
              family.push(node);
              const children = all
                .filter((s: any) => s.parentSessionPath === node.path && !visited.has(s.path))
                .sort((a, b) => a.modified.getTime() - b.modified.getTime());
              for (const c of children) {
                visited.add(c.path);
                queue.push(c);
              }
            }
            ws.send(
              JSON.stringify({
                type: "session_tree",
                sessionId: msg.sessionId,
                ok: true,
                branches: family.map((s) => ({
                  sessionId: s.id,
                  path: s.path,
                  title: s.title ?? null,
                  modified: s.modified.toISOString(),
                  parentSession: s.parentSessionPath ?? null,
                  isCurrent: s.path === curPath,
                  messageCount: s.messageCount,
                })),
              }),
            );
            break;
          }
          case "get_entry_tree": {
            // 会话内条目树（TUI /tree 同款数据源）：manager.getTree() 返回当前文件内
            // 的条目森林（rewind/fork 留下的兄弟分支同文件共存），getLeafId() 标当前叶。
            // 与 get_session_tree（跨文件家族）是两棵树，别混。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const leafId = entry.manager.getLeafId();
            ws.send(
              JSON.stringify({
                type: "entry_tree",
                sessionId: msg.sessionId,
                ok: true,
                leafId,
                roots: treeToDisplay(entry.manager.getTree(), leafId),
              }),
            );
            break;
          }
          case "navigate_tree": {
            // 树内导航（/tree 选中节点）：底座 navigateTree 留在同一文件内把 leaf 移到
            // 目标条目，被放弃路径保留为兄弟分支——与 branch_session（新建文件）不同，
            // 池键/sessionId 不变。成功后照 compact 模式重建 transcript 推 messages 帧；
            // editorText/editorImages 是目标 user 消息的原文，供前端回填输入框（重问）。
            // 简化：不带 allowAskReopen（ask 重答流程是 TUI 交互专属），ask toolResult
            // 目标走底座默认的 plain leaf move。
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const entryId = String(msg.entryId ?? "");
            if (!entryId) throw new Error("缺少 entryId");
            // 目标即当前 leaf：底座 navigateTree 直接返回 cancelled:false（既不报错也不移动），
            // 静默"成功"会让 output 尾部的分叉按钮看起来生效实则无变化——这里显式回绝。
            if (entry.manager?.getLeafId() === entryId) {
              ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: "已在当前位置" }));
              break;
            }
            try {
              const result = await entry.session.navigateTree(entryId, { summarize: !!msg.summarize });
              if (result.cancelled) {
                ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: "导航被取消" }));
                break;
              }
              if (result.aborted) {
                ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: "分支摘要已中止" }));
                break;
              }
              // getEntries() 是文件内全部条目（被放弃的分支仍在文件里），
              // 活跃 transcript 只要根→叶路径——与底座 renderInitialMessages 的口径一致
              entry.transcript = entriesToTranscript(entry.manager.getBranch());
              ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
              ws.send(
                JSON.stringify({
                  type: "session_navigated",
                  sessionId: msg.sessionId,
                  ok: true,
                  editorText: result.editorText ?? null,
                  editorImages: result.editorImages ?? null,
                }),
              );
            } catch (err) {
              ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: String(err) }));
            }
            break;
          }
          case "prompt":
            // steer=true：流式中不排队而是立即注入（当前工具批次后），idle 时底座忽略该参数照常开 turn
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""), msg.files, msg.steer === true);
            break;
          case "peek_queued":
            handlePeekQueued(ws, msg.sessionId);
            break;
          case "drop_queued":
            handleDropQueued(
              ws,
              msg.sessionId,
              msg.queue === "steering" ? "steering" : "followUp",
              msg.index === undefined ? undefined : Number(msg.index),
            );
            break;
          case "send_now":
            await handleSendNow(ws, msg.sessionId, Number(msg.index));
            break;
          case "requeue":
            handleRequeue(ws, msg.sessionId, Number(msg.index));
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
            // tracked 检查必须用 rel（相对 repoCwd）：工具调用常给绝对路径或仓库根相对路径，
            // 直接拿原始 filePath 当 pathspec 会让 git 报 outside repository——tracked 误判为
            // false 后走 --no-index 兜底，整个文件被渲染成纯新增（diff 显示与 +N-M 摘要不符的根因）
            const tracked = Bun.spawnSync(["git", "-C", repoCwd, "ls-files", "--error-unmatch", "--", rel], {
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
          case "read_image": {
            // 图片二进制读取（对话附件预览等）：后缀白名单 + 8MB 上限，base64 回传；
            // 路径校验对齐 read_file 的宽松度（仅要求非空且是文件）
            const p = String(msg.path ?? "");
            if (!p) throw new Error("缺少 path");
            const MIME: Record<string, string> = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
              bmp: "image/bmp",
              svg: "image/svg+xml",
            };
            const ext = path.extname(p).slice(1).toLowerCase();
            if (!(ext in MIME)) {
              ws.send(JSON.stringify({ type: "image_content", path: p, error: `不支持的图片格式: ${ext || "无后缀"}（仅 png/jpg/jpeg/gif/webp/bmp/svg）` }));
              break;
            }
            const stat = fs.statSync(p, { throwIfNoEntry: false });
            if (!stat?.isFile()) {
              ws.send(JSON.stringify({ type: "image_content", path: p, error: `不是文件: ${p}` }));
              break;
            }
            if (stat.size > 8_000_000) {
              ws.send(JSON.stringify({ type: "image_content", path: p, error: `图片过大（${(stat.size / 1e6).toFixed(1)} MB），仅支持 8MB 内` }));
              break;
            }
            const buf = await fs.promises.readFile(p);
            ws.send(JSON.stringify({ type: "image_content", path: p, mime: MIME[ext], data: buf.toString("base64") }));
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
          case "list_commands": {
            // 斜杠命令清单（输入框 / 补全用）：按需拉取，不做会话生命周期推送。
            // 无 sessionId = 新建会话页请求（隐藏会话级命令，见 pushNewSessionCommands）
            const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
            if (entry) {
              await pushCommands(ws, msg.sessionId, entry);
            } else {
              await pushNewSessionCommands(ws, msg.cwd ? String(msg.cwd) : defaultCwd);
            }
            break;
          }
          case "list_files": {
            // @ 文件候选：reqId 原样回传，前端据此丢弃过期响应
            const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
            const root = entry ? entry.session.sessionManager.getCwd() : String(msg.cwd ?? "");
            if (!root) throw new Error("缺少 cwd");
            const query = String(msg.query ?? "");
            ws.send(
              JSON.stringify({
                type: "file_matches",
                reqId: msg.reqId,
                matches: await listFileMatches(root, query),
              }),
            );
            break;
          }
          case "bash_exec": {
            // ! 本地命令：结果走 bashExecution 落盘（底座 executeBash 内部完成），
            // 实时流由专用帧驱动（bash_start/chunk/done），不进模型事件流
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const command = String(msg.command ?? "").trim();
            if (!command) break;
            const excludeFromContext = msg.excludeFromContext === true;
            if (entry.session.isBashRunning) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  sessionId: msg.sessionId,
                  message: "已有 bash 命令在执行，先按停止或等它结束",
                }),
              );
              break;
            }
            const item: TranscriptItem = { role: "bash", text: command, output: "", running: true, excludeFromContext };
            entry.transcript.push(item);
            ws.send(JSON.stringify({ type: "bash_start", sessionId: msg.sessionId, command, excludeFromContext }));
            entry.session
              .executeBash(
                command,
                (chunk) => ws.send(JSON.stringify({ type: "bash_chunk", sessionId: msg.sessionId, chunk })),
                { excludeFromContext, useUserShell: true },
              )
              .then((r) => {
                item.output = r.output;
                item.running = false;
                item.exitCode = r.exitCode ?? null;
                item.cancelled = r.cancelled;
                item.timedOut = r.timedOut === true;
                item.truncated = r.truncated;
                // 底座 lazy 门：纯 ! 会话（无 assistant 消息）不落盘，重开会话会丢 bash 行。
                // 用户既然执行了命令，这里显式跨门让整份内存 entries（含本条）写盘。
                entry.manager.ensureOnDisk?.().catch((err: unknown) => {
                  process.stderr.write(`[host] ensureOnDisk 失败: ${String(err)}\n`);
                });
                ws.send(
                  JSON.stringify({
                    type: "bash_done",
                    sessionId: msg.sessionId,
                    exitCode: r.exitCode ?? null,
                    cancelled: r.cancelled,
                    timedOut: r.timedOut === true,
                    truncated: r.truncated,
                    output: r.output,
                  }),
                );
              })
              .catch((err: unknown) => {
                item.running = false;
                ws.send(
                  JSON.stringify({
                    type: "bash_done",
                    sessionId: msg.sessionId,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              });
            break;
          }
          case "bash_abort": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            entry.session.abortBash(); // 同步触发；executeBash 的 promise 会自行 resolve 并再发一帧 bash_done
            ws.send(JSON.stringify({ type: "bash_done", sessionId: msg.sessionId, cancelled: true }));
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
              baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            // 多账号对齐:与会话请求同参(providerSessionId 粘性 + modelId)解析凭证,
            // 明细卡配额即本会话实际命中的账号;key 反查凭证 id 后以 #id 为缓存键
            // (与模型页 accounts/后台预载共用同一缓存行),身份标签一并回填
            let keyOverride: string | null | undefined;
            let cacheTag: string | undefined;
            let accountLabel = "";
            if (entry) {
              const model = entry.session.model;
              keyOverride =
                (await H.authStorage.getApiKey(ompProvider, entry.providerSessionId, {
                  baseUrl,
                  modelId: model?.id,
                })) ?? null;
              const hit = (H.authStorage.listStoredCredentials?.(ompProvider) ?? []).find((c: any) => {
                const cred = c.credential;
                return cred?.type === "api_key" ? cred.key === keyOverride : cred?.access === keyOverride;
              });
              if (hit) cacheTag = `#${hit.id}`;
              const cred: any = hit?.credential;
              accountLabel = cred?.email ?? cred?.accountId ?? cred?.orgName ?? "";
            }
            const { vendor, label, row } = await fetchSessionLimits(H.authStorage, ompProvider, baseUrl, keyOverride, cacheTag);
            ws.send(
              JSON.stringify({
                type: "limits_result",
                sessionId: msg.sessionId,
                label: accountLabel ? `${label} · ${accountLabel}` : label,
                unsupported: vendor === null,
                status: row?.status ?? "unavailable",
                planLabel: row?.planLabel ?? "",
                accountLabel,
                balance: row?.balance ?? null,
                windows: row?.windows ?? [],
                updatedAt: row?.updatedAt ?? null,
              }),
            );
            break;
          }
          case "get_provider_limits": {
            // 模型管理页按供应商读配额(多账号逐凭证,命中 limits 60s 缓存)
            const ompProvider = String(msg.provider ?? "");
            if (!ompProvider) throw new Error("缺少 provider");
            let baseUrl = "";
            try {
              baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            const { vendor, label, accounts } = await fetchProviderAccountsLimits(H.authStorage, ompProvider, baseUrl);
            const first = accounts[0]?.row;
            ws.send(
              JSON.stringify({
                type: "provider_limits_result",
                provider: ompProvider,
                label,
                unsupported: vendor === null,
                // 顶层字段取首个账号(单账号消费方兼容);多账号时前端读 accounts 逐段渲染
                status: first?.status ?? "unavailable",
                planLabel: first?.planLabel ?? "",
                accountLabel: accounts[0]?.label || first?.accountLabel || "",
                balance: first?.balance ?? null,
                windows: first?.windows ?? [],
                updatedAt: first?.updatedAt ?? null,
                accounts: accounts.map((a) => ({
                  id: a.id,
                  label: a.label || a.row.accountLabel || "",
                  status: a.row.status ?? "unavailable",
                  planLabel: a.row.planLabel ?? "",
                  accountLabel: a.row.accountLabel ?? "",
                  balance: a.row.balance ?? null,
                  windows: a.row.windows ?? [],
                  updatedAt: a.row.updatedAt ?? null,
                })),
              }),
            );
            break;
          }
          case "git_stage": {
            // 暂存：git add -- <paths>（数组参数直传，-- 防路径注入）
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const paths = stringPaths(msg.paths);
            if (paths.length === 0) throw new Error("缺少 paths");
            const r = runGitChecked(cwd, ["add", "--", ...paths]);
            if (!r.ok) ws.send(JSON.stringify({ type: "git_staged", cwd, error: r.error }));
            else ws.send(JSON.stringify({ type: "git_staged", cwd, ok: true }));
            break;
          }
          case "git_unstage": {
            // 取消暂存：git reset HEAD -- <paths>
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const paths = stringPaths(msg.paths);
            if (paths.length === 0) throw new Error("缺少 paths");
            const r = runGitChecked(cwd, ["reset", "HEAD", "--", ...paths]);
            if (!r.ok) ws.send(JSON.stringify({ type: "git_unstaged", cwd, error: r.error }));
            else ws.send(JSON.stringify({ type: "git_unstaged", cwd, ok: true }));
            break;
          }
          case "git_discard": {
            // 丢弃工作区改动（破坏性，UI 侧已二次确认，host 直接执行）：
            // tracked 走 checkout -- 恢复，untracked 走 clean -f -- 精确路径删除；逐路径处理，任一失败即回错
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const paths = stringPaths(msg.paths);
            if (paths.length === 0) throw new Error("缺少 paths");
            let err = "";
            for (const p of paths) {
              const tracked = runGitChecked(cwd, ["ls-files", "--error-unmatch", "--", p]);
              const r = tracked.ok ? runGitChecked(cwd, ["checkout", "--", p]) : runGitChecked(cwd, ["clean", "-f", "--", p]);
              if (!r.ok) {
                err = r.error;
                break;
              }
            }
            if (err) ws.send(JSON.stringify({ type: "git_discarded", cwd, error: err }));
            else ws.send(JSON.stringify({ type: "git_discarded", cwd, ok: true }));
            break;
          }
          case "git_commit": {
            // 提交：message 经数组参数传（无 shell 拼接，防注入）；paths 省略 = 提交全部已暂存，
            // 给定 = pathspec 提交（git 自动暂存这些路径的改动并只提交它们）。回包带新提交 sha。
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const message = String(msg.message ?? "");
            if (!message.trim()) throw new Error("缺少 message");
            const paths = stringPaths(msg.paths);
            const args = ["commit", "-m", message, ...(paths.length > 0 ? ["--", ...paths] : [])];
            const r = runGitChecked(cwd, args);
            if (!r.ok) {
              ws.send(JSON.stringify({ type: "git_committed", cwd, error: r.error }));
              break;
            }
            const sha = runGitChecked(cwd, ["rev-parse", "HEAD"]);
            if (!sha.ok) {
              ws.send(JSON.stringify({ type: "git_committed", cwd, error: sha.error }));
              break;
            }
            ws.send(JSON.stringify({ type: "git_committed", cwd, ok: true, commit: sha.stdout.trim() }));
            break;
          }
          case "git_push": {
            // 推送当前分支（不自动 -u）：无 upstream 时 git 报错，stderr 透传为 error
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const r = runGitChecked(cwd, ["push"]);
            if (!r.ok) ws.send(JSON.stringify({ type: "git_pushed", cwd, error: r.error }));
            else {
              // push 的进度/结果输出（分支更新行）在 stderr，成功时取作 result
              ws.send(JSON.stringify({ type: "git_pushed", cwd, ok: true, result: r.stderr.trim() || r.stdout.trim() }));
            }
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
                // XY 两列拆开（X=暂存区/index 状态，Y=工作区状态），供 UI 行级暂存/取消暂存按钮判定；
                // untracked（??）本质是未暂存的新文件，归 unstaged、不给 staged
                const xy = line.slice(0, 2);
                return {
                  code: line.slice(0, 2).trim() || "?",
                  path,
                  staged: xy[0] === " " || xy[0] === "?" ? "" : xy[0],
                  unstaged: xy[1] === " " ? "" : xy[1],
                };
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
            H.settings.override("tools.approvalMode", mode);
            ws.send(JSON.stringify({ type: "approval_mode", mode }));
            break;
          }
          case "set_plan_mode": {
            // 计划模式开关：UI 从权限模式菜单进入、从权限胶囊右侧的「计划」按钮退出
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            setPlanMode(ws, msg.sessionId, entry, msg.enabled === true);
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
            const target = H.scopedModels.find((m) => `${m.provider}/${m.id}` === msg.model);
            if (!target) throw new Error(`未知模型: ${msg.model}`);
            await entry.session.setModel(target); // persist 默认 false，仅本会话生效
            // enabledModels 条目带的 ":thinking" 默认级别与 CLI 行为一致地应用
            const defaultLevel = enabledDefaults.get(msg.model);
            if (defaultLevel) entry.session.setThinkingLevel(defaultLevel);
            const model = `${entry.session.model.provider}/${entry.session.model.id}`;
            // 模型切换后回传配置选择器（"auto" 或具体档位）：右下角显示用户配置的模式，
            // 能力钳制后的生效值属于发送参数细节，不进 UI
            ws.send(
              JSON.stringify({
                type: "session_model",
                sessionId: msg.sessionId,
                model,
                thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
              }),
            );
            break;
          }
          case "set_thinking": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            entry.session.setThinkingLevel(msg.level);
            // 回传配置选择器（"auto" 或具体档位）；钳制后的生效值不进 UI
            ws.send(
              JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.configuredThinkingLevel?.() ?? "auto" }),
            );
            break;
          }
          case "ui_error": {
            // 前端未捕获错误上报（WKWebView 无 console，dev 终端是唯一出口）
            process.stderr.write(`[ui] ${msg.message}\n`);
            break;
          }
          case "get_settings":
            ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
            break;
          case "get_settings_schema":
            ws.send(JSON.stringify({ type: "settings_schema", schema: SETTINGS_SCHEMA }));
            break;
          case "reload_settings": {
            // 本地 config 文件可能被手工修改：从磁盘重载（仅模型设置），并推送新模型列表
            try {
              await H.settings.reloadFromDisk();
              rebuildScopedModels();
              ws.send(JSON.stringify(modelsFrame()));
              ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            } catch (err) {
              process.stderr.write(`[host] reload_settings 失败: ${err}\n`);
            }
            break;
          }
          case "set_setting": {
            const key = String(msg.key ?? "");
            const value = msg.value;
            const def = SETTINGS_SCHEMA[key];
            if (!def) throw new Error(`未知设置项: ${key}`);
            const t = def.type;
            if (t === "boolean") {
              if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值`);
            } else if (t === "number") {
              if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`);
            } else if (t === "string") {
              if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
            } else if (t === "enum") {
              if (!def.values.includes(value)) throw new Error(`${key} 必须是 ${def.values.join("/")} 之一`);
            } else if (t === "array") {
              if (!Array.isArray(value)) throw new Error(`${key} 必须是数组`);
              const d = def.default;
              if (Array.isArray(d) && d.every((x) => typeof x === "string") && d.length > 0 && !value.every((x) => typeof x === "string"))
                throw new Error(`${key} 元素必须是字符串`);
            } else if (t === "record") {
              if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} 必须是对象`);
            }
            // 逐键附加校验：ask.timeout 必须非负
            if (key === "ask.timeout" && (typeof value !== "number" || value < 0)) throw new Error("ask.timeout 必须是非负秒数");
            H.settings.set(key, value);
            // 写后副作用：睡眠防止需立即应用到进程
            if (key === "power.sleepPrevention") applySleepPrevention(value);
            // 模型相关键：重建 scoped 目录并推送 models 帧
            const isModelKey = ["enabledModels", "enabledProviders", "disabledProviders", "modelRoleStorage", "modelTags", "modelProviderOrder", "cycleOrder"].includes(key);
            if (isModelKey) rebuildScopedModels();
            await H.settings.flush();
            if (isModelKey) ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
            break;
          }
          case "set_acp_enabled": {
            // 实验性功能页开关：写入 omp-desktop.json 的 acp.enabled（只影响此后创建的会话——
            // 工具面与 context 扩展在 createSessionCore 里注入，无法热插拔到已打开的会话）
            await writeAcpEnabled(!!msg.enabled);
            ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
            break;
          }
          case "set_session_context_enabled": {
            // 实验性功能页开关：写入 omp-desktop.json 的 sessionContext.enabled（同上，只影响此后创建的会话）
            await writeSessionContextEnabled(!!msg.enabled);
            ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
            break;
          }
          case "set_desktop_env": {
            const next: DesktopEnv = {
              httpProxy: String(msg.httpProxy ?? "").trim(),
              noProxy: String(msg.noProxy ?? "").trim(),
              caCerts: String(msg.caCerts ?? "").trim(),
            };
            await writeFile(H.desktopEnvPath, JSON.stringify(next, null, 2));
            H.desktopEnv = next;
            H.desktopEnvFilePresent = true;
            applyDesktopEnv(next);
            ws.send(JSON.stringify({ type: "settings", settings: settingsFrame(), restartHint: true }));
            break;
          }
          case "get_models_catalog":
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          case "get_all_providers":
            ws.send(
              JSON.stringify({
                type: "all_providers",
                providers: listAllProviders().map((p) => {
                  let accounts = 0;
                  try {
                    accounts = (H.authStorage.listStoredCredentials?.(p.id) ?? []).length;
                  } catch {}
                  const loginKind = authPolicyFor(p.id)?.login?.kind;
                  return {
                    ...p,
                    // 登录能力:仅 oauth-code/device-code/custom 有真实授权流(浏览器/设备码/供应商自定义);
                    // api-key 型在底座只是「粘贴 key 并校验」,详情页已有 API Key 输入框,不再重复给入口
                    login: loginKind === "oauth-code" || loginKind === "device-code" || loginKind === "custom",
                    // 已配置账号数:authStorage 活跃凭证数(models.yml/env 层配置不计入)
                    accounts,
                  };
                }),
              }),
            );
            break;
          case "provider_login": {
            // OMP 登录流程(AuthStorage.login):浏览器授权 + 需要粘贴码时经 UI 弹窗中转
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            if (H.loginInFlight) throw new Error("已有登录流程进行中，请完成或稍后再试");
            H.loginInFlight = true;
            H.loginAbort = new AbortController();
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
              const identity = await H.authStorage.login(provider, {
                signal: H.loginAbort.signal,
                onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
                  if (H.loginAbort?.signal.aborted) return;
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
                    H.loginAbort?.signal.addEventListener(
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
              await H.modelRegistry.refresh();
              H.availableModels = H.modelRegistry.getAvailable();
              rebuildScopedModels();
              reply(modelsFrame());
              reply({ type: "models_catalog", models: modelCatalog() });
              reply({ type: "login_done", provider, ok: true, identity: identity ?? null });
            } catch (err) {
              const aborted = H.loginAbort?.signal.aborted;
              reply({
                type: "login_done",
                provider,
                ok: false,
                cancelled: !!aborted,
                message: aborted ? "登录已取消" : String((err as any)?.message ?? err),
              });
            } finally {
              H.loginInFlight = false;
              H.loginAbort = null;
            }
            break;
          }
          case "provider_logout": {
            // 登出供应商：删除存储凭证（本地毫秒级）后立即本地过滤推送目录，UI 瞬时移除；
            // 完整的 modelRegistry.refresh()（逐供应商网络发现，秒级）随后收敛再推一版(幂等)。
            // models.yml 手写 apiKey 的优先级高于存储凭证，该类供应商 UI 不提供登出入口
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            await H.authStorage.remove(provider);
            H.availableModels = H.availableModels.filter((m) => m.provider !== provider);
            rebuildScopedModels();
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            try {
              await H.modelRegistry.refresh();
              H.availableModels = H.modelRegistry.getAvailable();
              rebuildScopedModels();
              ws.send(JSON.stringify(modelsFrame()));
              ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            } catch (err) {
              process.stderr.write(`[host] 登出后模型目录刷新失败: ${err}\n`);
            }
            break;
          }
          case "provider_login_cancel": {
            // 用户显式取消(如关闭了登录页):中断进行中的登录流程
            if (H.loginInFlight && H.loginAbort) H.loginAbort.abort();
            else throw new Error("当前没有进行中的登录流程");
            break;
          }
          case "provider_set_key": {
            // 配置 API key:写入 authStorage(api_key 凭证),随后刷新模型目录
            const provider = String(msg.provider ?? "");
            const key = String(msg.key ?? "").trim();
            if (!provider) throw new Error("缺少 provider");
            if (!key) throw new Error("API key 不能为空");
            H.authStorage.upsertCredential(provider, { type: "api_key", key });
            await H.modelRegistry.refresh();
            H.availableModels = H.modelRegistry.getAvailable();
            rebuildScopedModels();
            ws.send(JSON.stringify(modelsFrame()));
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
            const modelsPath = path.join(H.agentDir, "models.yml");
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
            if (!H.availableModels.some((m) => `${m.provider}/${m.id}` === id)) throw new Error(`未知模型: ${id}`);
            let entries: string[] = (H.settings.get("enabledModels") ?? []).slice();
            if (entries.length === 0) {
              entries = H.availableModels.map((m) => `${m.provider}/${m.id}`);
            }
            const without = entries.filter((e) => e.split(":")[0] !== id);
            if (on) {
              const prev = entries.find((e) => e.split(":")[0] === id);
              without.push(prev ?? id);
            }
            if (without.length === 0) throw new Error("至少保留一个启用模型");
            H.settings.set("enabledModels", without);
            await H.settings.flush();
            rebuildScopedModels();
            if (H.scopedModels.length === 0) throw new Error("启用列表过滤后没有可用模型");
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          }
          case "get_model_roles":
            ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
            break;
          case "set_model_role": {
            // 合法名即可写入：既改已知角色，也从输入框菜单创建自定义角色（覆盖同名旧值）
            const role = String(msg.role ?? "");
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role)) throw new Error(`非法角色名: ${role}`);
            // UI 只写精确 "provider/model"（或 null 清除回默认链），别名/后缀交给 settings.json 手写
            const value = msg.value == null || msg.value === "" ? undefined : String(msg.value);
            if (value && !H.availableModels.some((m) => `${m.provider}/${m.id}` === value)) {
              throw new Error(`未知模型: ${value}`);
            }
            H.settings.setModelRole(role, value);
            await H.settings.flush();
            ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
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
            const rel = path.relative(path.resolve(path.join(H.agentDir, "memories")), file);
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
            const disabled = new Set<string>(((H.settings.get("disabledExtensions") ?? []) as string[]));
            const ignored = new Set<string>(((H.settings.get("skills.ignoredSkills") ?? []) as string[]));
            const skillExtId = `skill:${name}`;
            if (enabled) {
              disabled.delete(skillExtId);
              ignored.delete(name);
            } else {
              disabled.add(skillExtId);
            }
            H.settings.set("disabledExtensions", Array.from(disabled));
            H.settings.set("skills.ignoredSkills", Array.from(ignored));
            await H.settings.flush();
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
            const userPath = path.join(H.agentDir, "mcp.json");
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
              ? H.agentDir
              : scope.startsWith("project:")
              ? (nearestProjectOmpDir(scope.slice(8)) ?? path.join(path.resolve(scope.slice(8)), ".omp"))
              : H.agentDir;
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
            const userPath = path.join(H.agentDir, "mcp.json");
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
            ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
            ws.send(JSON.stringify(modelsFrame()));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            await handleListSessions(ws);
            try {
              ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            } catch {}
            ws.send(JSON.stringify({ type: "profile_switched", profile: H.currentProfile }));
            break;
          }
          case "terminal_create": {
            // 右栏终端：起真 PTY（pty.ts 的 pty-bridge 子进程），数据帧回推。
            // id 由前端生成（tab 级 persistentKey），create 前就可能收到 onData，故不能等返回值
            const id = String(msg.id ?? crypto.randomUUID());
            const cwd = String(msg.cwd ?? process.cwd()).trim() || process.cwd();
            const cols = Math.max(2, Math.min(500, Number(msg.cols) || 80));
            const rows = Math.max(2, Math.min(200, Number(msg.rows) || 24));
            const session = await createTerminal(
              ws,
              { id, cwd, cols, rows, shell: msg.shell ? String(msg.shell) : undefined },
              (data) => {
                try { ws.send(JSON.stringify({ type: "terminal_data", id, data })); } catch {}
              },
              (code) => {
                try { ws.send(JSON.stringify({ type: "terminal_exit", id, code })); } catch {}
              },
            );
            ws.send(JSON.stringify({ type: "terminal_created", id: session.id, shell: session.shell }));
            break;
          }
          case "terminal_write": {
            const t = terminalFor(ws, msg.id);
            if (t) t.send(String(msg.data ?? ""));
            break;
          }
          case "terminal_resize": {
            const t = terminalFor(ws, msg.id);
            if (t) t.resize(Math.max(2, Number(msg.cols) || 80), Math.max(2, Number(msg.rows) || 24));
            break;
          }
          case "terminal_dispose": {
            const t = terminalFor(ws, msg.id);
            if (t) t.dispose();
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
    close(ws) {
      // 前端断开：清理其名下终端 PTY，防孤儿 shell 进程
      disposeTerminalsOf(ws);
    },
  },
});

// ---------- 磁盘资产 ----------
// 取消 1s 指纹轮询自动推送:前端设置页(MCP/技能/子智能体)改用手动「刷新」按钮(list_agent_assets)

// 挂起的审批请求：requestId -> resolve（answer 为 undefined 即拒绝语义）
const pendingApprovals = new Map<string, { resolve: (v: string | undefined) => void }>();

/** 审批卡往返：推 approval_request，等 approval_response 解析选项文本（undefined = 取消/中止）。 */
function requestApproval(
  ws: { send(data: string): unknown },
  sessionId: string,
  title: string,
  options: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const requestId = crypto.randomUUID();
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const settle = (v: string | undefined) => {
    pendingApprovals.delete(requestId);
    resolve(v);
  };
  pendingApprovals.set(requestId, { resolve: settle });
  // agent 中止/工具取消：AbortSignal 到来即按取消（undefined）结束挂起
  signal?.addEventListener("abort", () => settle(undefined), { once: true });
  ws.send(JSON.stringify(stampEvent({ type: "approval_request", sessionId, requestId, title, options })));
  return promise;
}

function pushContext(ws: any, sessionId: string, entry: PoolEntry) {
  const u = entry.session.getContextUsage();
  if (u) {
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "context",
          sessionId,
          tokens: u.tokens,
          window: u.contextWindow,
          percent: u.percent,
        }),
      ),
    );
  }
}

// 会话累计统计（TUI status-line 的 token/cache/cost/time 段汇总）：输入框下方状态行常驻显示。
// 与上下文明细卡（get_context_detail 的 breakdown/stats）不同，这里是「整会话」口径：
// tokens 含历史累加，时长含进行中窗口
function buildSessionStats(entry: PoolEntry) {
  const st = entry.session.getSessionStats();
  // 缓存利用率（TUI cache_hit 段同款公式）：cacheRead/(cacheRead+cacheWrite+input)。
  // 分母含未命中 input，Anthropic/OpenRouter（miss 记 input）与 DeepSeek（miss 记 input、
  // cacheWrite 为 0）都还原成 hit/(hit+miss)
  const promptTokens = st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite;
  return {
    tokens: st.tokens,
    cost: st.cost,
    cacheHitRate: promptTokens > 0 ? st.tokens.cacheRead / promptTokens : 0,
    // TUI cost 段同款：会话总成本 = 主会话成本 + advisor 成本（未启用 advisor 时为 0）
    advisorCost: entry.session.getAdvisorCost(),
    // 活跃时长含进行中窗口（与 TUI getActiveMs 一致：空闲墙钟不计）
    activeMs: entry.activeMs + (entry.activeStartedAt === null ? 0 : Date.now() - entry.activeStartedAt),
  };
}

function pushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  ws.send(JSON.stringify({ type: "session_stats", sessionId, ...buildSessionStats(entry) }));
}

function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "event", sessionId, ...ui })));
    // todo 工具落盘后推送最新任务清单（TodoTracker 在工具结果后更新）
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      ws.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases: entry.session.getTodoPhases() })));
    }
    // goal 模式钩子：续跑调度与工具集收尾（对齐 TUI #handleGoalSessionEvent 的分支）
    if (ev.type === "agent_start") entry.goal.onAgentStart();
    if (ev.type === "message_start" && ev.message?.role === "user" && !ev.message?.synthetic) entry.goal.onUserMessage();
    if (ev.type === "goal_updated") entry.goal.onGoalUpdated(ev.state);
    // 会话活跃时长计时（TUI status-line time_spent 同款）：agent_start 开窗（幂等，重入不双计），
    // 真正收尾的 agent_end 折窗；isTerminal === false 的中间 agent_end 之后还会续跑，不折
    if (ev.type === "agent_start") {
      if (entry.activeStartedAt === null) entry.activeStartedAt = Date.now();
    } else if (ev.type === "agent_end" && ev.isTerminal !== false && entry.activeStartedAt !== null) {
      entry.activeMs += Math.max(0, Date.now() - entry.activeStartedAt);
      entry.activeStartedAt = null;
    }
    // turn 真正结束后推送上下文占用（此时消息已定稿）；同时校准排队行（steer 已消费）
    if (ev.type === "agent_end" && ev.isTerminal !== false) {
      // fileMention 回读：底座在 prompt() 内部追加 fileMention 消息（请求数组 + 落盘），
      // 没有对应事件；这里扫自 mentionScanIndex 起的新条目转成 mention 帧下发
      const entries = entry.manager.getEntries();
      for (let i = entry.mentionScanIndex; i < entries.length; i++) {
        const e = entries[i];
        if (e?.type === "message" && e.message?.role === "fileMention") {
          const files = (e.message.files ?? []).map((f: { path?: unknown }) => String(f.path ?? ""));
          entry.transcript.push({ role: "mention", text: "", files });
          ws.send(JSON.stringify({ type: "event", sessionId, kind: "mention", files }));
        }
      }
      entry.mentionScanIndex = entries.length;
      pushContext(ws, sessionId, entry);
      pushSessionStats(ws, sessionId, entry);
      // goal 终局评估：完成收尾 / 无进展抑制 / 调度续跑（对齐 TUI #handleGoalSessionEvent）
      void entry.goal.onAgentEnd(ev.messages ?? []);
      // 收尾竞态兜底：底座在 run 收尾 abort 时，正在 claim 的队列消息会被丢弃且不回队
      // （agent.ts #prepareQueuedMessageBatch 的 dequeue-先移出 + abort-不 restore），表现为
      // 「上次快照里有、现在队列没有、dequeue hook 从未通知消费」。host 重新发送该消息。
      // parked 暂存的消息同样计入现存集合——它们不在底座队列是设计使然，不是被吞。
      const a = entry.session.agent as any;
      const cur = [...a.peekFollowUpQueue(), ...entry.parkedFollowUp, ...a.peekSteeringQueue()]
        .filter((m: any) => isUserQueuedMessage(m))
        .map((m: any) => toRestoredQueuedMessage(m).text);
      const curSet = new Set(cur);
      const lost = (entry.queuedTexts ?? []).filter(
        (t) => !curSet.has(t) && !(entry.consumedTexts ?? []).includes(t),
      );
      for (const t of lost) {
        process.stderr.write(`[host] 排队消息被收尾竞态吞掉，重新发送: ${t.slice(0, 60)}\n`);
        entry.consumedTexts.push(t);
        entry.session.prompt(t).catch((err: unknown) => {
          ws.send(JSON.stringify(stampEvent({ type: "error", sessionId, message: String(err) })));
        });
      }
      // 逐轮放回：parked 有剩余时放回 1 条并触发消费（每条独立 turn）。
      // 兜底重发刚起了新 run 的场合（lost 非空）本轮不放，等那个 run 的 agent_end 接续。
      if (lost.length === 0 && entry.parkedFollowUp.length > 0) {
        for (const m of releaseOneParked(entry)) a.followUp(m);
        // agent_end 事件先于 isStreaming 复位的窗口里 continue 会 busy：等 idle 后补一次
        a.continue().catch(() => {
          a.waitForIdle?.()
            .then(() => a.continue())
            .catch((err: unknown) => {
              process.stderr.write(`[host] 排队消息续轮触发失败: ${String(err)}\n`);
            });
        });
      }
      sendQueued(ws, sessionId, entry);
    }
  });
  // 审批/对话框：非 yolo 模式下审批 gate 通过 ExtensionUIContext.select 挂起等用户选择
  const uiCtx = {
    // ask 等工具的 UI 超时从对话框呈现起算，而不是工具发起时
    timeoutStartsOnPresentation: true,
    select(title: string, options: any[], dialogOptions?: any): Promise<string | undefined> {
      return requestApproval(
        ws,
        sessionId,
        title,
        options.map((o) => (typeof o === "string" ? o : o.label)),
        dialogOptions?.signal,
      );
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
          JSON.stringify(
            stampEvent({
              type: "approval_request",
              sessionId,
              requestId,
              title: `${title}\n${message}`,
              options: ["OK", "Cancel"],
            }),
          ),
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
          JSON.stringify(
            stampEvent({
              type: "approval_request",
              sessionId,
              requestId,
              title,
              options: ["提交", "取消"],
              editable: true,
              prefill: prefill ?? "",
            }),
          ),
        );
      });
    },
  };
  entry.sessionResult.setToolUIContext(uiCtx, true);
  // 关键一步（ACP 同款，acp-agent.ts:2631）：runner.hasUI() 判的是 initialize 注入的 uiContext，
  // 只调 setToolUIContext 不够——审批 gate 会 fail-closed「no interactive UI」。
  //
  // actions / contextActions 必须给全：runner.initialize 把 contextActions.getModel 直接赋给内部
  // #getModel（runner.ts:695，没有 ?? 兜底），传空对象会让它变成 undefined；此后任何经
  // createCustomToolContext 求值 ctx.model 的 customTool（sdk.ts:987）都抛
  // 「getModel is not a function」——2026-09-23 实测 read_session_context 因此整工具失败。
  // 第三参传 undefined 而不是空对象：空对象同样会把 #waitForIdleFn / #newSessionHandler 等赋成
  // undefined，只有 undefined 才保留 runner 的 no-op 默认（runner.ts:704 `if (commandContextActions)`）。
  entry.session.extensionRunner?.initialize(
    {
      sendMessage: (message, options) => {
        void entry.session.sendCustomMessage(message, options).catch((err: unknown) => {
          process.stderr.write(`[host] 扩展 sendMessage 失败: ${String(err)}\n`);
        });
      },
      sendUserMessage: (content, options) => {
        void entry.session.sendUserMessage(content, options);
      },
      appendEntry: (customType, data) => {
        entry.session.sessionManager.appendCustomEntry(customType, data);
      },
      setLabel: (targetId, label) => {
        entry.session.sessionManager.appendLabelChange(targetId, label);
      },
      getActiveTools: () => entry.session.getEnabledToolNames(),
      getAllTools: () => entry.session.getAllToolInfos(),
      setActiveTools: async (toolNames) => {
        await entry.session.setActiveToolsByName(toolNames);
      },
      // 桌面无扩展命令面：UI 命令清单走 pushCommands 的 buildAvailableSlashCommands 独立路径
      getCommands: () => [],
      setModel: async (model) => {
        if (!(await entry.session.modelRegistry.getApiKey(model))) return false;
        await entry.session.setModel(model);
        return true;
      },
      getThinkingLevel: () => entry.session.thinkingLevel,
      setThinkingLevel: (level) => entry.session.setThinkingLevel(level),
      getServiceTiers: () => entry.session.serviceTierByFamily,
      setServiceTier: (family, tier) => entry.session.setServiceTierFamily(family, tier),
      getSessionName: () => entry.session.sessionManager.getSessionName(),
      setSessionName: async (name) => {
        await entry.session.sessionManager.setSessionName(name, "user");
      },
    },
    {
      getModel: () => entry.session.model,
      isIdle: () => !entry.session.isStreaming,
      abort: () => {
        void entry.session.abort({ reason: USER_INTERRUPT_LABEL });
      },
      hasPendingMessages: () => entry.session.queuedMessageCount > 0,
      shutdown: () => {},
      getContextUsage: () => entry.session.getContextUsage(),
      getSystemPrompt: () => entry.session.systemPrompt,
      compact: async () => {
        await entry.session.compact();
      },
    },
    undefined, // 命令上下文动作：桌面未接扩展命令面，保留 runner 默认 no-op
    uiCtx,
    "rpc",
  );

  // 整棵 spawn 树共享根会话的 eventBus（sdk.ts:1341）：子代理 lifecycle/event/progress 帧都在上面。
  // host 侧补齐的派生数据（AgentProgress 本身没有的）：
  //   registeredAt —— lifecycle started 帧到达时刻（详情卡 Registered 时间戳）
  //   name / parent —— task 工具调用的 args 里带子代理名，toolCallId 记归属方
  //                   （根会话=Main，子代理流里=该子代理），parentToolCallId 反查「Spawned by X」
  const subRegistered = new Map<string, number>(); // subagentId -> started 时刻
  const subSpawnCall = new Map<string, string>(); // subagentId -> 父 task toolCallId
  const callOwner = new Map<string, { owner: string; names: string[] }>(); // task toolCallId -> 归属 + spawn 的子代理名
  const spawnTools: Record<string, true> = { task: true, agent: true };
  const spawnNames = (args: Record<string, unknown>): string[] => {
    const items = Array.isArray(args.tasks) ? args.tasks : [args];
    return items.map((t) => (t && typeof t === "object" && "name" in t && typeof t.name === "string" ? t.name : undefined)).filter((n): n is string => !!n);
  };
  const subName = (id: string, agent: string): string => {
    const call = callOwner.get(subSpawnCall.get(id) ?? "");
    return call?.names[0] ?? agent;
  };
  const subParent = (id: string): string => {
    const spawnCall = subSpawnCall.get(id);
    if (!spawnCall) return "Main";
    const owner = callOwner.get(spawnCall);
    return owner?.owner ?? "Main";
  };
  // 根会话里的 task 调用：归属 Main
  const unsubSpawnRoot = entry.session.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start" && spawnTools[ev.toolName]) {
      callOwner.set(ev.toolCallId, { owner: "Main", names: spawnNames(ev.args) });
    }
  });
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    if (p.parentToolCallId) subSpawnCall.set(p.id, p.parentToolCallId);
    if (p.status === "started") subRegistered.set(p.id, Date.now());
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "subagent_lifecycle",
          sessionId,
          subagentId: p.id,
          agent: p.agent,
          description: p.description,
          status: p.status,
          name: subName(p.id, p.agent),
          parent: subParent(p.id),
          registeredAt: subRegistered.get(p.id),
          detached: p.detached ?? false,
        }),
      ),
    );
    // 终态帧后补发最后一帧 progress（节流可能压掉），保证结束时成本/token 落到最终值
    if (p.status !== "started") {
      const last = subLastProgress.get(p.id);
      if (last) ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, ...last }));
    }
  });
  // 聚合进度帧：成本/时长/请求/工具/token/上下文（高频且累积，500ms 节流；状态变化立即发）
  const subLastProgress = new Map<string, Record<string, unknown>>();
  const subSentAt = new Map<string, number>();
  const subSentStatus = new Map<string, string>();
  const unsubProgress = eventBus.on("task:subagent:progress", (p: any) => {
    const pr = p.progress ?? {};
    const payload = {
      agent: p.agent,
      status: pr.status,
      task: pr.task,
      cost: pr.cost,
      durationMs: pr.durationMs,
      requests: pr.requests,
      toolCount: pr.toolCount,
      tokens: pr.tokens,
      contextTokens: pr.contextTokens,
      contextWindow: pr.contextWindow,
      currentTool: pr.currentTool,
      currentToolArgs: pr.currentToolArgs,
      currentToolStartMs: pr.currentToolStartMs,
      lastIntent: pr.lastIntent,
      resolvedModel: pr.resolvedModel,
      resolvedThinkingLevel: pr.resolvedThinkingLevel,
      recentTools: pr.recentTools,
    };
    subLastProgress.set(p.id, payload);
    const now = Date.now();
    const statusChanged = subSentStatus.get(p.id) !== pr.status;
    if (!statusChanged && now - (subSentAt.get(p.id) ?? 0) < 500) return;
    subSentAt.set(p.id, now);
    subSentStatus.set(p.id, pr.status);
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, name: subName(p.id, p.agent), parent: subParent(p.id), registeredAt: subRegistered.get(p.id), ...payload }));
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    // 子代理流里的 task 调用：归属该子代理（嵌套 spawn）
    if (event.type === "tool_execution_start" && spawnTools[event.toolName]) {
      callOwner.set(event.toolCallId, { owner: subName(id, id), names: spawnNames(event.args) });
    }
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "subagent_event", sessionId, subagentId: id, ...ui })));
  });
  // 消费前通知：即将注入的排队/steer 用户消息推给 UI（气泡转正）；同时记入已消费
  // 清单，供 turn_end 的收尾竞态兜底 diff 排除（hook 触发 ≠ 注入成功，但不重复重发）
  const detachDequeueHook = entry.session.agent.addBeforeQueuedMessageDequeueHook(() => {
    const texts = [...entry.session.agent.peekFollowUpQueue(), ...entry.session.agent.peekSteeringQueue()]
      .filter((m) => isUserQueuedMessage(m))
      .map((m) => toRestoredQueuedMessage(m).text);
    if (texts.length > 0) {
      entry.consumedTexts.push(...texts);
      ws.send(JSON.stringify(stampEvent({ type: "steer_consumed", sessionId, texts })));
    }
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubSpawnRoot();
    unsubLifecycle();
    unsubProgress();
    unsubEvents();
    detachDequeueHook();
  };
  entry.attachedWs = ws;
  sessions.set(sessionId, entry);
}

async function handleCreateSession(ws: any, cwd?: string, modelStr?: string, thinkingLevel?: string) {
  const workDir = typeof cwd === "string" && cwd ? cwd : defaultCwd;
  const targetModel = modelStr ? H.scopedModels.find((m) => `${m.provider}/${m.id}` === modelStr) : undefined;
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
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
    }),
  );
  pushPlanMode(ws, sessionId, entry);
  process.stderr.write(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir} model=${modelStr ?? "default"} thinking=${thinkingLevel ?? "default"}（活跃 ${sessions.size}）\n`);
}

async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error("缺少 path");
  // 池内已有同 path 条目：复用，不重建。重建会让同一会话文件被两个 AgentSession 同时
  // 持有（各自落盘互相覆盖），旧条目连同它的订阅一并泄漏在池里。
  // 命中路径：前端会话 LRU 驱逐后切回（同一 ws，只重推快照）；前端 reload 后点击
  // （新 ws，重挂订阅——旧订阅发往已关闭的连接，事件会丢）。
  for (const [sessionId, entry] of sessions.entries()) {
    if (entry.path !== sessionPath) continue;
    if (entry.attachedWs !== ws) {
      entry.unsubscribe(); // 先解旧订阅，否则同一事件会发两份
      attachEntry(ws, sessionId, entry, entry.sessionResult.eventBus);
    }
    ws.send(
      JSON.stringify({
        type: "session_created",
        sessionId,
        path: entry.path,
        cwd: entry.cwd,
        model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
        thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
        isGit: entry.isGit,
      }),
    );
    pushPlanMode(ws, sessionId, entry); // 复用快照同推计划状态（前端 reload 后靠它显示「计划」按钮）
    ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
    pushTodos(ws, sessionId, entry); // 复用快照同推待办存量（否则前端重建对象后历史 TODO 不展示）
    pushGoal(sessionId); // goal 状态存量（会话状态卡目标区）
    pushContext(ws, sessionId, entry);
    if (entry.externalWrite) ws.send(JSON.stringify({ type: "session_external_write", sessionId })); // LRU 驱逐期间检出的，切回时补发
    process.stderr.write(`[host] 复用池内会话 ${sessionId.slice(0, 8)}（活跃 ${sessions.size}）\n`);
    return;
  }
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // 会话原始 cwd：getEntries() 不含 session header，用 peekSessionInit 读
  // （open 内部同源；目录不可达时它返回 null，兜底 HOME）
  const peek = await SessionManager.peekSessionInit(sessionPath);
  const workCwd = peek?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  // 历史 mention 已在 transcript 里：fileMention 回读游标对齐到全量条目尾，避免首轮回读重发
  entry.mentionScanIndex = entries.length;
  // 历史会话的活跃时长初值：内存计时器只覆盖本次打开后的时间，从磁盘条目按轮次累加补上存量
  entry.activeMs = sumRunDurationMs(entries);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
    }),
  );
  reconcilePlanMode(ws, sessionId, entry, entries); // 落盘 mode_change 恢复计划模式（必须在 session_created 之后推帧）
  await entry.goal.restore(); // 目标模式恢复（落盘 mode_change goal/goal_paused；对齐 TUI 不主动续跑）
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  // 恢复会话的存量任务清单（TodoTracker 构造时从 transcript 分支同步）
  pushTodos(ws, sessionId, entry);
  pushGoal(sessionId); // goal 状态存量（restore 之后推送，会话状态卡目标区）
  // 恢复会话的初始上下文占用（system prompt + 历史）
  pushContext(ws, sessionId, entry);
  // 恢复会话的整会话统计（tokens/cost 从磁盘 assistant 消息的 usage 累加；时长为内存态，重载后从 0 起算）
  pushSessionStats(ws, sessionId, entry);
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
  // 内存池兜底：底座懒建会话文件（首条内容才落盘），仅扫磁盘会漏掉刚建、还没写内容的
  // 会话——UI 的「活跃会话不在列表即弹回欢迎页」校验会误杀新建会话。
  // 已被用户移除的项目跳过：活跃会话不能把移除的项目顶回列表（否则 remove 永不生效）。
  const listed = new Set(all.map((s: any) => s.path));
  for (const [sid, entry] of sessions.entries()) {
    if (listed.has(entry.path)) continue;
    if (H.desktopProjects.removedProjects.includes(entry.cwd)) continue;
    const list = byProject.get(entry.cwd) ?? [];
    list.push({
      id: sid,
      path: entry.path,
      title: entry.title, // 懒建未落盘的会话走内存兜底（含 rename 后的标题）
      firstMessage: "",
      modified: new Date(),
      messageCount: 0,
      cwd: entry.cwd,
    });
    byProject.set(entry.cwd, list);
    listed.add(entry.path);
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
          archived: H.desktopProjects.archivedSessions.includes(s.path),
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: H.desktopProjects.allProjects,
      removedProjects: H.desktopProjects.removedProjects,
      expandedProjects: H.desktopProjects.expandedProjects,
      pinnedSessions: H.desktopProjects.pinnedSessions,
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

// ---------- 斜杠命令本地分发 ----------
// 顺序对齐 ACP #runPromptOrCommand：/skill: → builtin（executeAcpBuiltinSlashCommand）→ 原样走 prompt。
// 返回 null = 本地消费（不调 prompt、不推 user transcript）；返回 string = 转成该文本继续走 prompt。
// prompt() 自身还会展开文件命令 / 自定义 TS 命令 / 扩展命令（agentInvoked=false 信号在 then 里处理）。
async function dispatchSlashInput(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  text: string,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return text;

  // 1) /skill:<name>：底座 prompt() 不处理，必须宿主分发（对齐 ACP #tryRunSkillCommand）
  const parsed = parseSkillInvocation(trimmed);
  const skill = parsed && entry.session.skillsSettings?.enableSkillCommands
    ? entry.session.skills.find((c) => c.name === parsed.name)
    : undefined;
  if (parsed && skill) {
    const built = await buildSkillPromptMessage(skill, parsed, "user");
    await entry.session.promptCustomMessage(
      {
        customType: SKILL_PROMPT_MESSAGE_TYPE,
        content: built.message,
        display: true,
        details: built.details,
        attribution: "user",
      },
      { streamingBehavior: "steer" },
    );
    return null;
  }

  // 2) 已移除命令：既不执行也不落成 prompt（清单已在 pushCommands 过滤，这里挡手输）
  const removedHint = removedSlashHint(trimmed);
  if (removedHint) {
    ws.send(JSON.stringify({ type: "command_output", sessionId, text: removedHint }));
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }

  // 2.5) /goal、/plan：桌面实现（底座两者都只有 handleTui，executeAcpBuiltinSlashCommand 不接手）。
  // 返回文本转正常 prompt 链路（transcript/排队复用）；null = 已消费
  const parsedSlash = parseSlashCommand(trimmed);
  if (parsedSlash?.name === "goal") {
    const objective = await entry.goal.handleCommand(parsedSlash.args);
    if (objective !== null) return objective;
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }
  if (parsedSlash?.name === "plan") {
    const prompt = handlePlanCommand(ws, sessionId, entry, parsedSlash.args);
    if (prompt !== null) return prompt;
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }

  // 3) builtin：41 条无 TUI 执行的命令。桌面 prompt RPC 立即返回、turn 产物全走
  // 常驻事件订阅（与 RPC 模式同构），不需要 keepTurnOpenUntilIdle；但 /compact、/handoff、
  // /rename（无参自动生成标题）等 provider-backed 命令需要 runCommandInBackground——否则
  // 底座内联 await，压缩几十秒期间 UI 无任何反馈且 abort 被卡住（对齐 RPC 模式做法）。
  // 后台命令完成后会话条目会被改写：按指纹检测变化，重建 transcript 推 messages 全量帧
  // 刷新视图；执行期间底座 output 的完成文案先缓存，待视图重建后补发（否则会被冲掉）。
  const entriesSig = (list: any[]) => list.length + ":" + (list[list.length - 1]?.id ?? "");
  const baseline = entriesSig(entry.manager.getEntries());
  let bgOutputs: string[] | null = null; // 非 null = 后台命令执行中，output 暂存
  let bgSucceeded = false; // 后台任务跑出底座成功文案（没跑出 = 中止/静默失败）
  const phaseKey = trimmed.split(/\s+/)[0].replace(/^\//, "");
  const phaseText = PHASE_TEXT[phaseKey];
  // 成功判定：底座完成输出的固定前缀（成功必发其一；无输出 = 中止/失败 → 撤执行中行）
  const phaseSuccess: Record<string, RegExp> = {
    compact: /^Compaction complete/,
    handoff: /^Context handed off and compacted in place\./,
    rename: /^Session renamed to /,
  };
  const runtime: SlashCommandRuntime = {
    session: entry.session,
    sessionManager: entry.session.sessionManager,
    settings: entry.session.settings,
    cwd: entry.session.sessionManager.getCwd(),
    output: (t) => {
      if (bgOutputs) {
        if (phaseSuccess[phaseKey].test(t)) bgSucceeded = true;
        bgOutputs.push(t);
        return;
      }
      ws.send(JSON.stringify({ type: "command_output", sessionId, text: t }));
    },
    refreshCommands: () => pushCommands(ws, sessionId, entry),
    reloadPlugins: () => pushCommands(ws, sessionId, entry),
    runCommandInBackground: (task) => {
      if (bgOutputs === null) {
        bgOutputs = [];
        // 耗时命令的起始分隔行：否则气泡撤回后界面毫无动静（压缩/交接在后台跑）
        ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "start", command: phaseKey, text: phaseText[0] }));
      }
      void task()
        .then(async () => {
          const entries = entry.manager.getEntries();
          if (entriesSig(entries) !== baseline) {
            entry.transcript = entriesToTranscript(entries);
            entry.mentionScanIndex = entries.length; // 回读游标对齐，避免重发历史 mention
            ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
            pushContext(ws, sessionId, entry);
          }
          await handleListSessions(ws); // 标题/列表可能变（rename/handoff 改标题）
          const outs = bgOutputs ?? [];
          bgOutputs = null;
          // 成功：落盘痕已写入，下方 messages 重建帧自带完成分隔行（UI 按 command 吸收执行中行），
          // 不再发 done 瞬时帧；失败/中止：无痕可落，发 fail 撤掉执行中行，错误详情在 output 行里
          if (!bgSucceeded) ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "fail", command: phaseKey }));
          for (const t of outs) ws.send(JSON.stringify({ type: "command_output", sessionId, text: t }));
        })
        .catch((err: unknown) => {
          bgOutputs = null;
          ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "fail", command: phaseKey }));
          ws.send(JSON.stringify({ type: "command_output", sessionId, text: `命令执行失败: ${err instanceof Error ? err.message : String(err)}` }));
        });
    },
    notifyTitleChanged: () => {
      void handleListSessions(ws);
    },
    notifyConfigChanged: () => {
      ws.send(
        JSON.stringify({
          type: "session_model",
          sessionId,
          model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
          thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
        }),
      );
    },
  };
  const r = await executeAcpBuiltinSlashCommand(trimmed, runtime);
  if (r === false) return text; // 不是 builtin → 原样走 prompt（文件/自定义/扩展命令由底座展开）
  if ("prompt" in r) return r.prompt; // /force <tool> <prompt> 之类：剩余文本当 prompt
  ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
  return null;
}

async function handlePrompt(
  ws: { send(data: string): unknown },
  sessionId: string,
  text: string,
  files?: PromptAttachment[],
  steer = false,
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
  // 斜杠命令本地分发：消费则直接返回（不推 transcript、不调 prompt）；改写则继续
  const dispatched = await dispatchSlashInput(ws, sessionId, entry, finalText);
  if (dispatched === null) return;
  finalText = dispatched;
  entry.transcript.push({ role: "user", text: finalText });
  // 命令立即返回；turn 产物全部走事件流。流式中的注入行为由 streamingBehavior 决定：
  // followUp = 排队（当前 loop 完全处理完后自动消费触发新 turn，不打断进行中的处理）；
  // steer = 立即注入（当前工具批次后插入，气泡转正并分割过程）。idle 时两者都被底座忽略照常开 turn。
  entry.session
    .prompt(finalText, {
      ...(images.length > 0 ? { images } : {}),
      streamingBehavior: steer ? "steer" : "followUp",
    })
    .then((agentInvoked: boolean) => {
      if (agentInvoked === false) {
        // 扩展/自定义/文件命令被底座本地消费：撤回乐观气泡与 transcript 条目
        // （该 user 消息必是尾部最后一条同文本且尚无 entryId 的）
        const i = entry.transcript.findLastIndex((t) => t.role === "user" && t.text === finalText && !t.entryId);
        if (i >= 0) entry.transcript.splice(i, 1);
        ws.send(JSON.stringify({ type: "command_result", sessionId, text: finalText, consumed: true }));
      }
      // 流式排队后立即修剪：底座队列只留最早 1 条，其余进 parked（本轮 run 的注入边界
      // 只能带走这 1 条，避免多条拼车；后续逐轮 agent_end 放回消费）
      parkFollowUpTail(entry);
      sendQueued(ws, sessionId, entry);
    }) // 入队/开 turn 后校准前端排队行
    .catch((err: unknown) => {
      ws.send(JSON.stringify(stampEvent({ type: "error", sessionId, message: String(err) })));
    });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}

// ---------- 排队消息 RPC ----------
// 队列语义（仿 ZCode）：流式中发送的消息默认排队（followUp，当前 loop 完全处理完
// 后自动消费第 1 条触发新 prompt）；「立即发送」把某条转为 steer（当前工具批次后注入）。
// 索引一律指「用户消息」在对应队列过滤序列中的下标（跳过系统 notice，与 queued 帧一致）；
// followUp 的索引基于完整视图 = 底座 followUp 队列 + parked 暂存区（顺序拼接）。
//
// 底座注入边界（工具批次后 / yield 边界）会把 followUp 队列 drain 到排空，多条排队会被
// 同一轮 run 拼车发出（实测一次模型回复同时答复多条）。因此 host 维持不变式：底座
// followUp 队列最多留 1 条用户消息（下一个待消费的），其余暂存 parkedFollowUp；每轮
// agent_end 放回 1 条并触发消费——排队消息逐轮 FIFO，每轮一条独立 turn。

function sendQueued(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const agent = entry.session.agent;
  const view = (list: readonly any[]) =>
    list.filter((m) => isUserQueuedMessage(m)).map((m) => toRestoredQueuedMessage(m));
  const followUp = [...view(agent.peekFollowUpQueue()), ...view(entry.parkedFollowUp)];
  const steering = view(agent.peekSteeringQueue());
  // 竞态兜底的快照：完整视图 + steering 用户消息全量（turn_end 时 diff「上次有/现在无/未通知消费」= 被吞）
  entry.queuedTexts = [...followUp, ...steering].map((m) => m.text);
  ws.send(JSON.stringify(stampEvent({ type: "queued", sessionId, followUp, steering })));
}

// 把底座 followUp 队列修剪为最多 1 条用户消息：第 2 条起（含各自前导隐藏伴随）移入
// parked 暂存，防止当前 run 的注入边界把整队消息一次性带走
function parkFollowUpTail(entry: PoolEntry) {
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  let n = 0;
  let cut = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === 2) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return;
  let start = cut;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  entry.parkedFollowUp.push(...queue.filter((_, i) => i >= start));
  agent.replaceQueues(agent.peekSteeringQueue(), queue.filter((_, i) => i < start));
}

// 从 parked 暂存摘出第 pi 条用户消息（含前导隐藏伴随），返回摘出的元素数组
function extractParkedAt(entry: PoolEntry, pi: number): any[] {
  const parked = entry.parkedFollowUp;
  let n = -1;
  let target = -1;
  for (let i = 0; i < parked.length; i++) {
    if (!isUserQueuedMessage(parked[i])) continue;
    if (++n === pi) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`暂存排队消息不存在: ${pi}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(parked[start - 1])) start--;
  const extracted = parked.slice(start, target + 1);
  entry.parkedFollowUp = parked.filter((_, i) => i < start || i > target);
  return extracted;
}

// 放回 parked 首条（含前导伴随）到 agent 队列。队列元素是入队时的原结构，直接回队即保留图片等
function releaseOneParked(entry: PoolEntry): any[] {
  const u = entry.parkedFollowUp.findIndex((m) => isUserQueuedMessage(m));
  if (u < 0) return [];
  const released = entry.parkedFollowUp.slice(0, u + 1);
  entry.parkedFollowUp = entry.parkedFollowUp.slice(u + 1);
  return released;
}

function handlePeekQueued(ws: { send(data: string): unknown }, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  sendQueued(ws, sessionId, entry);
}

// 移除第 index 条用户消息及其紧邻在前的隐藏伴随（图片描述等），返回过滤后的新数组
function removeUserMessage(queue: readonly any[], index: number): any[] {
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`排队消息不存在: ${index}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  return queue.filter((_, i) => i < start || i > target);
}

function handleDropQueued(
  ws: { send(data: string): unknown },
  sessionId: string,
  which: "followUp" | "steering",
  index?: number,
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = which === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
  let next: any[];
  if (index === undefined) {
    // 全清：只清用户消息及其隐藏伴随，保留系统 notice（goal/plan/budget 等）
    next = queue.filter((m) => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m));
    if (which === "followUp") entry.parkedFollowUp = [];
  } else if (which === "followUp" && index >= queue.filter((m) => isUserQueuedMessage(m)).length) {
    // 完整视图后半段：目标在 parked 暂存
    extractParkedAt(entry, index - queue.filter((m) => isUserQueuedMessage(m)).length);
    next = queue;
  } else {
    next = removeUserMessage(queue, index);
  }
  agent.replaceQueues(
    which === "steering" ? next : agent.peekSteeringQueue(),
    which === "steering" ? agent.peekFollowUpQueue() : next,
  );
  sendQueued(ws, sessionId, entry);
}

// 立即发送：把 followUp 第 index 条（完整视图，含 parked 暂存）转为 steer 注入；
// 剩余排队消息全部 park，本轮 run 只注入被点的这一条
async function handleSendNow(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  const queueUserCount = queue.filter((m) => isUserQueuedMessage(m)).length;
  let restored;
  if (index < queueUserCount) {
    let n = -1;
    let target = -1;
    for (let i = 0; i < queue.length; i++) {
      if (!isUserQueuedMessage(queue[i])) continue;
      if (++n === index) {
        target = i;
        break;
      }
    }
    if (target < 0) throw new Error(`排队消息不存在: ${index}`);
    restored = toRestoredQueuedMessage(queue[target]);
    agent.replaceQueues(agent.peekSteeringQueue(), removeUserMessage(queue, index));
  } else {
    // 目标在 parked 暂存：摘出后经 steer 重新入队（图片经 SDK 重建描述，罕见路径）
    const [msg] = extractParkedAt(entry, index - queueUserCount).filter((m) => isUserQueuedMessage(m));
    restored = toRestoredQueuedMessage(msg);
  }
  await entry.session.steer(restored.text, restored.images);
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
}

// 放回队列：把 steer 队列第 index 条挪回 followUp 顶端（去掉 steer 标记）
function handleRequeue(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = agent.peekSteeringQueue();
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`steer 消息不存在: ${index}`);
  const moved: any = { ...queue[target] };
  delete moved.steering;
  agent.replaceQueues(removeUserMessage(queue, index), [moved, ...agent.peekFollowUpQueue()]);
  // moved 成为底座队列唯一第 1 条，原队列首条退入 parked 头部（保持 FIFO 顺序）
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
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
// 此后每 5 分钟按账号全量重拉;缓存 TTL 同为 5min,前台 hover/切页永远命中缓存,
// 对供应商的实际请求频率严格等于本节奏。
const LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
function configuredLimitProviders() {
  const seen = new Map<string, string>();
  for (const m of H.availableModels) {
    if (seen.has(m.provider)) continue;
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(m.provider) ?? "";
    } catch {}
    seen.set(m.provider, baseUrl);
  }
  return [...seen].map(([id, baseUrl]) => ({ id, baseUrl }));
}
const runLimitsRefresh = () => {
  const providers = configuredLimitProviders();
  void refreshAllLimits(H.authStorage, providers).then(() => {
    process.stderr.write(`[host] 配额预载/刷新完成: ${providers.length} 个供应商\n`);
  });
};
runLimitsRefresh();
setInterval(runLimitsRefresh, LIMITS_REFRESH_INTERVAL_MS);

// ---------- 宿主池外部写入检测 ----------
// 池内会话 = desktop 正持有内存态的全集（宿主池无上限，前端 OPEN_SESSIONS_MAX 只管 UI LRU）。
// 锁文件无信号（.lock.os 是 advisory 残留、publish 持有窗口 <500ms），唯一可靠信号 =
// 文件被本进程之外的进程追加：从 pollKnownSize 起读新增完整行，行内 id 不在 manager
// 内存索引里 = 外部写入（CLI 对话/改名/压缩都会落新条目）。自己写入的 id 必先进过内存，零误报。
const POLL_EXTERNAL_WRITES_MS = 2000;
async function pollExternalWrites() {
  for (const [sessionId, entry] of sessions.entries()) {
    try {
      const st = await stat(entry.path);
      if (st.size === entry.pollKnownSize) continue;
      if (st.size < entry.pollKnownSize) entry.pollKnownSize = 0; // 全量重写：从头再扫
      const fh = await open(entry.path, "r");
      let data: Buffer;
      try {
        data = Buffer.alloc(st.size - entry.pollKnownSize);
        const { bytesRead } = await fh.read(data, 0, data.length, entry.pollKnownSize);
        data = data.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      // 只消费到最后一个完整行（半行留待下次，避免读到写一半的 JSON）
      let lineEnd = -1;
      for (let i = 0; i < data.length; i++) if (data[i] === 10) lineEnd = i;
      if (lineEnd < 0) continue;
      const newIds: string[] = [];
      let lineStart = 0;
      while (lineStart <= lineEnd) {
        const nl = data.indexOf(10, lineStart);
        const line = data.subarray(lineStart, nl).toString("utf8");
        lineStart = nl + 1;
        if (line.trim()) {
          try {
            const o = JSON.parse(line) as { id?: unknown; type?: unknown };
            // 文件书架行不参与判定：header（type "session"，带 sessionId 形状的 id 但
            // getEntries 明确不含 header）与 title slot 行；只有真条目比对内存索引
            if (typeof o.id === "string" && o.type !== "session") newIds.push(o.id);
          } catch {
            // 完整但损坏的行：跳过
          }
        }
      }
      entry.pollKnownSize += lineStart;
      if (entry.externalWrite || newIds.length === 0) continue;
      const known = new Set<string>(entry.manager.getEntries().map((e: { id?: string }) => e?.id));
      if (!newIds.some((id) => !known.has(id))) continue;
      entry.externalWrite = true;
      const ws = entry.attachedWs as { send(data: string): unknown } | null;
      ws?.send(JSON.stringify({ type: "session_external_write", sessionId }));
    } catch (err) {
      // 新会话文件是懒落盘（首条条目才创建）：ENOENT = 尚无可监测对象，静默跳过
      if ((err as { code?: string }).code === "ENOENT") continue;
      process.stderr.write(`[host] 外部写入轮询失败 ${entry.path}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
setInterval(() => { void pollExternalWrites(); }, POLL_EXTERNAL_WRITES_MS);
