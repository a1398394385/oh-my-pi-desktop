// Discriminated union of WS frames (host → UI direction, mirroring sender-side construction).
// Source of truth: every ws.send / broadcast construction site in host/host.ts and host/*.ts,
// mirrored frame by frame as a `type`-literal discriminated union;
// fields follow what senders actually construct, with optionality reflected faithfully
// (some sites may omit fields).
// Event-stream position markers (host/host.ts:659-662): hi = host process instance id,
// seq = globally monotonic event sequence number;
// only stampEvent frames carry hi/seq (member comments mark them "stamped");
// RPC request-response frames and the handshake frame are not stamped.

/** stampEvent stamp (host/host.ts:660-662): process instance id and monotonic sequence number carried by event-stream frames */
export interface EventStamp {
  hi: string;
  seq: number;
}

// ---------- Common payload shapes ----------

/** Approval mode (host/host.ts:1519-1523 validates three values) */
export type ApprovalMode = "yolo" | "write" | "always-ask";

/** Desktop env section (host/state.ts:51 DesktopEnv) */
export interface DesktopEnv {
  httpProxy: string;
  noProxy: string;
  caCerts: string;
}

/** Settings snapshot (host/models.ts:82-93 settingsSnapshot) */
export interface SettingsSnapshot {
  hideThinkingBlock: boolean;
  computerEnabled: boolean;
  // TODO(narrowing pass): H.settings.get return type follows the base; the store side uses it as a string (S.approvalMode)
  approvalMode: string;
  desktopEnv: DesktopEnv;
  activeProfile: string;
  availableProfiles: string[];
  profileAgentDir: string;
  values: Record<string, unknown>;
  conditions: Record<string, boolean>;
}

/** ACP context compaction config object */
export interface AcpConfig {
  enabled: boolean;
  maxContextLimit?: string;
  minContextLimit?: string;
  contextWindow?: string;
  candidates?: boolean;
  protectUserMessages?: boolean;
  systemPrompt?: boolean;
}

/** Cache keepalive probe parameters (host/keepalive-config.ts ProbeConfig; the keepalive section of omp-desktop.json is the source of truth, independent per profile) */
export interface KeepaliveConfig {
  /** Catalog ids of keepalive target models ("provider/model"); empty = no probing */
  targets: string[];
  intervalMs: number;
  /** 0 = never stop due to idleness */
  maxIdleMs: number;
  minPromptTokens: number;
  maxOutputTokens: number;
  /** null = no cap */
  spendCapUsd: number | null;
  maxMissStreak: number;
  maxErrorStreak: number;
  mode: "default" | "smart";
}

/** omp-desktop.json ui-section projection (host/ui-config.ts readUiConfig) — the file-first authority for desktop-owned appearance settings */
export interface UiConfigPayload {
  locale?: "zh-CN" | "en"; // explicit file value only; undefined = never set
  theme?: "dark" | "light" | "system";
  motion?: "system" | "on" | "off";
  prefs?: Record<string, unknown>;
}

/** Settings frame payload = base snapshot + host-side experimental toggles (host/frames.ts settingsFrame) */
export type SettingsPayload = SettingsSnapshot & {
  acpEnabled: boolean;
  acpConfig?: AcpConfig;
  sessionContextEnabled: boolean;
  keepaliveEnabled: boolean;
  keepaliveConfig?: KeepaliveConfig;
  hooksEnabled: boolean;
  pluginsEnabled?: boolean;
  skillsEnabled?: boolean;
  uiConfig?: UiConfigPayload;
};

/** Model catalog entry (host/models.ts:17-23 modelsPayload) */
export interface ModelEntry {
  id: string; // "provider/model"
  name: string;
  // TODO(narrowing pass): getSupportedEfforts return type follows the base SDK (list of level ids or null)
  efforts: string[] | null;
  // 18.5 capability axes read straight off the registry model: prompt-cache
  // keepalive tier in seconds (long tier preferred, short as fallback),
  // native/delegated web-search grounding, native/delegated image generation.
  promptCache?: number;
  webSearch?: boolean;
  imageGen?: boolean;
}

/** Defaults for new-session config (host/models.ts:157-164 modelsDefaults) */
export interface ModelsDefaults {
  defaultModel: string | null;
  defaultThinking: string | null;
}

/** Model catalog entry, models-management page view (host/models.ts:133-154 modelCatalog) */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  context: number | null;
  vision: boolean;
  efforts: string[] | null; // same TODO as ModelEntry.efforts
  authSource: "config" | "cred";
  // Same 18.5 capability axes as ModelEntry (models-management page view).
  promptCache?: number;
  webSearch?: boolean;
  imageGen?: boolean;
}

/** Model role entry (host/models.ts modelRolesPayload) */
export interface ModelRoleEntry {
  id: string;
  name: string;
  tag: string | null;
  value: string | null;
  resolved: string | null;
  resolvedName: string | null;
  /** one of the SDK's built-in roles vs a user-defined custom role */
  builtin: boolean;
}

/** Provider list entry (host/host.ts:1661-1684: {id,label} from listAllProviders + login/accounts) */
export interface AllProviderEntry {
  id: string;
  label: string;
  login: boolean; // has a real auth flow (oauth-code/device-code/custom)
  accounts: number; // number of active credentials in authStorage
}

/** Slash command entry (host/host.ts:305-320 sendCommandsFrame) */
export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  hint: string | null;
  // TODO(narrowing pass): source comes from base InternalAvailableSlashCommand.source (builtin/extension/custom/skill etc.)
  source: string;
  subcommands: { name: string; description: string; usage: string | null }[];
}

/** @ file candidate (host/host.ts:342-367 listFileMatches) */
export interface FileMatch {
  path: string;
  dir: boolean;
}

/** Single-level directory entry (host/host.ts:1166-1173 list_dir) */
export interface DirEntry {
  name: string;
  dir: boolean;
}

/** git status row (host/host.ts:1471-1484 get_git_diff) */
export interface GitStatusFile {
  code: string; // XY two columns (whitespace stripped, "?" fallback)
  path: string;
  staged: string; // empty string = none
  unstaged: string; // empty string = none
}

/** Cross-file branch-family node (host/host.ts:965-979 get_session_tree) */
export interface SessionBranch {
  sessionId: string;
  path: string;
  title: string | null;
  modified: string; // ISO
  parentSession: string | null;
  isCurrent: boolean;
  messageCount: number;
}

/** On-disk session row (sessions mapping of handleListSessions, host/host.ts:2637-2645) */
export interface DiskSessionRow {
  id: string;
  path: string;
  title: string | null;
  firstMessage: string; // truncated to 80 chars
  modified: string; // ISO
  messageCount: number;
  archived: boolean;
}

/** Project grouping (projects mapping of handleListSessions, host/host.ts:2628-2646) */
export interface DiskProject {
  cwd: string;
  sessions: DiskSessionRow[];
}

/** Entry tree node (host/translate.ts:738-749 EntryTreeNode) */
export interface EntryTreeNode {
  id: string;
  kind: string; // entry.type
  role?: string; // message role (only on message entries)
  text: string;
  label?: string;
  ts?: string;
  userReq?: boolean;
  emptyAssistant?: boolean;
  isSettings?: boolean;
  children: EntryTreeNode[];
}

/** Quota window section (host/limits/index.ts:12-20 LimitWindow) */
export interface LimitWindow {
  kind: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  resetDescription?: string;
}

/** Balance section (host/limits/index.ts:22-25 LimitBalance) */
export interface LimitBalance {
  amount: number | null;
  currency?: string;
}

/** Multi-account quota entry (provider_limits_result.accounts mapping, host/host.ts:1377-1384) */
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

/** Usage stats (host/stats.ts:74-86 collectUsageStats) */
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

/** Goal state (inner payload of the goal frame, host/host.ts:391-401 pushGoal) */
export interface GoalState {
  objective: string;
  // TODO(narrowing pass): goal.status enum values follow the base GoalController (active/paused/done etc.)
  status: string;
  enabled: boolean;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  costUsed: number;
}

/** Todo task status (node_modules/@oh-my-pi/pi-tui/dist/types/tools/todo.d.ts:5 TodoStatus) */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** Todo task (todo.d.ts:9-16 TodoItem) */
export interface TodoTask {
  content: string;
  status: TodoStatus;
  blocker?: string; // reason for waiting when status === "blocked"
  details?: string;
  notes?: string[];
}

/** Todo phase (todo.d.ts:18-21 TodoPhase; element of phases in the host todos frames) */
export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

/** Token usage of the current LLM turn (host/state.ts:8 TurnUsage) */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** On-wire shape of session entries (host/state.ts:9-40 TranscriptItem; element of the messages frame) */
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
  // TODO(narrowing pass): details is runtime metadata for tools like read/hub (read rows read details.isDirectory); shape follows the base
  details?: unknown;
  collapsed?: boolean;
  items?: TranscriptItem[];
  durationSec?: number | null;
  usage?: TurnUsage | null;
  entryId?: string;
  endMs?: number;
  // ---- bash rows ----
  running?: boolean;
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean;
  error?: string;
  // ---- phase rows ----
  phase?: "start" | "done";
  command?: string;
  // ---- user image attachments ----
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

/** Queued message view element (host/host.ts:2888-2890 sendQueued, via base toRestoredQueuedMessage) */
// TODO(narrowing pass): toRestoredQueuedMessage return shape follows the base SDK (at least text; the store side uses text/images)
export interface QueuedMessage {
  text: string;
  images?: unknown[];
}

/** Narrow event-stream event (host/translate.ts:10-19 UiEvent; kind-discriminated body of event/subagent_event frames) */
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
  | { kind: "mention"; files: string[] }
  | { kind: "error"; text: string }; // provider/request failure (quota, auth, transport): rendered as a standalone row

/** Whole-session stats (expanded fields of the session_stats frame, host/session-lifecycle.ts buildSessionStats) */
export interface SessionStatsPayload {
  // TODO(narrowing pass): tokens is the cumulative bucketing of base
  // SessionManager.getUsageStatistics (input/output/cacheRead/cacheWrite); follows the SDK
  tokens: Record<string, number>;
  cost: number;
  cacheHitRate: number;
  advisorCost: number;
  activeMs: number;
  /** Host clock stamp sampled in the same call as activeMs (extrapolation baseline, see receivedAt). */
  statsAt: number;
  // UI-local only: copied from the frame's statsAt on landing. The active-time
  // figure is sampled at push time, so the bar extrapolates it locally while the
  // session is running instead of freezing until the next frame. Using the host
  // stamp (not the local landing time) keeps the figure monotonic across frames:
  // transport/queueing delay would otherwise rewind it on every landing.
  receivedAt?: number;
  tokenSpeed?: number | null;
  avgTtft?: number | null;
}

/** Context-detail breakdown (context_detail frame, host/host.ts:1283-1301 + estimateMcpToolsTokens) */
// TODO(narrowing pass): breakdown is the base getContextBreakdown() expansion + mcpToolsTokens; bucket shape follows the SDK
export type ContextBreakdown = Record<string, unknown> & { mcpToolsTokens: number };

/** Inner stats of the context_detail frame (host/host.ts:1291-1300) */
export interface ContextDetailStats {
  // TODO(narrowing pass): tokens is the bucketed object of base getSessionStats().tokens; follows the SDK
  tokens: Record<string, number>;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  premiumRequests: number;
  cost: number;
}

/** agent_assets frame payload (host/assets.ts:636-698 listAgentAssets; section elements keep their on-disk scan shape) */
// TODO(narrowing pass): per-field shape of the skills section is decided by the internal scan in assets.ts; unknown for now (McpPage/SkillsPage narrow it on actual reads)
/** MCP assets payload (host/assets.ts:605-630; servers elements are host McpServerItem, scopes are scope groupings) */
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

export interface HookAssetItem {
  name: string;
  path: string;
  phase: "pre" | "post" | string;
  tool?: string;
  scope?: "profile" | "project" | string;
  cwd?: string;
  projectName?: string;
  enabled?: boolean;
}

export interface PluginAssetItem {
  name: string;
  version?: string;
  path?: string;
  scope?: string;
  enabled?: boolean;
  description?: string;
}

export interface AgentAssetsPayload {
  memories: { name: string; path: string; project?: string }[];
  skills: unknown;
  agents: {
    global: { name: string; path: string; description: string }[];
    profile: { name: string; path: string; description: string }[];
    projects: { cwd: string; name: string; dir: string; agents?: { name: string; path: string; description: string }[] }[];
    globalDir: string;
    profileDir: string;
    profileName?: string;
  };
  hooks: HookAssetItem[];
  mcp: McpAssetsPayload;
  plugins: PluginAssetItem[];
  flags: { enableMCP: boolean; disableExtensionDiscovery: boolean; computerEnabled: boolean };
}

/** Asset kind (host/assets.ts AssetKind) */
export type AssetKind = "agent" | "skill" | "mcp" | "hook";

/** Prompt attachment (UI → host; host/host.ts:2666-2672 PromptAttachment, sent by the UI along with the prompt) */
export interface PromptAttachment {
  kind: "image" | "text";
  mime?: string; // image: base64 (no data: prefix)
  name?: string; // text: file name
  text?: string; // text: file content
  data?: string;
}

// ---------- Frame members (mirroring each sender-side construction site) ----------
export interface ReadyFrame {
  type: "ready";
  hi: string;
  approvalMode: string;
  models: ModelEntry[];
  roles: ModelRoleEntry[];
  defaultModel: string | null;
  defaultThinking: string | null;
  settings: SettingsPayload;
}

/** Error frame (host/host.ts:690 invalid JSON / 2098 unknown command / 2102 RPC failure / 1222-1227 bash busy;
    2235/2861 event-stream errors, stamped) */
export interface ErrorFrame {
  type: "error";
  message: string;
  sessionId?: string | null; // explicitly nullable at the 2102 site; always present at 1222
  kind?: string | null; // only carried by 2102 (RPC failure reply)
  hi?: string; // stamped variant (2235/2861)
  seq?: number;
}

/** Command list frame (host/host.ts:305-320 sendCommandsFrame) */
export interface CommandsFrame {
  type: "commands";
  sessionId: string | null;
  commands: SlashCommand[];
}

/** Command output frame (host/host.ts:380 pushCommandOutput / 2702 / 2752 / 2777 / 2782) */
export interface CommandOutputFrame {
  type: "command_output";
  sessionId: string;
  text: string;
}

/** Command consumed-result frame (host/host.ts:2703 / 2713 / 2719 / 2802 / 2853) */
export interface CommandResultFrame {
  type: "command_result";
  sessionId: string;
  text: string;
  consumed: boolean; // always true (sender-side literal)
}

/** Phase separator frame for slow background commands (host/host.ts:2760 start / 2776 / 2781 fail) */
export interface CommandPhaseFrame {
  type: "command_phase";
  sessionId: string;
  phase: "start" | "fail";
  command: string; // compact/handoff/rename
  text?: string; // only carried by start (PHASE_TEXT[command][0])
}

/** Goal state frame (host/host.ts:389-402 pushGoal) */
export interface GoalFrame {
  type: "goal";
  sessionId: string;
  goal: GoalState | null;
}

/** Todos list frame (host/host.ts:413 pushTodos stamped / 1275 get_todos unstamped / 2187 stamped) */
export interface TodosFrame {
  type: "todos";
  sessionId: string;
  phases: TodoPhase[];
  hi?: string; // stamped variant
  seq?: number;
}

/** Plan mode state frame (host/host.ts:420-426 pushPlanMode) */
export interface PlanModeFrame {
  type: "plan_mode";
  sessionId: string;
  enabled: boolean;
  planFilePath: string | null;
}

/** Session created/reused snapshot frame (host/host.ts:2513-2524 / 2540-2551 / 2573-2584 session_created) */
export interface SessionCreatedFrame {
  type: "session_created";
  sessionId: string;
  path: string;
  cwd: string;
  model: string | null;
  thinking: string;
  isGit: boolean;
  title?: string | null;
  isSubagent?: boolean;
  parentPath?: string;
}

/** Session list frame (host/host.ts:2645-2656 handleListSessions) */
export interface SessionListFrame {
  type: "session_list";
  projects: DiskProject[];
  allProjects: string[];
  removedProjects: string[];
  expandedProjects: string[];
  pinnedSessions: string[];
}

/** Full message snapshot frame (host/host.ts:873 / 912 / 1031 / 2552 / 2586 / 2768 / 2868) */
export interface MessagesFrame {
  type: "messages";
  sessionId: string;
  messages: TranscriptItem[];
}

/** Session archive reply (host/host.ts:800) */
export interface SessionArchivedFrame {
  type: "session_archived";
  sessionId: string;
  ok: boolean; // always true
  archived: boolean;
}

/** Session abort reply (host/host.ts:831) */
export interface SessionAbortedFrame {
  type: "session_aborted";
  sessionId: string;
  ok: boolean; // always true
}

/** Session rename reply (host/host.ts:854) */
export interface SessionRenamedFrame {
  type: "session_renamed";
  sessionId: string;
  ok: boolean; // always true
  title: string;
}

/** Session title change push (host/host.ts listens to onSessionNameChanged) */
export interface SessionTitleChangedFrame {
  type: "session_title_changed";
  sessionId: string;
  title: string;
}

/** Manual compaction reply (host/host.ts:865 empty session / 874 success / 876 failure) */
export interface SessionCompactedFrame {
  type: "session_compacted";
  sessionId: string;
  ok?: boolean; // success only
  error?: string; // failure only
}

/** Session fork reply (host/host.ts:895 cancelled / 913-921 success / 926 failure) */
export interface SessionBranchedFrame {
  type: "session_branched";
  sessionId: string;
  ok: boolean;
  newSessionId?: string; // success only
  newPath?: string; // success only
  // TODO(narrowing pass): selectedImages is the attachment array of the forked user message; element shape follows the base
  selectedText?: string; // success only
  selectedImages?: unknown[]; // success only
  error?: string; // failure only
}

/** Session fork reply (18.5 base fork: whole-session copy or root→entryId slice into a new pooled session; host/rpc/session.ts fork_session) */
export interface SessionForkedFrame {
  type: "session_forked";
  sessionId: string; // source session the UI asked on
  ok: boolean;
  newSessionId?: string; // success only: the new pooled session to switch to
  newPath?: string; // success only: new session file path
  selectedText?: string | null; // success only: entryId fork backfills the composer with the cut message's text
  error?: string; // failure only
}

/** Cross-file branch-family tree reply (host/host.ts:940 failure / 965-979 success) */
export interface SessionTreeFrame {
  type: "session_tree";
  sessionId: string;
  ok: boolean;
  branches?: SessionBranch[]; // success only
  error?: string; // failure only
}

/** In-session entry tree reply (host/host.ts:990-997 get_entry_tree; ok is always true, failures go through the error frame) */
export interface EntryTreeFrame {
  type: "entry_tree";
  sessionId: string;
  ok: boolean; // always true
  leafId: string | null;
  roots: EntryTreeNode[];
}

/** In-tree navigation reply (host/host.ts:1015 / 1021 / 1025 failure / 1032-1039 success / 1042 failure) */
export interface SessionNavigatedFrame {
  type: "session_navigated";
  sessionId: string;
  ok: boolean;
  editorText?: string | null; // success only
  // TODO(narrowing pass): editorImages is the image-attachment array of the target user message; element shape follows the base
  editorImages?: unknown[] | null; // success only
  error?: string; // failure only
}

/** External-write notice frame (host/host.ts:2556 re-sent on pool reuse / 3142 detected by pollExternalWrites) */
export interface SessionExternalWriteFrame {
  type: "session_external_write";
  sessionId: string;
}

/** Single-file diff reply (host/host.ts:1100-1107 get_file_diff) */
export interface FileDiffFrame {
  type: "file_diff";
  cwd: string;
  path: string;
  diff: string; // truncated to 500KB
}

/** File content reply (host/host.ts:1117 too large / 1123 binary / 1126 success) */
export interface FileContentFrame {
  type: "file_content";
  path: string;
  text?: string; // success only
  error?: string; // failure only
}

/** Image content reply (host/host.ts:1145 format / 1150 not a file / 1154 too large / 1158 success) */
export interface ImageContentFrame {
  type: "image_content";
  path: string;
  mime?: string; // success only
  data?: string; // success only, base64
  error?: string; // failure only
}

/** Single-level directory listing reply (host/host.ts:1173 list_dir) */
export interface DirListFrame {
  type: "dir_list";
  path: string;
  entries: DirEntry[];
}

/** @ file candidates reply (host/host.ts:1193-1199 list_files; reqId echoed back unchanged) */
export interface FileMatchesFrame {
  type: "file_matches";
  reqId: number;
  matches: FileMatch[];
}

/** ! local command start frame (host/host.ts:1222 bash_exec) */
export interface BashStartFrame {
  type: "bash_start";
  sessionId: string;
  command: string;
  excludeFromContext: boolean;
}

/** ! local command output stream frame (host/host.ts:1226 bash_chunk) */
export interface BashChunkFrame {
  type: "bash_chunk";
  sessionId: string;
  chunk: string;
}

/** ! local command done frame (host/host.ts:1241-1251 success / 1255-1260 failure / 1269 bash_abort) */
export interface BashDoneFrame {
  type: "bash_done";
  sessionId: string;
  exitCode?: number | null; // success only
  cancelled?: boolean; // success (reported by the base) or always true for bash_abort
  timedOut?: boolean; // success only
  truncated?: boolean; // success only
  output?: string; // success only
  error?: string; // failure only
}

/** Context detail reply (host/host.ts:1283-1301 get_context_detail) */
export interface ContextDetailFrame {
  type: "context_detail";
  sessionId: string;
  breakdown: ContextBreakdown | null;
  stats: ContextDetailStats;
}

/** Session quota reply (host/host.ts:1335-1351 get_limits) */
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

/** Provider quota reply (host/host.ts:1363-1386 get_provider_limits) */
export interface ProviderLimitsResultFrame {
  type: "provider_limits_result";
  provider: string;
  label: string;
  unsupported: boolean;
  status: string; // top level takes the first account
  planLabel: string;
  accountLabel: string;
  balance: LimitBalance | null;
  windows: LimitWindow[];
  updatedAt: string | null;
  accounts: LimitsAccount[];
}

/** Active account row (provider_accounts frame) */
export interface ProviderAccountEntry {
  id: number;
  /** email ?? accountId ?? orgName; api_key credentials carry no identity */
  label: string;
}

/** Disabled account tombstone row (provider_accounts frame) */
export interface ProviderDisabledAccount {
  id: number;
  label: string;
  /** Verbatim disable cause (manual marker or captured auto-failure error) */
  cause: string;
  disabledAtMs: number | null;
  /** Disabled via omp-desktop (restorable); auto-disabled rows are display-only */
  manual: boolean;
}

/** Provider account list reply (host/rpc/login.ts provider_list_accounts / disable/restore pushes) */
export interface ProviderAccountsFrame {
  type: "provider_accounts";
  provider: string;
  active: ProviderAccountEntry[];
  disabled: ProviderDisabledAccount[];
}

/** Stage reply (host/host.ts:1396-1397 git_stage) */
export interface GitStagedFrame {
  type: "git_staged";
  cwd: string;
  ok?: boolean; // always true (on success)
  error?: string; // failure only
}

/** Unstage reply (host/host.ts:1406-1407 git_unstage) */
export interface GitUnstagedFrame {
  type: "git_unstaged";
  cwd: string;
  ok?: boolean;
  error?: string;
}

/** Discard changes reply (host/host.ts:1425-1426 git_discard) */
export interface GitDiscardedFrame {
  type: "git_discarded";
  cwd: string;
  ok?: boolean;
  error?: string;
}

/** Commit reply (host/host.ts:1439 / 1444 failure / 1447 success) */
export interface GitCommittedFrame {
  type: "git_committed";
  cwd: string;
  ok?: boolean;
  commit?: string; // success only, new commit sha
  error?: string; // failure only
}

/** Push reply (host/host.ts:1454 failure / 1457 success) */
export interface GitPushedFrame {
  type: "git_pushed";
  cwd: string;
  ok?: boolean;
  result?: string; // success only (stderr or stdout, whitespace stripped)
  error?: string; // failure only
}

/** Changed-files list reply (host/host.ts:1484 get_git_diff) */
export interface GitStatusFrame {
  type: "git_status";
  cwd: string;
  files: GitStatusFile[];
}

/** Branch list reply (host/host.ts:1491 not a git repo / 1502 normal) */
export interface GitBranchesFrame {
  type: "git_branches";
  cwd: string;
  isGit: boolean;
  current: string | null;
  branches: string[];
}

/** Branch switch reply (host/host.ts:1513; failures go through the error frame) */
export interface GitBranchSwitchedFrame {
  type: "git_branch_switched";
  cwd: string;
  branch: string;
}

/** Approval mode reply (host/host.ts:1523 set_approval_mode) */
export interface ApprovalModeFrame {
  type: "approval_mode";
  mode: ApprovalMode;
}

/** Approval resolved frame (host/host.ts:1537 approval_response) */
export interface ApprovalResolvedFrame {
  type: "approval_resolved";
  requestId: string;
}

// Wire shape of one ask-dialog question (mirrors the base's
// ExtensionAskDialogQuestion from pi-tui/overlays/ask-dialog; the host passes
// it through verbatim on the approval_request frame).
export interface AskDialogQuestionWire {
  id: string;
  question: string;
  header?: string;
  multi?: boolean;
  recommended?: number;
  options: { label: string; description?: string }[];
}

/** Approval request frame (host/host.ts:2136 select stamped / 2278 confirm stamped / 2301 editor stamped) */
export interface ApprovalRequestFrame {
  type: "approval_request";
  sessionId: string;
  requestId: string;
  title: string; // confirm variant is `${title}\n${message}`
  options: string[]; // editor/plan variants pass stable ids (submit/cancel/plan:execute/plan:compact/plan:keep/plan:refine/plan:save-quit); the UI renders localized text by id
  // Live context usage for the plan-approval keep-context row. Raw numbers, not
  // a rendered label: the UI localizes "Approve and keep context (~44k / 1m)".
  keepContextTokens?: { tokens: number; contextWindow: number };
  // Row indices the operator may not pick (plan approval disables keep-context
  // once the context is nearly full).
  disabledIndices?: number[];
  // Execution-model tier slider shown above the plan options.
  slider?: { caption: string; index: number; segments: { label: string; detail: string }[] };
  editable?: boolean; // always true for the editor variant only
  // Index of the inline-input row within options (editor variant). Protocol
  // field: locating the row by id/index, never by display text.
  editableIndex?: number;
  prefill?: string; // editor variant only
  // Ask-dialog variant only (18.5 uiCtx.askDialog): the multi-question form.
  // Mirrors the base's ExtensionAskDialogQuestion; approval_response answers
  // with answer = JSON.stringify(ExtensionAskDialogSubmitResult).
  questions?: AskDialogQuestionWire[];
  hi?: string; // stamped frame
  seq?: number;
}

/** Session model reply (host/host.ts:1553-1561 set_model / 2789-2797 notifyConfigChanged) */
export interface SessionModelFrame {
  type: "session_model";
  sessionId: string;
  model: string | null;
  thinking: string;
}

/** Session thinking level reply (host/host.ts:1568 set_thinking) */
export interface SessionThinkingFrame {
  type: "session_thinking";
  sessionId: string;
  level: string;
}

/** Settings frame (host/host.ts:1579 / 1590 / 1628 / 1635 / 1641 / 2052; 1654 carries restartHint) */
export interface SettingsFrame {
  type: "settings";
  settings: SettingsPayload;
  restartHint?: boolean; // always true only in the set_desktop_env reply
}

/** Settings schema frame (host/host.ts:1582 get_settings_schema) */
export interface SettingsSchemaFrame {
  type: "settings_schema";
  // TODO(narrowing pass): SETTINGS_SCHEMA entry shape follows base config/settings (type/default/values etc.)
  schema: Record<string, unknown>;
}

export interface ModelsFrame {
  type: "models";
  models: ModelEntry[];
  roles: ModelRoleEntry[];
  defaultModel: string | null;
  defaultThinking: string | null;
  reqId?: number | null; // only carried by the reply wrapper of provider_login
}

/** Quick-switch result (host/rpc/models.ts cycle_model): ok=false = fewer than two resolvable roles, nothing to cycle */
export interface CycleModelFrame {
  type: "cycle_model";
  sessionId: string;
  ok: boolean;
  model?: string;
  role?: string;
  thinking?: string;
}

/** Models-management page catalog frame (host/host.ts:1658 and other send sites; the login flow carries reqId via a reply wrapper) */
export interface ModelsCatalogFrame {
  type: "models_catalog";
  models: ModelCatalogEntry[];
  reqId?: number | null; // only carried by the reply wrapper of provider_login
}

/** Provider list frame (host/host.ts:1661-1684 get_all_providers) */
export interface AllProvidersFrame {
  type: "all_providers";
  providers: AllProviderEntry[];
}

/** Login progress frame (host/host.ts:1696 / 1710 onAuth / 1716 onProgress; the reply wrapper always carries reqId) */
export interface LoginProgressFrame {
  type: "login_progress";
  reqId: number | null;
  provider: string;
  message: string;
  url?: string; // onAuth variant only
}

/** Login paste-code prompt frame (host/host.ts:1729 onPrompt; the reply wrapper always carries reqId) */
export interface LoginPromptFrame {
  type: "login_prompt";
  reqId: number | null;
  provider: string;
  id: number; // promptSeq, echoed back as the key of login_prompt_reply
  message: string;
  secret: boolean;
}

/** Login done frame (host/host.ts:1738 success / 1742-1748 failure; the reply wrapper always carries reqId) */
export interface LoginDoneFrame {
  type: "login_done";
  reqId: number | null;
  provider: string;
  ok: boolean;
  identity?: unknown | null; // success only (base login identity object)
  cancelled?: boolean; // failure only
  message?: string; // failure only
}

/** API key configured frame (host/host.ts:1794 provider_set_key) */
export interface ProviderKeyDoneFrame {
  type: "provider_key_done";
  provider: string;
  ok: boolean; // always true
}

/** models.yml path frame (host/host.ts:1812 open_models_config) */
export interface ModelsConfigPathFrame {
  type: "models_config_path";
  path: string;
}

/** Catalog metadata the base would auto-inherit for an unedited wizard model (host/rpc/provider-wizard.ts) */
export interface ManualProbeCatalogMatch {
  name?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean;
  input?: ("text" | "image")[] | null; // accepted input modalities (null = unknown)
  supportsTools?: boolean | null; // native tool-call support (null = unknown)
  thinking?: { mode: string; efforts?: string[]; defaultLevel?: string } | null; // effort-control config
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

/** One model row from the wizard probe (endpoint-reported values + catalog match) */
export interface ManualProbeModel {
  id: string;
  name: string;
  contextWindow: number | null; // endpoint-reported, null when the endpoint did not say
  maxTokens: number | null;
  catalog: ManualProbeCatalogMatch | null; // null = no bundled-catalog match by id
  saved: ManualProbeCatalogMatch | null; // custom metadata already persisted in models.yml (null = bare/inherited row)
}

/** Wizard probe reply (host/rpc/provider-wizard.ts probe_provider_models) */
export interface ProviderModelsProbeFrame {
  type: "provider_models_probe";
  models: ManualProbeModel[];
  failed?: boolean;
  message?: string; // failure reason when failed
}

/** Wizard per-model save reply (host/rpc/provider-wizard.ts save_provider_model) */
export interface ProviderModelSavedFrame {
  type: "provider_model_saved";
  provider: string;
  model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
}

/** One model row's metadata snapshot for a persisted provider (provider_model_meta reply) */
export interface ProviderModelMetaRow {
  id: string;
  saved: ManualProbeCatalogMatch | null;
  catalog: ManualProbeCatalogMatch | null;
}

/** Provider-detail metadata snapshot frame (host/rpc/provider-wizard.ts provider_model_meta) */
export interface ProviderModelMetaFrame {
  type: "provider_model_meta";
  provider: string;
  exists: boolean;
  models: ProviderModelMetaRow[];
}

/** Single-model connectivity test reply (host/rpc/models.ts test_provider_model) */
export interface ProviderModelTestFrame {
  type: "provider_model_test";
  model: string; // catalog id "provider/modelId"
  ok: boolean;
  latencyMs: number;
  reply?: string; // first 120 chars of the model's text answer (ok only)
  message?: string; // failure reason when !ok
}

/** Wizard save reply (host/rpc/provider-wizard.ts save_provider_models) */
export interface ProviderModelsSavedFrame {
  type: "provider_models_saved";
  provider: string;
  count: number;
}

/** Model roles frame (host/host.ts:1848 get_model_roles / 1861 set_model_role) */
export interface ModelRolesFrame {
  type: "model_roles";
  roles: ModelRoleEntry[];
}

/** Usage stats frame (host/host.ts:1865 get_usage_stats) */
export interface UsageStatsFrame {
  type: "usage_stats";
  stats: UsageStats;
}

/** Assets list frame (host/host.ts:1868 and other send sites) */
export interface AgentAssetsFrame {
  type: "agent_assets";
  assets: AgentAssetsPayload;
}

/** Extension-hub entry source metadata (host/extensions.ts ExtSource, a subset of base SourceMeta) */
export interface ExtSource {
  provider: string;
  providerName: string;
  level: "user" | "project" | "native";
}

/** Extension-hub entry detail precomputation (condition parsing / tool file header / command preview; sent by the host, rendered as-is) */
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

/** Unified extension-hub entry (host/extensions.ts ExtensionItem; id follows the base disabledExtensions id scheme kind:name) */
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

/** Extension-hub data frame (replies of four RPCs incl. host/host.ts list_extensions) */
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

/** Asset file content reply (host/host.ts:1875 / 1928 / 1943 asset_file_read / asset_file_create) */
export interface AssetFileFrame {
  type: "asset_file";
  kind: AssetKind;
  path: string;
  content: string;
}

/** Asset file saved reply (host/host.ts:1913 asset_file_write) */
export interface AssetFileSavedFrame {
  type: "asset_file_saved";
  kind: AssetKind;
  path: string;
}

/** Asset file deleted reply (host/host.ts:1978 asset_skill_delete) */
export interface AssetFileDeletedFrame {
  type: "asset_file_deleted";
  kind: "skill"; // sender-side literal
  path: string;
}

/** Memory file reply (host/host.ts:1906 memory_file_read; files/rollouts are carried only by directory-style memories) */
export interface MemoryFileFrame {
  type: "memory_file";
  path: string;
  file: string; // basename of the file actually read
  files?: string[];
  rollouts?: string[];
  content: string;
}

/** MCP server test reply (host/rpc/assets.ts test_mcp_server) */
export interface McpServerTestedFrame {
  type: "mcp_server_tested";
  name: string;
  status: "ok" | "error";
  error?: string;
  log?: string;
}

/** Profile switched frame (host/host.ts:2059 switch_profile) */
export interface ProfileSwitchedFrame {
  type: "profile_switched";
  profile: string;
}

/** Body types of the capabilities snapshot (mirrors host/capabilities.ts CapabilitiesSnapshot) */
export interface CapabilitiesSnapshot {
  sessionId: string;
  mcp: { servers: { name: string; status: string }[]; tools: number };
  lsp: { name: string; status: string; fileTypes?: string[]; error?: string }[];
  advisor: {
    configured: boolean;
    active: boolean;
    model?: string;
    contextWindow: number;
    contextTokens: number;
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    messages: { user: number; assistant: number; total: number };
    advisors: { name: string; status: string; model?: string; cost: number; tokensTotal: number; messagesTotal: number }[];
  };
  memory: {
    backend: string;
    active: boolean;
    writable?: boolean;
    searchable?: boolean;
    scope?: string;
    workingCount?: number;
    episodicCount?: number;
    tripleCount?: number;
    lastMemory?: string;
    database?: string;
    message?: string;
    error?: string;
  };
  extensions: {
    loaded: boolean;
    paths: string[];
    tools: string[];
    commands: string[];
    diagnostics: { type: string; message: string; path: string }[];
  };
}

/** Capabilities snapshot reply (host/rpc/capabilities.ts get_capabilities; right-panel capabilities page) */
export interface CapabilitiesFrame {
  type: "capabilities";
  snapshot: CapabilitiesSnapshot;
}

/** MCP connection-status incremental push (host/session-lifecycle attachEntry; process-global, carries no sessionId) */
export interface CapabilitiesMcpFrame {
  type: "capabilities_mcp";
  mcp: { servers: { name: string; status: string }[]; tools: number };
}


/** Terminal data frame (onData callback of host/host.ts:2073 terminal_create) */
export interface TerminalDataFrame {
  type: "terminal_data";
  id: string;
  data: string;
}

/** Terminal exit frame (host/host.ts:2076 onExit callback) */
export interface TerminalExitFrame {
  type: "terminal_exit";
  id: string;
  code: number;
}

/** Terminal created reply (host/host.ts:2079 terminal_create) */
export interface TerminalCreatedFrame {
  type: "terminal_created";
  id: string;
  shell: string;
}

/** Context usage frame (host/host.ts:2146-2156 pushContext; stamped) */
export interface ContextFrame {
  type: "context";
  sessionId: string;
  tokens: number;
  window: number;
  percent: number;
  hi?: string; // stamped frame
  seq?: number;
}

/** Whole-session stats frame (host/host.ts:2178 pushSessionStats) */
export interface SessionStatsFrame extends SessionStatsPayload {
  type: "session_stats";
  sessionId: string;
}

/** Session event frame (host/host.ts:2184 translateEvent stamped / 2211 mention sent directly, unstamped) */
export type EventFrame = {
  type: "event";
  sessionId: string;
  hi?: string; // stamped variant (translateEvent path)
  seq?: number;
} & UiEvent;

/** Subagent lifecycle frame (host/host.ts:2415-2427; stamped) */
export interface SubagentLifecycleFrame {
  type: "subagent_lifecycle";
  sessionId: string;
  subagentId: string;
  agent: string;
  description: string;
  status: string; // started/completed/failed/aborted etc. (passed through from the base)
  name: string;
  parent: string;
  registeredAt?: number; // only set after started (a Map lookup may be undefined)
  sessionFile?: string | null; // child transcript file (agent hub lineage/output)
  readOnly?: boolean; // child session_init.readOnly, host-recovered (Agent Hub Changes line)
  advisor?: boolean; // advisor transcript (__advisor stem), host-derived like the TUI registry kind
  detached: boolean;
  hi?: string; // stamped frame
  seq?: number;
}

/** Subagent aggregated progress frame (host/host.ts:2465 regular / 2431 terminal-state re-send; unstamped) */
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
  // TODO(narrowing pass): tokens is the bucketed object of base progress; follows the SDK
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
  name?: string; // carried by regular frames; absent from the terminal-state re-send (2431)
  parent?: string; // same as above
  registeredAt?: number; // same as above
}

/** Subagent event frame (host/host.ts:2473 translateSubagentEvent; stamped) */
export type SubagentEventFrame = {
  type: "subagent_event";
  sessionId: string;
  subagentId: string;
  hi?: string; // stamped frame
  seq?: number;
} & UiEvent;

/** Pre-consumption notice for steer/queued messages (host/host.ts:2483 dequeue hook; stamped) */
export interface SteerConsumedFrame {
  type: "steer_consumed";
  sessionId: string;
  texts: string[];
  hi?: string; // stamped frame
  seq?: number;
}

/** Queued snapshot frame (host/host.ts:2890 sendQueued; stamped) */
export interface QueuedFrame {
  type: "queued";
  sessionId: string;
  followUp: QueuedMessage[];
  steering: QueuedMessage[];
  hi?: string; // stamped frame
  seq?: number;
}

/** Background job snapshot (18.5 AgentSession async jobs: bash/task/eval rows the model backgrounded; host/rpc/session.ts get_bg_jobs/cancel_bg_job; stamped) */
export interface BgJobsFrame {
  type: "bg_jobs";
  sessionId: string;
  jobs: {
    id: string;
    command: string | null; // process-backed jobs only (bash)
    cwd: string | null;
    pids: number[]; // live pids while running, empty once settled
    exitCode: number | null; // null while running or when the body reported none
    running: boolean;
  }[];
  hi?: string; // stamped frame
  seq?: number;
}

/** Subagent control receipt (18.5 handleRpcCancelSubagent/handleRpcSteerSubagent; host/rpc/session.ts control_subagent; stamped) */
export interface SubagentControlledFrame {
  type: "subagent_controlled";
  sessionId: string;
  agentId: string;
  ok: boolean;
  error?: string; // steer refusal detail (base-provided message)
  hi?: string; // stamped frame
  seq?: number;
}

/** Word-completion reply (18.5 RpcWordPredictor ghost text; host/rpc/prompt.ts complete_text; stamped) */
export interface CompletionFrame {
  type: "completion";
  sessionId: string;
  suggestion: string; // "" = engine off / no prediction / superseded by a newer request
  hi?: string; // stamped frame
  seq?: number;
}

/** Prompt-cache warming lifecycle (18.5 session events cache_warming_start/end forwarded by host/session-lifecycle.ts; stamped) */
export interface CacheWarmingFrame {
  type: "cache_warming";
  sessionId: string;
  phase: "start" | "end";
  outcome?: string; // end only: hit | miss | error | aborted
  hi?: string; // stamped frame
  seq?: number;
}

/** Cache keepalive runtime snapshot reply (host/rpc/session.ts get_keepalive_status; pure query for the context detail card) */
export interface KeepaliveStatusFrame {
  type: "keepalive_status";
  sessionId: string;
  /** Effective keepalive for this session: the global switch is on AND the extension was injected at creation (sessions predating the switch, or skipped by the plugin double-load guard, report false) */
  enabled: boolean;
  /** Armed at the last report (capture held, not paused, no probe in flight) */
  active: boolean;
  probes: number;
  hits: number;
  misses: number;
  errors: number;
  savedUsd: number;
  spendUsd: number;
  /** ms epoch of the next scheduled probe; null = nothing scheduled (paused, deadline held mid-turn, or never armed) */
  nextProbeAt: number | null;
}

// ---------- UI → host client frames ----------

/** UI locale switch (UI → host; fire-and-forget, host persists it and applies it to its own surfaces) */
export interface SetLocaleFrame {
  type: "set_locale";
  lang: "zh-CN" | "en";
}

// ---------- Frame union ----------

/** Discriminated union of all host → UI frames (84 kinds; consumed branch by branch by the store's giant switch, the default path is the fallback for unknown frames) */
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
  | SessionTitleChangedFrame
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
  | ProviderAccountsFrame
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
  | CycleModelFrame
  | ModelsCatalogFrame
  | AllProvidersFrame
  | LoginProgressFrame
  | LoginPromptFrame
  | LoginDoneFrame
  | ProviderKeyDoneFrame
  | ModelsConfigPathFrame
  | ProviderModelsProbeFrame
  | ProviderModelSavedFrame
  | ProviderModelMetaFrame
  | ProviderModelTestFrame
  | ProviderModelsSavedFrame
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
  | CapabilitiesFrame
  | CapabilitiesMcpFrame
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
  | QueuedFrame
  | SessionForkedFrame
  | BgJobsFrame
  | SubagentControlledFrame
  | CompletionFrame
  | CacheWarmingFrame
  | KeepaliveStatusFrame;
