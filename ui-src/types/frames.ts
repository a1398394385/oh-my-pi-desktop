// WS 帧判别联合(host → UI 方向,镜像发送端构造)。
// 权威来源:host/host.ts 与 host/*.ts 中全部 ws.send/广播帧构造点,逐帧镜像为 `type` 字面量判别联合;
// 字段以发送端实际构造为准,可选性忠实反映(有的地方可能缺字段)。
// 事件流位置标识(host/host.ts:659-662):hi = host 进程实例 ID,seq = 全局单调递增事件序号;
// 仅 stampEvent 帧带 hi/seq(成员注释标注「盖戳」),RPC 请求-响应帧与握手帧不盖戳。

/** stampEvent 盖戳(host/host.ts:660-662):事件流帧携带的进程实例 ID 与单调序号 */
export interface EventStamp {
  hi: string;
  seq: number;
}

// ---------- 通用负载形状 ----------

/** 审批模式(host/host.ts:1519-1523 校验三值) */
export type ApprovalMode = "yolo" | "write" | "always-ask";

/** 桌面 env 段(host/state.ts:51 DesktopEnv) */
export interface DesktopEnv {
  httpProxy: string;
  noProxy: string;
  caCerts: string;
}

/** 设置快照(host/models.ts:82-93 settingsSnapshot) */
export interface SettingsSnapshot {
  hideThinkingBlock: boolean;
  computerEnabled: boolean;
  // TODO(收口核对): H.settings.get 返回类型随底座,store 侧按字符串用(S.approvalMode)
  approvalMode: string;
  desktopEnv: DesktopEnv;
  activeProfile: string;
  availableProfiles: string[];
  profileAgentDir: string;
  values: Record<string, unknown>;
  conditions: Record<string, boolean>;
}

/** settings 帧负载 = 底座快照 + host 侧实验开关(host/host.ts:213-216 settingsFrame) */
export type SettingsPayload = SettingsSnapshot & {
  acpEnabled: boolean;
  sessionContextEnabled: boolean;
};

/** 模型目录条目(host/models.ts:17-23 modelsPayload) */
export interface ModelEntry {
  id: string; // "provider/model"
  name: string;
  // TODO(收口核对): getSupportedEfforts 返回类型随底座 SDK(档位 id 列表或 null)
  efforts: string[] | null;
}

/** 新建会话配置默认(host/models.ts:157-164 modelsDefaults) */
export interface ModelsDefaults {
  defaultModel: string | null;
  defaultThinking: string | null;
}

/** 模型目录(模型管理页视图)条目(host/models.ts:133-154 modelCatalog) */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  context: number | null;
  vision: boolean;
  efforts: string[] | null; // 同 ModelEntry.efforts 的 TODO
  authSource: "config" | "cred";
}

/** 模型角色条目(host/models.ts:168-181 modelRolesPayload) */
export interface ModelRoleEntry {
  id: string;
  name: string;
  tag: string | null;
  value: string | null;
  resolved: string | null;
  resolvedName: string | null;
}

/** 供应商清单条目(host/host.ts:1661-1684:listAllProviders 的 {id,label} + login/accounts) */
export interface AllProviderEntry {
  id: string;
  label: string;
  login: boolean; // 有真实授权流(oauth-code/device-code/custom)
  accounts: number; // authStorage 活跃凭证数
}

/** 斜杠命令条目(host/host.ts:305-320 sendCommandsFrame) */
export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  hint: string | null;
  // TODO(收口核对): source 取自底座 InternalAvailableSlashCommand.source(builtin/extension/custom/skill 等)
  source: string;
  subcommands: { name: string; description: string }[];
}

/** @ 文件候选(host/host.ts:342-367 listFileMatches) */
export interface FileMatch {
  path: string;
  dir: boolean;
}

/** 目录单层条目(host/host.ts:1166-1173 list_dir) */
export interface DirEntry {
  name: string;
  dir: boolean;
}

/** git status 行(host/host.ts:1471-1484 get_git_diff) */
export interface GitStatusFile {
  code: string; // XY 两列(去空白,"?" 兜底)
  path: string;
  staged: string; // 空串 = 无
  unstaged: string; // 空串 = 无
}

/** 跨文件分支家族节点(host/host.ts:965-979 get_session_tree) */
export interface SessionBranch {
  sessionId: string;
  path: string;
  title: string | null;
  modified: string; // ISO
  parentSession: string | null;
  isCurrent: boolean;
  messageCount: number;
}

/** 磁盘会话行(host/host.ts:2637-2645 handleListSessions 的 sessions 映射) */
export interface DiskSessionRow {
  id: string;
  path: string;
  title: string | null;
  firstMessage: string; // 截 80 字
  modified: string; // ISO
  messageCount: number;
  archived: boolean;
}

/** 项目分组(host/host.ts:2628-2646 handleListSessions 的 projects 映射) */
export interface DiskProject {
  cwd: string;
  sessions: DiskSessionRow[];
}

/** 条目树节点(host/translate.ts:738-749 EntryTreeNode) */
export interface EntryTreeNode {
  id: string;
  kind: string; // entry.type
  role?: string; // message 角色(message 条目才有)
  text: string;
  label?: string;
  ts?: string;
  userReq?: boolean;
  emptyAssistant?: boolean;
  isSettings?: boolean;
  children: EntryTreeNode[];
}

/** 配额窗口段(host/limits/index.ts:12-20 LimitWindow) */
export interface LimitWindow {
  kind: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  resetDescription?: string;
}

/** 余额段(host/limits/index.ts:22-25 LimitBalance) */
export interface LimitBalance {
  amount: number | null;
  currency?: string;
}

/** 多账号配额条目(host/host.ts:1377-1384 provider_limits_result.accounts 映射) */
export interface LimitsAccount {
  id: string;
  label: string;
  status: string;
  planLabel: string;
  accountLabel: string;
  balance: LimitBalance | null;
  windows: LimitWindow[];
  updatedAt: string | null;
}

/** 使用统计(host/stats.ts:74-86 collectUsageStats) */
export interface UsageStats {
  totalTokens: number;
  peakTokens: number;
  longestMs: number;
  sessionCount: number;
  currentStreak: number;
  longestStreak: number;
  byDay: Record<string, number>;
  byModel: Record<string, number>;
  heat: Record<string, number>;
}

/** 目标状态(goal 帧内层,host/host.ts:391-401 pushGoal) */
export interface GoalState {
  objective: string;
  // TODO(收口核对): goal.status 枚举值随底座 GoalController(active/paused/done 等)
  status: string;
  enabled: boolean;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  costUsed: number;
}

/** 待办任务状态(node_modules/@oh-my-pi/pi-tui/dist/types/tools/todo.d.ts:5 TodoStatus) */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** 待办任务(todo.d.ts:9-16 TodoItem) */
export interface TodoTask {
  content: string;
  status: TodoStatus;
  blocker?: string; // status==="blocked" 时的等待原因
  details?: string;
  notes?: string[];
}

/** 待办阶段(todo.d.ts:18-21 TodoPhase;host 各 todos 帧的 phases 元素) */
export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

/** 本轮 LLM token 用量(host/state.ts:8 TurnUsage) */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 会话条目线上形状(host/state.ts:9-40 TranscriptItem;messages 帧元素) */
export type TranscriptItem = {
  role: "user" | "assistant" | "tool" | "thinking" | "loop" | "bash" | "mention" | "phase";
  text: string;
  name?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  files?: string[];
  added?: number;
  removed?: number;
  diffContent?: string;
  todo?: { content: string; done: number; total: number };
  thinking?: string;
  expandable?: boolean;
  output?: string;
  // TODO(收口核对): details 为 read/hub 等工具的运行态元数据(read 行读 details.isDirectory),形状随底座
  details?: unknown;
  collapsed?: boolean;
  items?: TranscriptItem[];
  durationSec?: number | null;
  usage?: TurnUsage | null;
  entryId?: string;
  endMs?: number;
  // ---- bash 行 ----
  running?: boolean;
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean;
  error?: string;
  // ---- phase 行 ----
  phase?: "start" | "done";
  command?: string;
};

/** 排队消息视图元素(host/host.ts:2888-2890 sendQueued,经底座 toRestoredQueuedMessage) */
// TODO(收口核对): toRestoredQueuedMessage 返回形状随底座 SDK(至少含 text;store 侧用 text/images)
export interface QueuedMessage {
  text: string;
  images?: unknown[];
}

/** 事件流窄事件(host/translate.ts:10-19 UiEvent;event/subagent_event 帧的 kind 判别体) */
export type UiEvent =
  | { kind: "turn_start" }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking"; phase: "start" | "end"; durationLabel?: string; thinking?: string; expandable?: boolean }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool"; name: string; toolCallId?: string; args?: Record<string, unknown>; files?: string[]; intent?: string }
  | {
      kind: "tool_update";
      name: string;
      toolCallId?: string;
      files?: string[];
      added?: number;
      removed?: number;
      todo?: TranscriptItem["todo"];
      output?: string;
      details?: unknown;
      diffContent?: string;
    }
  | { kind: "turn_end"; usage?: TurnUsage | null; userEntryId?: string; assistantEntryId?: string; runEnd?: boolean }
  | { kind: "thinking_level"; configured?: string; resolved?: string }
  | { kind: "mention"; files: string[] };

/** 整会话统计(session_stats 帧展开字段,host/host.ts:2160-2176 buildSessionStats) */
export interface SessionStatsPayload {
  // TODO(收口核对): st.tokens 为底座 getSessionStats 的分桶对象(input/output/cacheRead/cacheWrite),随 SDK
  tokens: Record<string, number>;
  cost: number;
  cacheHitRate: number;
  advisorCost: number;
  activeMs: number;
}

/** 上下文明细 breakdown(context_detail 帧,host/host.ts:1283-1301 + estimateMcpToolsTokens) */
// TODO(收口核对): breakdown 为底座 getContextBreakdown() 展开 + mcpToolsTokens,分桶形状随 SDK
export type ContextBreakdown = Record<string, unknown> & { mcpToolsTokens: number };

/** context_detail 帧内层 stats(host/host.ts:1291-1300) */
export interface ContextDetailStats {
  // TODO(收口核对): tokens 为底座 getSessionStats().tokens 分桶对象,随 SDK
  tokens: Record<string, number>;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  premiumRequests: number;
  cost: number;
}

/** agent_assets 帧负载(host/assets.ts:636-698 listAgentAssets;各段元素为磁盘扫描原样形状) */
// TODO(收口核对): skills 段逐字段形状由 assets.ts 内部扫描决定,暂 unknown(McpPage/SkillsPage 按实际读取收窄)
/** MCP 资产负载(host/assets.ts:605-630;servers 元素即 host McpServerItem,scopes 为作用域分组) */
export interface McpAssetsPayload {
  servers: {
    name: string;
    transport: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    cwd?: string;
    enabled: boolean;
    source: { provider: string; providerName: string; path: string; level: "user" | "project" | "native" };
    scope: string; // "profile" | `project:${cwd}`
    projectName?: string;
    status: "connected" | "error" | "disabled" | "unknown";
    error?: string;
  }[];
  scopes: { id: string; name: string; count: number; dir?: string; cwd?: string }[];
  userMcpPath: string;
  global: { path: string; servers: { name: string; command: string }[] };
  profile: { path: string; servers: { name: string; command: string }[] };
  projects: { cwd: string; name: string; path: string; servers: { name: string; command: string }[] }[];
}

export interface AgentAssetsPayload {
  memories: { name: string; path: string; project?: string }[];
  skills: unknown;
  commands: { name: string; path: string }[];
  agents: {
    global: { name: string; path: string; description: string }[];
    profile: { name: string; path: string; description: string }[];
    projects: { cwd: string; name: string; dir: string; agents?: { name: string; path: string; description: string }[] }[];
    globalDir: string;
    profileDir: string;
    profileName?: string;
  };
  hooks: { name: string; path: string; phase: string }[];
  mcp: McpAssetsPayload;
  plugins: { name: string }[];
  flags: { enableMCP: boolean; disableExtensionDiscovery: boolean; computerEnabled: boolean };
}

/** 资产类型(host/assets.ts:56 AssetKind) */
export type AssetKind = "agent" | "skill" | "mcp";

/** prompt 附件(UI → host 方向;host/host.ts:2666-2672 PromptAttachment,UI 随 prompt 下发) */
export interface PromptAttachment {
  kind: "image" | "text";
  mime?: string; // image:base64(无 data: 前缀)
  name?: string; // text:文件名
  text?: string; // text:文件内容
  data?: string;
}

// ---------- 帧成员(逐个镜像发送端构造点) ----------

/** 握手帧(host/host.ts:674-684 open;不盖戳,hi 直挂) */
export interface ReadyFrame {
  type: "ready";
  hi: string;
  approvalMode: string;
  models: ModelEntry[];
  defaultModel: string | null;
  defaultThinking: string | null;
  settings: SettingsPayload;
}

/** 错误帧(host/host.ts:690 非法 JSON / 2098 未知命令 / 2102 RPC 失败 / 1222-1227 bash 忙;
    2235/2861 事件流错误盖戳) */
export interface ErrorFrame {
  type: "error";
  message: string;
  sessionId?: string | null; // 2102 处显式可 null;1222 处必有值
  kind?: string | null; // 仅 2102(RPC 失败回包)携带
  hi?: string; // 盖戳变体(2235/2861)
  seq?: number;
}

/** 命令清单帧(host/host.ts:305-320 sendCommandsFrame) */
export interface CommandsFrame {
  type: "commands";
  sessionId: string | null;
  commands: SlashCommand[];
}

/** 命令输出帧(host/host.ts:380 pushCommandOutput / 2702 / 2752 / 2777 / 2782) */
export interface CommandOutputFrame {
  type: "command_output";
  sessionId: string;
  text: string;
}

/** 命令消费结果帧(host/host.ts:2703 / 2713 / 2719 / 2802 / 2853) */
export interface CommandResultFrame {
  type: "command_result";
  sessionId: string;
  text: string;
  consumed: boolean; // 恒 true(发送端字面量)
}

/** 后台耗时命令阶段分隔帧(host/host.ts:2760 start / 2776 / 2781 fail) */
export interface CommandPhaseFrame {
  type: "command_phase";
  sessionId: string;
  phase: "start" | "fail";
  command: string; // compact/handoff/rename
  text?: string; // 仅 start 携带(PHASE_TEXT[command][0])
}

/** goal 状态帧(host/host.ts:389-402 pushGoal) */
export interface GoalFrame {
  type: "goal";
  sessionId: string;
  goal: GoalState | null;
}

/** 待办清单帧(host/host.ts:413 pushTodos 盖戳 / 1275 get_todos 无戳 / 2187 盖戳) */
export interface TodosFrame {
  type: "todos";
  sessionId: string;
  phases: TodoPhase[];
  hi?: string; // 盖戳变体
  seq?: number;
}

/** 计划模式状态帧(host/host.ts:420-426 pushPlanMode) */
export interface PlanModeFrame {
  type: "plan_mode";
  sessionId: string;
  enabled: boolean;
  planFilePath: string | null;
}

/** 会话已创建/复用快照帧(host/host.ts:2513-2524 / 2540-2551 / 2573-2584 session_created) */
export interface SessionCreatedFrame {
  type: "session_created";
  sessionId: string;
  path: string;
  cwd: string;
  model: string | null;
  thinking: string;
  isGit: boolean;
}

/** 会话列表帧(host/host.ts:2645-2656 handleListSessions) */
export interface SessionListFrame {
  type: "session_list";
  projects: DiskProject[];
  allProjects: string[];
  removedProjects: string[];
  expandedProjects: string[];
  pinnedSessions: string[];
}

/** 全量消息快照帧(host/host.ts:873 / 912 / 1031 / 2552 / 2586 / 2768 / 2868) */
export interface MessagesFrame {
  type: "messages";
  sessionId: string;
  messages: TranscriptItem[];
}

/** 会话归档回包(host/host.ts:800) */
export interface SessionArchivedFrame {
  type: "session_archived";
  sessionId: string;
  ok: boolean; // 恒 true
  archived: boolean;
}

/** 会话中断回包(host/host.ts:831) */
export interface SessionAbortedFrame {
  type: "session_aborted";
  sessionId: string;
  ok: boolean; // 恒 true
}

/** 会话重命名回包(host/host.ts:854) */
export interface SessionRenamedFrame {
  type: "session_renamed";
  sessionId: string;
  ok: boolean; // 恒 true
  title: string;
}

/** 手动压缩回包(host/host.ts:865 空会话 / 874 成功 / 876 失败) */
export interface SessionCompactedFrame {
  type: "session_compacted";
  sessionId: string;
  ok?: boolean; // 仅成功携带
  error?: string; // 仅失败携带
}

/** 会话分叉回包(host/host.ts:895 取消 / 913-921 成功 / 926 失败) */
export interface SessionBranchedFrame {
  type: "session_branched";
  sessionId: string;
  ok: boolean;
  newSessionId?: string; // 仅成功
  newPath?: string; // 仅成功
  // TODO(收口核对): selectedImages 为分叉 user 消息的附件数组,元素形状随底座
  selectedText?: string; // 仅成功
  selectedImages?: unknown[]; // 仅成功
  error?: string; // 仅失败
}

/** 跨文件分支家族树回包(host/host.ts:940 失败 / 965-979 成功) */
export interface SessionTreeFrame {
  type: "session_tree";
  sessionId: string;
  ok: boolean;
  branches?: SessionBranch[]; // 仅成功
  error?: string; // 仅失败
}

/** 会话内条目树回包(host/host.ts:990-997 get_entry_tree;ok 恒 true,失败走 error 帧) */
export interface EntryTreeFrame {
  type: "entry_tree";
  sessionId: string;
  ok: boolean; // 恒 true
  leafId: string | null;
  roots: EntryTreeNode[];
}

/** 树内导航回包(host/host.ts:1015 / 1021 / 1025 失败 / 1032-1039 成功 / 1042 失败) */
export interface SessionNavigatedFrame {
  type: "session_navigated";
  sessionId: string;
  ok: boolean;
  editorText?: string | null; // 仅成功
  // TODO(收口核对): editorImages 为目标 user 消息的图片附件数组,元素形状随底座
  editorImages?: unknown[] | null; // 仅成功
  error?: string; // 仅失败
}

/** 外部写入提示帧(host/host.ts:2556 池复用补发 / 3142 pollExternalWrites 检出) */
export interface SessionExternalWriteFrame {
  type: "session_external_write";
  sessionId: string;
}

/** 单文件 diff 回包(host/host.ts:1100-1107 get_file_diff) */
export interface FileDiffFrame {
  type: "file_diff";
  cwd: string;
  path: string;
  diff: string; // 截 500KB
}

/** 文件内容回包(host/host.ts:1117 过大 / 1123 二进制 / 1126 成功) */
export interface FileContentFrame {
  type: "file_content";
  path: string;
  text?: string; // 仅成功
  error?: string; // 仅失败
}

/** 图片内容回包(host/host.ts:1145 格式 / 1150 非文件 / 1154 过大 / 1158 成功) */
export interface ImageContentFrame {
  type: "image_content";
  path: string;
  mime?: string; // 仅成功
  data?: string; // 仅成功,base64
  error?: string; // 仅失败
}

/** 目录单层列表回包(host/host.ts:1173 list_dir) */
export interface DirListFrame {
  type: "dir_list";
  path: string;
  entries: DirEntry[];
}

/** @ 文件候选回包(host/host.ts:1193-1199 list_files;reqId 原样回传) */
export interface FileMatchesFrame {
  type: "file_matches";
  reqId: number;
  matches: FileMatch[];
}

/** ! 本地命令开始帧(host/host.ts:1222 bash_exec) */
export interface BashStartFrame {
  type: "bash_start";
  sessionId: string;
  command: string;
  excludeFromContext: boolean;
}

/** ! 本地命令输出流帧(host/host.ts:1226 bash_chunk) */
export interface BashChunkFrame {
  type: "bash_chunk";
  sessionId: string;
  chunk: string;
}

/** ! 本地命令结束帧(host/host.ts:1241-1251 成功 / 1255-1260 失败 / 1269 bash_abort) */
export interface BashDoneFrame {
  type: "bash_done";
  sessionId: string;
  exitCode?: number | null; // 仅成功
  cancelled?: boolean; // 成功(底座回报)或 bash_abort 恒 true
  timedOut?: boolean; // 仅成功
  truncated?: boolean; // 仅成功
  output?: string; // 仅成功
  error?: string; // 仅失败
}

/** 上下文明细回包(host/host.ts:1283-1301 get_context_detail) */
export interface ContextDetailFrame {
  type: "context_detail";
  sessionId: string;
  breakdown: ContextBreakdown | null;
  stats: ContextDetailStats;
}

/** 会话配额回包(host/host.ts:1335-1351 get_limits) */
export interface LimitsResultFrame {
  type: "limits_result";
  sessionId: string;
  label: string;
  unsupported: boolean;
  status: string;
  planLabel: string;
  accountLabel: string;
  balance: LimitBalance | null;
  windows: LimitWindow[];
  updatedAt: string | null;
}

/** 供应商配额回包(host/host.ts:1363-1386 get_provider_limits) */
export interface ProviderLimitsResultFrame {
  type: "provider_limits_result";
  provider: string;
  label: string;
  unsupported: boolean;
  status: string; // 顶层取首个账号
  planLabel: string;
  accountLabel: string;
  balance: LimitBalance | null;
  windows: LimitWindow[];
  updatedAt: string | null;
  accounts: LimitsAccount[];
}

/** 暂存回包(host/host.ts:1396-1397 git_stage) */
export interface GitStagedFrame {
  type: "git_staged";
  cwd: string;
  ok?: boolean; // 恒 true(成功时)
  error?: string; // 仅失败
}

/** 取消暂存回包(host/host.ts:1406-1407 git_unstage) */
export interface GitUnstagedFrame {
  type: "git_unstaged";
  cwd: string;
  ok?: boolean;
  error?: string;
}

/** 丢弃改动回包(host/host.ts:1425-1426 git_discard) */
export interface GitDiscardedFrame {
  type: "git_discarded";
  cwd: string;
  ok?: boolean;
  error?: string;
}

/** 提交回包(host/host.ts:1439 / 1444 失败 / 1447 成功) */
export interface GitCommittedFrame {
  type: "git_committed";
  cwd: string;
  ok?: boolean;
  commit?: string; // 仅成功,新提交 sha
  error?: string; // 仅失败
}

/** 推送回包(host/host.ts:1454 失败 / 1457 成功) */
export interface GitPushedFrame {
  type: "git_pushed";
  cwd: string;
  ok?: boolean;
  result?: string; // 仅成功(stderr 或 stdout 去空白)
  error?: string; // 仅失败
}

/** 改动文件清单回包(host/host.ts:1484 get_git_diff) */
export interface GitStatusFrame {
  type: "git_status";
  cwd: string;
  files: GitStatusFile[];
}

/** 分支清单回包(host/host.ts:1491 非 git / 1502 正常) */
export interface GitBranchesFrame {
  type: "git_branches";
  cwd: string;
  isGit: boolean;
  current: string | null;
  branches: string[];
}

/** 切分支回包(host/host.ts:1513;失败走 error 帧) */
export interface GitBranchSwitchedFrame {
  type: "git_branch_switched";
  cwd: string;
  branch: string;
}

/** 审批模式回包(host/host.ts:1523 set_approval_mode) */
export interface ApprovalModeFrame {
  type: "approval_mode";
  mode: ApprovalMode;
}

/** 审批已决帧(host/host.ts:1537 approval_response) */
export interface ApprovalResolvedFrame {
  type: "approval_resolved";
  requestId: string;
}

/** 审批请求帧(host/host.ts:2136 select 盖戳 / 2278 confirm 盖戳 / 2301 editor 盖戳) */
export interface ApprovalRequestFrame {
  type: "approval_request";
  sessionId: string;
  requestId: string;
  title: string; // confirm 变体为 `${title}\n${message}`
  options: string[];
  editable?: boolean; // 仅 editor 变体恒 true
  prefill?: string; // 仅 editor 变体
  hi?: string; // 盖戳帧
  seq?: number;
}

/** 会话模型回包(host/host.ts:1553-1561 set_model / 2789-2797 notifyConfigChanged) */
export interface SessionModelFrame {
  type: "session_model";
  sessionId: string;
  model: string | null;
  thinking: string;
}

/** 会话思考级别回包(host/host.ts:1568 set_thinking) */
export interface SessionThinkingFrame {
  type: "session_thinking";
  sessionId: string;
  level: string;
}

/** 设置帧(host/host.ts:1579 / 1590 / 1628 / 1635 / 1641 / 2052;1654 带 restartHint) */
export interface SettingsFrame {
  type: "settings";
  settings: SettingsPayload;
  restartHint?: boolean; // 仅 set_desktop_env 回包恒 true
}

/** 设置 schema 帧(host/host.ts:1582 get_settings_schema) */
export interface SettingsSchemaFrame {
  type: "settings_schema";
  // TODO(收口核对): SETTINGS_SCHEMA 条目形状随底座 config/settings(type/default/values 等)
  schema: Record<string, unknown>;
}

/** 模型目录帧(host/host.ts:80-82 modelsFrame,多个发送点;登录流程经 reply 带 reqId) */
export interface ModelsFrame {
  type: "models";
  models: ModelEntry[];
  defaultModel: string | null;
  defaultThinking: string | null;
  reqId?: number | null; // 仅 provider_login 的 reply 包装携带
}

/** 模型管理页目录帧(host/host.ts:1658 等多个发送点;登录流程经 reply 带 reqId) */
export interface ModelsCatalogFrame {
  type: "models_catalog";
  models: ModelCatalogEntry[];
  reqId?: number | null; // 仅 provider_login 的 reply 包装携带
}

/** 供应商清单帧(host/host.ts:1661-1684 get_all_providers) */
export interface AllProvidersFrame {
  type: "all_providers";
  providers: AllProviderEntry[];
}

/** 登录进度帧(host/host.ts:1696 / 1710 onAuth / 1716 onProgress;reply 包装恒带 reqId) */
export interface LoginProgressFrame {
  type: "login_progress";
  reqId: number | null;
  provider: string;
  message: string;
  url?: string; // 仅 onAuth 变体
}

/** 登录粘贴码弹窗帧(host/host.ts:1729 onPrompt;reply 包装恒带 reqId) */
export interface LoginPromptFrame {
  type: "login_prompt";
  reqId: number | null;
  provider: string;
  id: number; // promptSeq,login_prompt_reply 回传键
  message: string;
  secret: boolean;
}

/** 登录结束帧(host/host.ts:1738 成功 / 1742-1748 失败;reply 包装恒带 reqId) */
export interface LoginDoneFrame {
  type: "login_done";
  reqId: number | null;
  provider: string;
  ok: boolean;
  identity?: unknown | null; // 仅成功(底座登录身份对象)
  cancelled?: boolean; // 仅失败
  message?: string; // 仅失败
}

/** API key 配置完成帧(host/host.ts:1794 provider_set_key) */
export interface ProviderKeyDoneFrame {
  type: "provider_key_done";
  provider: string;
  ok: boolean; // 恒 true
}

/** models.yml 路径帧(host/host.ts:1812 open_models_config) */
export interface ModelsConfigPathFrame {
  type: "models_config_path";
  path: string;
}

/** 模型角色帧(host/host.ts:1848 get_model_roles / 1861 set_model_role) */
export interface ModelRolesFrame {
  type: "model_roles";
  roles: ModelRoleEntry[];
}

/** 使用统计帧(host/host.ts:1865 get_usage_stats) */
export interface UsageStatsFrame {
  type: "usage_stats";
  stats: UsageStats;
}

/** 资产清单帧(host/host.ts:1868 等多个发送点) */
export interface AgentAssetsFrame {
  type: "agent_assets";
  assets: AgentAssetsPayload;
}

/** 扩展中心条目来源元数据(host/extensions.ts ExtSource，同底座 SourceMeta 子集) */
export interface ExtSource {
  provider: string;
  providerName: string;
  level: "user" | "project" | "native";
}

/** 扩展中心条目详情预计算（规则解析/工具文件头/命令预览，host 下发直接渲染） */
export interface ExtensionDetail {
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  agents?: string[];
  toolHeader?: string;
  body?: string;
  argumentHint?: string;
  usesArguments?: boolean;
}

/** 扩展中心统一条目（host/extensions.ts ExtensionItem；id 即底座 disabledExtensions 的 id 方案 kind:name） */
export interface ExtensionItem {
  id: string;
  kind: string;
  name: string;
  displayName: string;
  description?: string;
  trigger?: string;
  path: string;
  source: ExtSource;
  state: "active" | "disabled" | "shadowed";
  disabledReason?: string;
  shadowedBy?: string;
  raw?: Record<string, unknown>;
  detail?: ExtensionDetail;
}

/** 扩展中心数据帧(host/host.ts list_extensions 等四个 RPC 回包) */
export interface ExtensionsFrame {
  type: "extensions";
  scope: string; // profile | project:<cwd>
  scopes: { id: string; label: string }[];
  providers: {
    id: string;
    displayName: string;
    description: string;
    enabled: boolean;
    userSourceEnabled: boolean;
    foreignUserSource: boolean;
  }[];
  extensions: ExtensionItem[];
}

/** 资产文件内容回包(host/host.ts:1875 / 1928 / 1943 asset_file_read / asset_file_create) */
export interface AssetFileFrame {
  type: "asset_file";
  kind: AssetKind;
  path: string;
  content: string;
}

/** 资产文件已保存回包(host/host.ts:1913 asset_file_write) */
export interface AssetFileSavedFrame {
  type: "asset_file_saved";
  kind: AssetKind;
  path: string;
}

/** 资产文件已删除回包(host/host.ts:1978 asset_skill_delete) */
export interface AssetFileDeletedFrame {
  type: "asset_file_deleted";
  kind: "skill"; // 发送端字面量
  path: string;
}

/** 记忆文件回包(host/host.ts:1906 memory_file_read;files/rollouts 仅目录型记忆携带) */
export interface MemoryFileFrame {
  type: "memory_file";
  path: string;
  file: string; // 实际读取的文件 basename
  files?: string[];
  rollouts?: string[];
  content: string;
}

/** MCP 服务器探测回包(host/host.ts:2006 test_mcp_server) */
export interface McpServerTestedFrame {
  type: "mcp_server_tested";
  name: string;
  status: string;
  error?: string;
}

/** profile 切换完成帧(host/host.ts:2059 switch_profile) */
export interface ProfileSwitchedFrame {
  type: "profile_switched";
  profile: string;
}

/** 终端数据帧(host/host.ts:2073 terminal_create 的 onData 回调) */
export interface TerminalDataFrame {
  type: "terminal_data";
  id: string;
  data: string;
}

/** 终端退出帧(host/host.ts:2076 onExit 回调) */
export interface TerminalExitFrame {
  type: "terminal_exit";
  id: string;
  code: number;
}

/** 终端创建回包(host/host.ts:2079 terminal_create) */
export interface TerminalCreatedFrame {
  type: "terminal_created";
  id: string;
  shell: string;
}

/** 上下文占用帧(host/host.ts:2146-2156 pushContext;盖戳) */
export interface ContextFrame {
  type: "context";
  sessionId: string;
  tokens: number;
  window: number;
  percent: number;
  hi?: string; // 盖戳帧
  seq?: number;
}

/** 整会话统计帧(host/host.ts:2178 pushSessionStats) */
export interface SessionStatsFrame extends SessionStatsPayload {
  type: "session_stats";
  sessionId: string;
}

/** 会话事件帧(host/host.ts:2184 translateEvent 盖戳 / 2211 mention 直发无戳) */
export type EventFrame = {
  type: "event";
  sessionId: string;
  hi?: string; // 盖戳变体(translateEvent 路径)
  seq?: number;
} & UiEvent;

/** 子代理生命周期帧(host/host.ts:2415-2427;盖戳) */
export interface SubagentLifecycleFrame {
  type: "subagent_lifecycle";
  sessionId: string;
  subagentId: string;
  agent: string;
  description: string;
  status: string; // started/completed/failed/aborted 等(底座原样)
  name: string;
  parent: string;
  registeredAt?: number; // 仅 started 之后有值(Map 查询可 undefined)
  detached: boolean;
  hi?: string; // 盖戳帧
  seq?: number;
}

/** 子代理聚合进度帧(host/host.ts:2465 常规 / 2431 终态补发;不盖戳) */
export interface SubagentProgressFrame {
  type: "subagent_progress";
  sessionId: string;
  subagentId: string;
  agent?: string;
  status?: string;
  task?: string;
  cost?: number;
  durationMs?: number;
  requests?: number;
  toolCount?: number;
  // TODO(收口核对): tokens 为底座 progress 的分桶对象,随 SDK
  tokens?: Record<string, number>;
  contextTokens?: number;
  contextWindow?: number;
  currentTool?: string;
  currentToolArgs?: unknown;
  currentToolStartMs?: number;
  lastIntent?: string;
  resolvedModel?: string;
  resolvedThinkingLevel?: string;
  recentTools?: unknown[];
  name?: string; // 常规帧携带;终态补发帧(2431)无
  parent?: string; // 同上
  registeredAt?: number; // 同上
}

/** 子代理事件帧(host/host.ts:2473 translateSubagentEvent;盖戳) */
export type SubagentEventFrame = {
  type: "subagent_event";
  sessionId: string;
  subagentId: string;
  hi?: string; // 盖戳帧
  seq?: number;
} & UiEvent;

/** steer/排队消费前通知帧(host/host.ts:2483 dequeue hook;盖戳) */
export interface SteerConsumedFrame {
  type: "steer_consumed";
  sessionId: string;
  texts: string[];
  hi?: string; // 盖戳帧
  seq?: number;
}

/** 排队快照帧(host/host.ts:2890 sendQueued;盖戳) */
export interface QueuedFrame {
  type: "queued";
  sessionId: string;
  followUp: QueuedMessage[];
  steering: QueuedMessage[];
  hi?: string; // 盖戳帧
  seq?: number;
}

// ---------- 帧联合 ----------

/** host → UI 全部帧的判别联合(75 种;store 巨型 switch 逐分支消费,default 路径兜底未知帧) */
export type HostFrame =
  | ReadyFrame
  | ErrorFrame
  | CommandsFrame
  | CommandOutputFrame
  | CommandResultFrame
  | CommandPhaseFrame
  | GoalFrame
  | TodosFrame
  | PlanModeFrame
  | SessionCreatedFrame
  | SessionListFrame
  | MessagesFrame
  | SessionArchivedFrame
  | SessionAbortedFrame
  | SessionRenamedFrame
  | SessionCompactedFrame
  | SessionBranchedFrame
  | SessionTreeFrame
  | EntryTreeFrame
  | SessionNavigatedFrame
  | SessionExternalWriteFrame
  | FileDiffFrame
  | FileContentFrame
  | ImageContentFrame
  | DirListFrame
  | FileMatchesFrame
  | BashStartFrame
  | BashChunkFrame
  | BashDoneFrame
  | ContextDetailFrame
  | LimitsResultFrame
  | ProviderLimitsResultFrame
  | GitStagedFrame
  | GitUnstagedFrame
  | GitDiscardedFrame
  | GitCommittedFrame
  | GitPushedFrame
  | GitStatusFrame
  | GitBranchesFrame
  | GitBranchSwitchedFrame
  | ApprovalModeFrame
  | ApprovalResolvedFrame
  | ApprovalRequestFrame
  | SessionModelFrame
  | SessionThinkingFrame
  | SettingsFrame
  | SettingsSchemaFrame
  | ModelsFrame
  | ModelsCatalogFrame
  | AllProvidersFrame
  | LoginProgressFrame
  | LoginPromptFrame
  | LoginDoneFrame
  | ProviderKeyDoneFrame
  | ModelsConfigPathFrame
  | ModelRolesFrame
  | UsageStatsFrame
  | AgentAssetsFrame
  | ExtensionsFrame
  | AssetFileFrame
  | AssetFileSavedFrame
  | AssetFileDeletedFrame
  | MemoryFileFrame
  | McpServerTestedFrame
  | ProfileSwitchedFrame
  | TerminalDataFrame
  | TerminalExitFrame
  | TerminalCreatedFrame
  | ContextFrame
  | SessionStatsFrame
  | EventFrame
  | SubagentLifecycleFrame
  | SubagentProgressFrame
  | SubagentEventFrame
  | SteerConsumedFrame
  | QueuedFrame;
