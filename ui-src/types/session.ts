// Session-entry discriminated union + the openSessions container + shape types for the global store S.
// Entry fields follow what components/chat/items.tsx actually reads at its appendItem/renderItems dispatch
// (items.tsx:21-69 per-role dispatch, :87 pending steer, :95-131 merged-group pseudo entries);
// on-wire shape is anchored to host/state.ts TranscriptItem (messages frame, see ./frames);
// meta/err are frontend-local entries (pushed by store.ts, never through the host).
// Mutable expansion flags (expanded/branching/cmdExpanded/diffExpanded/readExpanded etc.)
// are written in place onto entry objects by components (reference-stable, preserved across full redraws),
// hence all declared optional and writable.

import type {
  ContextDetailFrame,
  FileMatch,
  GoalState,
  KeepaliveStatusFrame,
  LimitsResultFrame,
  LoginPromptFrame,
  ModelCatalogEntry,
  ModelRoleEntry,
  AllProviderEntry,
  AssetFileFrame,
  PromptAttachment,
  ProviderLimitsResultFrame,
  ProviderAccountsFrame,
  QueuedMessage,
  SessionStatsPayload,
  SettingsPayload,
  SlashCommand,
  TodoPhase,
  TurnUsage,
  UsageStats,
  AgentAssetsPayload,
  DiskSessionRow,
  ApprovalMode,
} from "./frames";
// SchemaDef is the authoritative shape of settings schema entries (aligned with SETTINGS_SCHEMA), defined in settings/placement.ts
import type { SchemaDef } from "./settings";

// ---------- Tool args/details (points read by items.tsx via util.ts predicates; field list merged from P2-C chat-types.ts) ----------

/** Structured questions parameter of the ask tool (read by ApprovalCard / question rows);
    id is the ask-dialog correlation key echoed back in the merged answer (wire-required, optional
    locally for tool-args rows the host builds without ids) */
export interface AskQuestion {
  id?: string;
  question?: string;
  multi?: boolean;
  header?: string;
  recommended?: number;
  options?: { label?: string; description?: string }[];
}

/** Tool args: parameter JSON passed through by host tool frames. Only fields this repo actually reads
    are constrained (typed per the host protocol); other keys pass through as unknown via the index signature */
export interface ToolArgs {
  path?: string; // device-group check at items.tsx:115-118 (isDeviceEvent → args?.path)
  files?: string[];
  command?: string;
  pattern?: string;
  // device-call JSON string (parsed at runtime by deviceCmd), shape not fixed
  content?: unknown;
  op?: string;
  name?: string;
  application?: string;
  // hub application argument list
  args?: unknown[];
  text?: string;
  task?: string;
  i?: string;
  query?: string;
  memory?: string;
  id?: string;
  action?: string;
  program?: string;
  file?: string;
  line?: number;
  repo?: string;
  title?: string;
  pr?: string;
  symbol?: string;
  new_name?: string;
  memories?: { content?: string }[];
  questions?: (AskQuestion | null)[];
  [key: string]: unknown;
}

/** Tool reply details: host structured data. Only fields this repo actually reads are constrained; the rest pass through */
export interface ToolDetails {
  isDirectory?: boolean; // read-group check at items.tsx:103-106 (isReadEvent → details?.isDirectory)
  resolvedPath?: string; // read by parts.tsx openReadFileInSidebar
  displayContent?: {
    // read by parts.tsx openReadFileInSidebar (excerpt content shown inline on read rows)
    text?: string;
    startLine?: number;
    lineNumbers?: number[] | null;
  };
  shownRange?: { start: number; end: number }; // truncated read: lines actually shown (meta.truncation.shownRange via the host)
  summary?: { lines: number; elidedSpans?: number; elidedLines?: number }; // summarized read: shown line count with elided spans
  [key: string]: unknown;
}

// ---------- Session-entry discriminated union ----------

/** User message (items.tsx:21-23 reads text; :87 reads pending === "steer" to collect bubbles awaiting consumption) */
export interface UserItem {
  role: "user";
  text: string;
  pending?: string | null; // "steer" = sent mid-stream, awaiting consumption (landed by store.ts)
  steerDone?: boolean; // consumed-done marker (written by store.ts)
  entryId?: string; // persisted entry id (fork targeting for branch_session; host TranscriptItem.entryId)
  images?: Array<{ type: "image"; data: string; mimeType: string }>; // image attachments
}

/** Assistant message (items.tsx:25-28 reads text; junk placeholders are not rendered) */
export interface AssistantItem {
  role: "assistant";
  text: string;
  entryId?: string; // tail fork anchor of the output (backfilled from host turn_end.assistantEntryId)
  endMs?: number; // end timestamp of this turn
  branching?: boolean; // fork request in flight (written in place by TurnActs)
  streaming?: boolean; // generating (written in place by components)
}

/** Thinking row (items.tsx:30-33 reads item.thinking || item.text) */
export interface ThinkingItem {
  role: "thinking";
  text: string;
  thinking?: string; // thinking body (preferred when separate from text)
  expandable?: boolean; // expandable (has a full thinking block)
  expanded?: boolean; // expanded state (written in place by components)
  streaming?: boolean; // thinking in progress (written in place by store.ts: thinking_delta locates its accumulation target via this)
}

/** Tool row (items.tsx:35-37 passes the whole entry to ToolRow; :95-131 merged-group pseudo entry { role:"tool", text, name?, group }) */
export interface ToolItem {
  role: "tool";
  text: string;
  name?: string; // merged-group pseudo entries tag "read"/"device"/"cmd" for toolKind dispatch (items.tsx:106/118/129)
  toolCallId?: string;
  args?: ToolArgs;
  files?: string[];
  details?: ToolDetails;
  group?: ChatItem[]; // member entries collected by a merged group (changes/reads/terminal/device) (all tool entries at runtime)
  output?: string;
  added?: number;
  removed?: number;
  running?: boolean; // executing (landed by store.ts: set by tool frames, reset by tool_update; clearRunningTools as fallback)
  todo?: { content?: string; total?: number; done?: number };
  diffContent?: string;
  streaming?: boolean; // executing (written in place by components)
  cmdExpanded?: boolean; // terminal output expanded (written in place by components)
  diffExpanded?: boolean; // diff expanded (written in place by components)
  readExpanded?: boolean; // read content expanded (written in place by components)

}

/** Loop group (items.tsx:39-42 passes the whole entry to LoopGroup; collects this turn's process entries) */
export interface LoopItem {
  role: "loop";
  text: string;
  items?: ChatItem[]; // this turn's process (thinking/tool/intermediate assistant)
  collapsed?: boolean; // collapsed by default; expanded state toggled by the frontend
  durationSec?: number | null;
  usage?: TurnUsage | null;
}

/** Local bash row (! prefix; items.tsx:44-46 reads text) */
export interface BashItem {
  role: "bash";
  text: string; // original command text
  output?: string; // output text (after truncation)
  running?: boolean; // between bash_start and bash_done
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean; // !! prefix
  error?: string | null; // execution failure message
  cmdExpanded?: boolean; // output expanded (written in place by components)
}

/** @ mention read-back row (items.tsx:48-50 reads item.files) */
export interface MentionItem {
  role: "mention";
  text: string; // always "" on the wire (pushed directly by the host attachEntry scan)
  files?: string[];
}

/** Centered text row (items.tsx:52-55 reads text; frontend-local entry, never through the host) */
export interface MetaItem {
  role: "meta";
  text: string;
  command?: string; // typed slash-command line that produced this output: renders as an expandable command card (CommandRow)
  cmdExpanded?: boolean; // card body expand state (defaults true: a command's output is the answer the user asked for, unlike incidental bash output)
}

/** Phase separator row (items.tsx:57-65 reads text; compact/handoff/rename) */
export interface PhaseItem {
  role: "phase";
  text: string;
  phase?: "start" | "done"; // start only comes from transient frames; everything replayed from disk is done
  command?: string; // compact/handoff/rename: start and done rows are matched and absorbed by this
}

/** Error row (items.tsx:67-69 fallback branch reads text; frontend-local entry, never through the host.
    role "error" matches the value landed by the store.ts error frame; SessionRow also detects the session error state by this) */
export interface ErrItem {
  role: "error";
  text: string;
}

/** Session-entry discriminated union (discriminated by role literals; consumed branch by branch by items.tsx appendItem) */
export type ChatItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | LoopItem
  | BashItem
  | MentionItem
  | MetaItem
  | PhaseItem
  | ErrItem;

/** Compatibility alias: the entry type name used in the store.ts batch (to be unified as ChatItem after the narrowing rewiring) */
export type SessionItem = ChatItem;

/** Message rail ticks (each railEntries.push site in items.tsx; MsgRail locates DOM nodes by key) */
export interface RailEntry {
  key: string; // same origin as the data-fk anchor
  role: string; // "user" | "assistant" | "thinking" | "tool" | "meta" | "bash" | "mention" | "err"
  text: string;
}

// ---------- openSessions container ----------

/** Pending approval (landed by store.ts:991-998 approval_request; consumed by ApprovalCard) */
export interface PendingApproval {
  requestId: string;
  title: string;
  options: string[]; // editor/plan variants use stable ids (submit/cancel/plan:execute/plan:compact/plan:keep/plan:refine/plan:save-quit)
  // Live context usage for the plan-approval keep-context row (raw numbers; the
  // UI localizes the "Approve and keep context (~44k / 1m)" label).
  keepContextTokens?: { tokens: number; contextWindow: number };
  // Row indices the operator may not pick (plan approval disables keep-context
  // once the context is nearly full).
  disabledIndices?: number[];
  // Execution-model tier slider rendered above the plan options; the picked
  // index travels back in the approval_response `sliderIndex` field.
  slider?: { caption: string; index: number; segments: { label: string; detail: string }[] };
  sliderIndex?: number;
  editable: boolean;
  editableIndex?: number; // index of the editable input row within options (editor-variant protocol field)
  prefill: string;
  // Ask-dialog variant only (18.5 uiCtx.askDialog): the merged multi-question
  // form; ApprovalCard renders radio/checkbox rows and one submit for all
  questions?: AskQuestion[];
  // Ask-dialog variant only: frontend-local drafts of the per-question
  // "Other (type your own)" custom answers (written in place by ApprovalCard
  // like prefill, never sent as a frame field of its own)
  otherDrafts?: string[];
  answer: string | null; // user's chosen answer; null = pending
}

/** Subagent tool-call row (accumulated by store.ts subagent_event) */
export interface SubagentToolCall {
  name: string;
  args?: unknown;
  files?: string[];
  toolCallId?: string;
  running: boolean;
  added?: number;
  removed?: number;
  todo?: unknown;
  output?: string;
  details?: unknown;
  diffContent?: string;
  at?: number; // frontend arrival timestamp (Recent activity clock)
}

/** Subagent aggregated usage (landed by store.ts subagent_progress) */
export interface SubagentUsage {
  cost?: number;
  durationMs?: number;
  requests?: number;
  toolCount?: number;
  tokens?: Record<string, number>; // host normalizes the base's plain cumulative number to { total }
  contextTokens?: number;
  contextWindow?: number;
  currentTool?: string;
  currentToolArgs?: unknown;
  currentToolStartMs?: number;
  lastIntent?: string;
  resolvedModel?: string;
  resolvedThinkingLevel?: string;
  recentTools?: unknown[];
}

/** Subagent runtime state (landed by store.ts subagent_lifecycle + accumulated by progress/event) */
export interface SubagentState {
  agent: string;
  description: string;
  status: string;
  name?: string;
  parent?: string;
  registeredAt?: number;
  sessionFile?: string | null; // child transcript file (Lineage/Output path)
  readOnly?: boolean; // child session_init.readOnly, host-recovered (Agent Hub Changes line)
  advisor?: boolean; // advisor transcript (__advisor stem), host-derived like the TUI registry kind
  task?: string; // latest task text from progress frames (fallback when lifecycle description is empty)
  text: string; // accumulated subagent text deltas
  tools: SubagentToolCall[];
  streaming: boolean;
  usage?: SubagentUsage;
}

/** An opened session (openSessions container value; created by store.ts openSessions.set(msg.path, {...}),
    later fields are written at runtime by frame handling / component interaction, not necessarily present at creation) */
export interface OpenSession {
  sessionId: string;
  cwd: string;
  items: ChatItem[];
  pendingApprovals?: PendingApproval[];
  assistantDraft: string;
  streaming: boolean;
  turnStartAt?: number | null;
  turnItemStart?: number | null; // entry start index of this turn (used by sealRunItems)
  workingText?: string | null; // activity indicator text (busy / thinking / intent)
  subagents: Map<string, SubagentState>;
  model: string | null;
  thinking: string;
  isGit: boolean;
  todos: TodoPhase[];
  goal?: GoalState | null; // set by the goal frame
  planMode?: boolean; // set by the plan_mode frame
  queued?: QueuedMessage[]; // landed from the queued frame's followUp
  steering?: QueuedMessage[]; // landed from the queued frame's steering
  externalWrite?: boolean; // the host detected writes from an external process
  autoResolved?: string; // effective resolved value when the thinking_level frame has configured === "auto"
  ctx?: { tokens: number; window: number; percent: number }; // landed from the context frame
  stats?: SessionStatsPayload; // landed from the session_stats frame
  title?: string | null; // session title (from session_title_changed, or carried in at creation)
  isSubagent?: boolean;
  parentPath?: string;
}

/** openSessions container: key = session file path (store.ts openSessions; LRU cap of 8) */
export type OpenSessions = Map<string, OpenSession>;

// ---------- Global store S ----------

/** file_view file-page view state (completed by the store from file_content frame replies; constructed in place by FilePage/parts.tsx).
    Not a subset of FileContentFrame: frontend-local state (reqRange/image/full) mixes with frame fields, hence declared standalone */
export interface FileViewState {
  path: string;
  text?: string; // content read so far (excerpt or full file)
  error?: string | null; // read failure message
  startLine: number; // full-file line number of the first line of text
  lineNumbers: (number | null)[] | null; // excerpt line-number list (for line-number highlighting; null elements = hole lines omitted by the tool); null for a full file
  full?: boolean; // already the full file (set by a file_content reply)
  reqRange: [number, number] | null; // requested line range (parsed from the path:59-123 selector)
  image?: boolean; // image preview branch (read_image replies go through rightState.imageContent)
}

/** Memory file state (store.ts memory_file frame; status: idle/loading/done/error) */
export interface MemoryDetailState {
  base: string | null;
  files: string[] | null;
  rollouts: string[];
  active: { name: string; rollout: boolean } | null;
  status: string;
  content: string;
  error: string | null;
}

/** Shape of the global state S (declared as S in store.ts; field names match core.js) */
export interface AppState {
  activePath: string | null;
  selectedSubagent: string | null;
  ws: WebSocket | null;
  pendingCreate: boolean;
  hostSettings: SettingsPayload | null;
  settingsSchema: Record<string, SchemaDef> | null; // SettingsSchemaFrame["schema"]; entry shape matches SETTINGS_SCHEMA
  modelCatalog: ModelCatalogEntry[];
  selectedProvider: string | null;
  mpAddView: boolean;
  mpRolesView: boolean;
  mpCycleView: boolean; // ctrl+p quick-switch cycle-order editor (left-column subpage under model roles)
  modelRoles: ModelRoleEntry[] | null;
  mpDetailProv: AllProviderEntry | null; // current provider on the provider detail page (written by card clicks)
  allProvidersCache: AllProviderEntry[] | null;
  loginBusy: boolean;
  agentAssets: AgentAssetsPayload | null;
  usageStats: UsageStats | null;
  isCreatingNew: boolean;
  newSessionProject: string;
  newSessionBranch: string;
  newSessionBranches: string[]; // landed from the git_branches frame's branches (branch picker on the new-session page; list of branch names)
  newSessionIsGit: boolean;
  newSessionModel: string;
  newSessionThinking: string;
  defaultModelCfg: string | null; // landed from the models frame's defaultModel
  defaultThinkingCfg: string | null; // landed from the models frame's defaultThinking
  newSessionDirty: boolean;
  pendingNewPrompt: { text: string; files: PromptAttachment[] } | null;
  pendingFiles: (PromptAttachment & { id: number })[]; // composer attachment chips (carry a frontend-local id, stripped on send)
  fileSeq: number;
  viewMode: string; // "project" | … (sidebar view)
  isProjectManageMode: boolean;
  allProjects: string[];
  removedProjects: string[];
  defaultWorkspace: string; // app-owned backing dir for "work without a project"
  archivedSessions: (DiskSessionRow & { cwd: string })[];
  animateGdKids: boolean;
  animateThinkBody: boolean;
  animateSubKids?: boolean; // subagent detail entrance-animation flag (attached at runtime, SubagentPage only)
  todoCollapsed: boolean;
  gitViewMode: string; // "tree" | … (right-panel Git Diff view)
  selectedFile: string | null;
  fileView: FileViewState | null;
  fileViewPending: string | null; // file path with a request in flight
  briefDiffPending: string | null; // inline-diff path with a request in flight
  rightTab: string | null;
  zoomLevel: number;
  approvalMode: ApprovalMode;
  loginReqId: number;
  evtHost: string | null; // host process instance id (ready.hi / stamped event .hi); a change means the host restarted
  evtSeq: number; // highest applied event sequence number under this instance (events behind the position are dropped outright)
  // ---- UI state added in the React port (previously scattered across DOM classes / local variables) ----
  connected: boolean;
  connText: string;
  toastMsg: string | null; // current toast text (null = hidden)
  composerSetSignal: { text: string; images: unknown[] | null; seq: number } | null; // signal to fill the composer externally (fork backfill / queued-message editing)
  findOpen: boolean; // in-session find bar open state (kept in sync by FindBar; guard before Esc interrupts generation)
  menuSignal: { name: string; seq: number } | null; // signal to open the composer menu externally (shortcut Alt+M)
  draftHasContent: boolean; // whether the composer has a draft (synced on every Composer render, used for the Esc double-confirm)
  escArmedUntil: number; // deadline of the Esc double-confirm window (> now = the send button shows a cancel icon)
  // ---- Composer sigil completion state ----
  commands: SlashCommand[] | null; // slash command list of the current session (null = not fetched yet, the popover shows loading)
  commandsSessionId: string | null; // session id the list belongs to; invalidated on session switch
  mentionReqSeq: number; // list_files request counter (reqId generator, frontend-incremented)
  mentionResult: { reqId: number; matches: FileMatch[] } | null; // latest @ candidates response; stale as soon as the reqId no longer matches
  sidebarCollapsed: boolean;
  rightCollapsed: boolean;
  mainViewMode: "chat" | "tree"; // main-area view mode (message stream vs session entry tree)
  // ---- Settings center ----
  settingsOpen: boolean; // fullscreen overlay open state
  settingsPage: string; // current settings page id
  providerLimits: ProviderLimitsResultFrame | null;
  providerAccounts: ProviderAccountsFrame | null;
  loginBanner: string | null; // OMP login progress banner text
  loginPromptData: LoginPromptFrame | null; // login_prompt paste-code dialog data
  assetFile: AssetFileFrame | null; // asset_file reply (skills/agents editors filter by kind)
  assetFileSaved: { kind: string; at: number } | null; // landed from asset_file_saved (reference change drives the "saved" indicator)
  assetSaved: { kind: string; at: number } | null; // same as above, consumed by the agents page
  assetErr: { kind: string; message: string; at: number } | null; // landed when the error frame carries kind
  mcpTestResults: Record<string, { status: string; error?: string; log?: string; ts: number }>; // per-server MCP test results: name -> { status, error?, log?, ts }
  memoryDetail: MemoryDetailState; // landed from the memory_file frame
  // ---- ringpop popover transient data (hover context-ring detail card; discard-on-leave, cleared and re-requested on the next hover) ----
  ctxDetail: ContextDetailFrame | null;
  ctxLimits: LimitsResultFrame | null;
  keepaliveStatus: KeepaliveStatusFrame | null;
}
