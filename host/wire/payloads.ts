// Shared payload shapes of the WS wire contract (host → UI direction).
// Single source of truth, moved here from the former ui-src/types/frames.ts
// hand mirror (A10): fields follow what senders actually construct, with
// optionality reflected faithfully (some sites may omit fields). TranscriptItem
// is the union of the former host/state.ts and ui mirror definitions (adds the
// "error" role and the `intent` field the mirror lacked). The frame members
// built on these shapes live in frames-*.ts; see index.ts for the file map.
// Event-stream position markers (stampEvent in host/state.ts): hi = host
// process instance id, seq = globally monotonic event sequence number;
// only stampEvent frames carry hi/seq (member comments mark them "stamped");
// RPC request-response frames and the handshake frame are not stamped.

/** stampEvent stamp (host/host.ts): process instance id and monotonic sequence number carried by event-stream frames */
export interface EventStamp {
  hi: string;
  seq: number;
}

// ---------- Common payload shapes ----------

/** Approval mode (host/rpc/settings.ts validates the base's four values) */
export type ApprovalMode = "yolo" | "write" | "always-ask" | "always-ask-cached";

/** Desktop env section (host/state.ts DesktopEnv) */
export interface DesktopEnv {
  httpProxy: string;
  noProxy: string;
  caCerts: string;
}

/** Settings snapshot (host/models.ts settingsSnapshot) */
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

/** ACP context compaction config object (l1/l2/l3: token counts in absolute mode, percentages of the model context window in percent mode) */
export interface AcpConfig {
  enabled: boolean;
  tierMode?: "absolute" | "percent";
  l1?: number;
  l2?: number;
  l3?: number;
  /** Protected tail: recent turns/tokens never compressed (host defaults 2 / 20000) */
  tailTurns?: number;
  tailTokens?: number;
  /** Protected tail floor: at least this many recent user messages stay uncompressed (0 = off) */
  tailUserMessages?: number;
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
  /** Probe on cadence while a permission-approval card is waiting (off by default) */
  probeDuringApproval: boolean;
  /** Probe on cadence while an ask-user card is waiting (off by default) */
  probeDuringAsk: boolean;
  /** Farewell probes still fired after the session has been read (0 = stop immediately, 1 = default) */
  readWarmups: number;
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
  /** omp-desktop.json automations.agentTools: new sessions get automations_list/automations_manage (off by default) */
  automationAgentEnabled?: boolean;
  /** omp-desktop.json automations.askTimeoutSec / approvalTimeoutSec: unattended-run dialog deadlines (seconds, 0 = forever) */
  automationDialogTimeouts?: { askSec: number; approvalSec: number };
  keepaliveEnabled: boolean;
  keepaliveConfig?: KeepaliveConfig;
  hooksEnabled: boolean;
  pluginsEnabled?: boolean;
  skillsEnabled?: boolean;
  uiConfig?: UiConfigPayload;
  // omp-desktop.json browser.external (host/browser-config.ts): desktop-owned
  // browser routing switch. Off = OMP launches the browser (relay/cdpUrl pinned
  // off on the override layer); on = the config.yml external routes apply.
  externalBrowserEnabled?: boolean;
  // omp-desktop.json computer.provider (host/computer-mode.ts): desktop-owned
  // computer-use provider pick. "kimi" reroutes the composer screen-icon toggle
  // to the code-owned kimi-cu MCP server (host/mcp-builtin.ts, never in
  // mcp.json); the flag gates the Kimi option (KimiCU installed on this machine).
  computerProvider?: "default" | "kimi";
  kimiCuInstalled?: boolean;
  // omp-desktop.json computer.defaultEnabled: fresh sessions start with computer use on
  // (spawn-time read; sessions already on disk keep their state)
  computerDefaultEnabled?: boolean;
  // omp-desktop.json kimi.autoThinking (host/kimi-thinking.ts): whether Kimi
  // models are offered the `auto` thinking level. Off by default — each level
  // switch re-bills the whole prefix on Kimi; the providers-page switch.
  kimiAutoThinking?: boolean;
  // omp-desktop.json autoReview.enabled (host/auto-review.ts): LLM tool-approval
  // gate in uiCtx.select — low/medium verdicts approve unseen, deny/unavailable
  // still show the human card. Written by the permission-mode menu.
  autoReviewEnabled?: boolean;
  // omp-desktop.json autoReview.offerSmartMode (host/auto-review.ts): whether the
  // permission-mode menu offers the "smart approval" row. Experimental page
  // switch; independent of the gate above. Unset falls back to it.
  autoReviewOfferMode?: boolean;
  // omp-desktop.json sessionTitles.refresh (host/session-titles.ts): regenerate
  // the title after every settled turn (tiny-model call per turn; user-pinned
  // titles are never overwritten). Experimental page switch.
  sessionTitleRefresh?: boolean;
  // omp-desktop.json sessionTitles.branchTitles (host/session-titles.ts): journal
  // each title as a branchTitle custom entry on the active branch and mirror the
  // branch's own title into the header on branch switch. Experimental page switch.
  branchTitles?: boolean;
  // omp-desktop.json remote section (host/remote.ts): LAN remote-control
  // server config; the settings page's remote group reads/builds URLs from it
  remote?: RemoteConfigPayload;
};

/** omp-desktop.json remote-section projection (host/remote.ts remotePayload) — LAN remote-control server config */
export interface RemoteConfigPayload {
  enabled: boolean;
  port: number;
  /** 128-bit hex access key, full value (the settings page builds the copy-link URL from it) */
  key: string;
  /** Show the session stats bar on narrow (phone) clients (default off) */
  mobileStatsBar: boolean;
  /** Prebuilt http://<first LAN IPv4>:<port>/?t=<key>; omitted when no LAN IPv4 is available */
  url?: string;
  /** Visiting devices (host/remote.ts RemoteDeviceRecord), newest first; omitted when empty */
  devices?: RemoteDeviceEntry[];
}

/** One historical remote visitor shown on the settings page's device-history card */
export interface RemoteDeviceEntry {
  name: string;
  ip: string;
  /** Epoch ms of the most recent visit */
  lastAt: number;
}

/** Model catalog entry (host/models.ts modelsPayload) */
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

/** Defaults for new-session config (host/models.ts modelsDefaults) */
export interface ModelsDefaults {
  defaultModel: string | null;
  defaultThinking: string | null;
}

/** Model catalog entry, models-management page view (host/models.ts modelCatalog) */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  // Catalog kind from host modelCatalog (chat/tiny/image/search/tts/stt/judge); the
  // settings roles view filters kind-role candidate menus by it
  kind: string;
  enabled: boolean;
  context: number | null;
  vision: boolean;
  efforts: string[] | null; // same TODO as ModelEntry.efforts
  authSource: "config" | "cred";
  // Stored credentials exist (host authStorage): gates the logout button and
  // account rows, independent of authSource — a models.yml provider may
  // still carry an OAuth login
  cred?: boolean;
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
  /** "chat" | "kind" per the base's role metadata; kind roles render on the capability page */
  section?: string;
}

/** Capability engine key entry (host/models.ts capabilityKeysPayload: web-search engines + judge backend) */
export interface CapabilityKeyEntry {
  id: string;
  label: string;
  envVar: string;
  /** a key resolves now (stored credential or env alias) */
  configured: boolean;
  /** a removable stored credential exists (env-var-only config cannot be cleared here) */
  stored: boolean;
}

/** Capability keys frame (host get_capability_keys / pushed after key mutations) */
export interface CapabilityKeysFrame {
  type: "capability_keys";
  keys: CapabilityKeyEntry[];
  /** one of the SDK's built-in roles vs a user-defined custom role */
  builtin: boolean;
}

/** Search engine availability frame (host get_search_availability): per catalog id
 * ("web/<engine>") whether the engine is selectable now — the base's explicit-availability
 * predicate (key configured / free public engine / local instance). Drives the flat
 * candidate list of the special-features web-search picker; null in the store = not fetched. */
export interface SearchAvailabilityFrame {
  type: "search_availability";
  availability: Record<string, boolean>;
}

/** Provider list entry (host/host.ts: {id,label} from listAllProviders + login/accounts) */
export interface AllProviderEntry {
  id: string;
  label: string;
  login: boolean; // has a real auth flow (oauth-code/device-code/custom)
  accounts: number; // number of active credentials in authStorage
}

/** Slash command entry (host/host.ts sendCommandsFrame) */
export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  hint: string | null;
  // TODO(narrowing pass): source comes from base InternalAvailableSlashCommand.source (builtin/extension/custom/skill etc.)
  source: string;
  subcommands: { name: string; description: string; usage: string | null }[];
}

/** @ file candidate (host/host.ts listFileMatches) */
export interface FileMatch {
  path: string;
  dir: boolean;
}

/** Single-level directory entry (host/host.ts list_dir) */
export interface DirEntry {
  name: string;
  dir: boolean;
}

/** git status row (host/host.ts get_git_diff) */
export interface GitStatusFile {
  /** Raw two-column porcelain XY, untrimmed: "??" untracked, " M" worktree-only, "UU" conflict. */
  code: string;
  path: string;
  /** porcelain v2 `2 ` record: where a rename came from. */
  origPath?: string;
  staged: string; // empty string = none
  unstaged: string; // empty string = none
  /** Unmerged entry (UU/AA/DD/AU/UD/UA/DU): stage/unstage are refused on it. */
  conflict?: boolean;
  /** Lockfile, minified/compiled output, dependency dir, or a "@generated" header. */
  generated: boolean;
  /** Content fingerprint for the "seen" marker; empty when unchanged or unhashable. */
  fingerprint: string;
}

/**
 * Mutating operation the repository is mid-way through (host/git.ts
 * operationState). NORMAL means nothing is in flight.
 */
export type GitOperationState =
  | "NORMAL"
  | "REBASE"
  | "MERGE"
  | "CHERRY_PICK"
  | "REVERT"
  | "DETACHED_HEAD";

/** Cross-file branch-family node (host/host.ts get_session_tree) */
export interface SessionBranch {
  sessionId: string;
  path: string;
  title: string | null;
  modified: string; // ISO
  parentSession: string | null;
  isCurrent: boolean;
  messageCount: number;
}

/** On-disk session row (sessions mapping of handleListSessions, host/host.ts) */
export interface DiskSessionRow {
  id: string;
  path: string;
  title: string | null;
  firstMessage: string; // truncated to 80 chars
  modified: string; // ISO
  messageCount: number;
  archived: boolean;
  /** Pool fallback row (session not yet persisted to disk): id is the host pool UUID, not a real disk session id */
  pending?: boolean;
  /** Set when the host spawned this session for an automation (sidebar clock badge) */
  automation?: { id: string; title: string };
}

/** Project grouping (projects mapping of handleListSessions, host/host.ts) */
export interface DiskProject {
  cwd: string;
  /** Remote SSH workspace stub: project row shows host:path and the cloud icon */
  remote?: boolean;
  remoteLabel?: string;
  sessions: DiskSessionRow[];
}

/** Entry tree node (host/translate.ts EntryTreeNode) */
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

/** Quota window section (host/limits/index.ts LimitWindow) */
export interface LimitWindow {
  kind: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  resetDescription?: string;
}

/** Balance section (host/limits/index.ts LimitBalance) */
export interface LimitBalance {
  amount: number | null;
  currency?: string;
}

/** Multi-account quota entry (provider_limits_result.accounts mapping, host/host.ts) */
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

/** Usage stats (host/stats.ts collectUsageStats) */
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

/** Goal state (inner payload of the goal frame, host/host.ts pushGoal) */
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

/** Token usage of the current LLM turn (host/state.ts TurnUsage) */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** On-wire shape of session entries (element of the messages frame; host/state.ts
 * re-exports this type, as does the UI-facing ui-src/types/frames.ts shim) */
export type TranscriptItem = {
  role: "user" | "assistant" | "tool" | "thinking" | "loop" | "bash" | "mention" | "phase" | "error" | "advisor" | "ttsr";
  text: string;
  name?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  // Model-written `i` intent, extracted by the agent loop and stripped from args;
  // the wait row's only "parameter" (carried by host/state.ts, missing from the
  // former ui mirror — merged here as the field superset)
  intent?: string;
  files?: string[];
  added?: number;
  removed?: number;
  diffContent?: string;
  todo?: { content: string; done: number; total: number };
  thinking?: string;
  expandable?: boolean;
  output?: string;
  // TODO(narrowing pass): details is runtime metadata for tools like read/hub (read rows read details.isDirectory); shape follows the base.
  // `any` (the host/state.ts original) rather than the mirror's `unknown`: UI render sites read
  // payload-specific properties off it behind their own narrow casts
  details?: any;
  collapsed?: boolean;
  items?: TranscriptItem[];
  durationSec?: number | null;
  usage?: TurnUsage | null;
  entryId?: string;
  endMs?: number;
  // Turn-final assistant text (stopReason "stop" on disk): a delivered output, not
  // process narration — seal paths lift it out of the collapsed loop group
  turnFinal?: boolean;
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
  /** Set on a user row the scheduler delivered into this session (automation run), never on typed input */
  automation?: { id: string; title: string };
  // ---- advisor rows (role "advisor": one delivered advice batch, position = injection point) ----
  notes?: AdvisorNote[];
  // ---- ttsr rows (role "ttsr": which rules a TTSR rewound-and-injected at this point) ----
  rules?: TtsrRule[];
};

/** One TTSR rule behind an injection notice (base Rule, narrowed to the fields a row shows) */
export interface TtsrRule {
  name: string;
  /** Rule description, falling back to its body (same choice as the TUI notice) */
  description?: string;
}

/** One advisory note (base pi-tui `AdvisorNote`, advisor/advise-tool.ts) */
export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
  note: string;
  severity?: AdvisorSeverity;
  /** Named advisor that produced the note; absent for the default advisor */
  advisor?: string;
  /** Primary turns elapsed before the batched delivery */
  turnsAgo?: number;
}

/** Queued message view element (host/host.ts sendQueued, via base toRestoredQueuedMessage) */
export interface QueuedMessage {
  text: string;
  /** Image attachments carried by the queued prompt (base ImageContent; same shape as UserItem.images) */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

/** Narrow event-stream event (host/translate.ts UiEvent; kind-discriminated body of event/subagent_event frames) */
export type UiEvent =
  | { kind: "turn_start" }
  | { kind: "user_message"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; automation?: { id: string; title: string } } // host-side prompt echo: every attached UI draws the bubble (cross-channel send); automation variant has no local composer send
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
  | { kind: "tool_details"; name: string; toolCallId?: string; details?: unknown } // in-flight refresh from a returned async tool (task spawn progress); carries no terminal semantics
  | { kind: "turn_end"; usage?: TurnUsage | null; userEntryId?: string; assistantEntryId?: string; runEnd?: boolean; final?: boolean } // final: this turn ended stopReason "stop" — its settled text is a delivered output (loop-group lift marker)
  | { kind: "thinking_level"; configured?: string; resolved?: string }
  | { kind: "mention"; files: string[] }
  | { kind: "advisor"; notes: AdvisorNote[] } // one delivered advice batch (base customType "advisor"); rendered at its injection point
  | { kind: "ttsr"; rules: TtsrRule[] } // a TTSR rewind injected these rules here (read-only row; base event ttsr_triggered)
  | { kind: "error"; text: string }; // provider/request failure (quota, auth, transport): rendered as a standalone row

/** Whole-session stats (expanded fields of the session_stats frame, host/session-lifecycle.ts buildSessionStats) */
export interface SessionStatsPayload {
  // TODO(narrowing pass): tokens is the cumulative bucketing of base
  // SessionManager.getUsageStatistics (input/output/cacheRead/cacheWrite); follows the SDK
  tokens: Record<string, number>;
  cost: number;
  /** Portion of {@link cost} the base already folded in from completed `task` results
      (blocking spawns only — base UsageStatistics.subagentCost). The stats bar subtracts its
      overlap with the live children it also shows, so a blocking child is billed once. */
  subagentCost?: number;
  cacheHitRate: number;
  /** Prompt-cache invalidation count for the session (host/session-lifecycle.ts buildSessionStats) */
  cacheBreaks: number;
  /** Uncached input tokens the most recent break re-billed (host/session-snapshot.ts scanCacheBreaks).
      The stats bar flashes this for 3s in place of the row; 0 when no break happened yet. */
  cacheMissTokens: number;
  /** USD list price of {@link cacheMissTokens}; absent when the model catalog has no input rate. */
  cacheMissUsd?: number;
  /** Context compactions this session ran (base compaction entries + ACP compaction blocks).
      Their cacheRead drop is excluded from {@link cacheBreaks} (host/session-snapshot.ts countCacheBreaks). */
  compactions: number;
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

/** Context-detail breakdown (context_detail frame, host/rpc/limits.ts get_context_detail) */
// TODO(narrowing pass): breakdown is the base getContextBreakdown() expansion + the host's
// derived buckets; the SDK fields keep following the core package
export type ContextBreakdown = Record<string, unknown> & {
  /** MCP schema tokens carried in the request's tools array (tools.xdev off). */
  mcpToolsTokens: number;
  /** Device-mounted MCP cost that moved into prompt text: inlined docs (block 0), subtracted from systemPromptTokens. */
  mcpPromptTokens: number;
  /** Device-mounted MCP cost that moved into prompt text: the device catalog (blocks 1+), subtracted from the system-context bucket. */
  mcpContextTokens: number;
  /** Tokens of the <repo-rules> region (AGENTS.md / CLAUDE.md), split out of systemContextTokens. */
  repoRulesTokens: number;
  /** Tokens of the memory guidance block, split out of systemContextTokens. */
  memoryTokens: number;
  /** systemContextTokens minus the regions above: the genuine remainder. */
  otherTokens: number;
  /**
   * ACP dual-zone split (present only while ACP compaction is active on this session, and
   * only after its runtime has projected a request): the compressed-zone and active-zone
   * token shares the request actually carries. The card splits its messages row along them.
   */
  acp?: { zoneTokens: number; activeTokens: number };
};

/** Inner stats of the context_detail frame (host/host.ts) */
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

/** agent_assets frame payload (host/assets.ts listAgentAssets; section elements keep their on-disk scan shape) */
// TODO(narrowing pass): per-field shape of the skills section is decided by the internal scan in assets.ts; unknown for now (McpPage/SkillsPage narrow it on actual reads)
/** MCP assets payload (host/assets.ts; servers elements are host McpServerItem, scopes are scope groupings) */
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
    /** Source file is not an mcp.json this app writes for the scope (plugin package, another tool's config): toggle only */
    readOnly: boolean;
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
  event?: string;
  tool?: string;
  scope?: "profile" | "project" | string;
  cwd?: string;
  projectName?: string;
  enabled?: boolean;
}

export interface PluginContentItem {
  name: string;
  description?: string;
}

/** What a plugin package contributes (host/assets.ts scanPluginContents): manifest-declared
 * entries plus the conventional sibling dirs the base's omp-plugins provider scans. */
export interface PluginContents {
  extensions: PluginContentItem[];
  tools: PluginContentItem[];
  commands: PluginContentItem[];
  skills: PluginContentItem[];
  rules: PluginContentItem[];
  prompts: PluginContentItem[];
  hooks: PluginContentItem[];
  mcp: PluginContentItem[];
}

export interface PluginAssetItem {
  name: string;
  /** node_modules package key (dir name, "@scope/name" for scoped) — toggle addressing */
  key?: string;
  version?: string;
  path?: string;
  /** Symlink-resolved package root (marketplace installs symlink node_modules into the cache dir; extension-center entry paths use the resolved root) */
  realPath?: string;
  scope?: string;
  enabled?: boolean;
  description?: string;
  contents?: PluginContents;
}

/** Plugins payload (host/assets.ts loadPluginsScoped): per-scope sections like skills */
export interface PluginAssetsPayload {
  profile: PluginAssetItem[];
  projects: { cwd: string; name: string; dir: string; plugins: PluginAssetItem[] }[];
  profileDir: string;
  profileName?: string;
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
  plugins: PluginAssetsPayload;
  flags: { enableMCP: boolean; disableExtensionDiscovery: boolean; computerEnabled: boolean };
}

/** Asset kind (host/assets.ts AssetKind) */
export type AssetKind = "agent" | "skill" | "mcp" | "hook";

/** Prompt attachment (UI → host; host/host.ts PromptAttachment, sent by the UI along with the prompt) */
export interface PromptAttachment {
  kind: "image" | "text";
  mime?: string; // image: base64 (no data: prefix)
  name?: string; // text: file name
  text?: string; // text: file content
  data?: string;
}
