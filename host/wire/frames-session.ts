// Session/git/bash/approval frame members of the wire contract (A10).
// Split out of the former single ui-src/types/frames.ts mirror; shared payload
// shapes live in payloads.ts, the HostFrame union in index.ts.
import type {
  ApprovalMode, ContextBreakdown, ContextDetailStats, DirEntry, DiskProject, EntryTreeNode,
  FileMatch, GoalState, GitOperationState, GitStatusFile, LimitBalance, LimitWindow, LimitsAccount, ModelEntry, ModelRoleEntry,
  SessionBranch, SettingsPayload, SlashCommand, TodoPhase, TranscriptItem,
} from "./payloads";


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

/** Error frame (host/host.ts invalid JSON / 2098 unknown command / 2102 RPC failure / 1222-1227 bash busy;
    2235/2861 event-stream errors, stamped) */
export interface ErrorFrame {
  type: "error";
  message: string;
  sessionId?: string | null; // explicitly nullable at the 2102 site; always present at 1222
  kind?: string | null; // only carried by 2102 (RPC failure reply)
  hi?: string; // stamped variant (2235/2861)
  seq?: number;
}

/** Command list frame (host/host.ts sendCommandsFrame) */
export interface CommandsFrame {
  type: "commands";
  sessionId: string | null;
  commands: SlashCommand[];
}

/** Command output frame (host/host.ts pushCommandOutput / 2702 / 2752 / 2777 / 2782) */
export interface CommandOutputFrame {
  type: "command_output";
  sessionId: string;
  text: string;
  command?: string; // typed slash-command line (dispatchSlashInput senders only): the UI renders these as a command card instead of a plain meta row
}

/** Command consumed-result frame (host/host.ts / 2713 / 2719 / 2802 / 2853) */
export interface CommandResultFrame {
  type: "command_result";
  sessionId: string;
  text: string;
  consumed: boolean; // always true (sender-side literal)
}

/** Phase separator frame for slow background commands (host/host.ts start / 2776 / 2781 fail) */
export interface CommandPhaseFrame {
  type: "command_phase";
  sessionId: string;
  phase: "start" | "fail";
  command: string; // compact/handoff/rename
  text?: string; // only carried by start (PHASE_TEXT[command][0])
}

/** Goal state frame (host/host.ts pushGoal) */
export interface GoalFrame {
  type: "goal";
  sessionId: string;
  goal: GoalState | null;
}

/** Todos list frame (host/host.ts pushTodos stamped / 1275 get_todos unstamped / 2187 stamped) */
export interface TodosFrame {
  type: "todos";
  sessionId: string;
  phases: TodoPhase[];
  hi?: string; // stamped variant
  seq?: number;
}

/** Plan deliverable snapshot (host plan-approve.ts pushPlanOutput/pushRestoredPlanOutput):
 * repopulates the todo card's output row after a frontend reload or execute-branch fork. */
export interface PlanOutputFrame {
  type: "plan_output";
  sessionId: string;
  plan: { title: string; path: string; content: string };
  hi?: string; // stamped variant
  seq?: number;
}

/** Plan mode state frame (host/host.ts pushPlanMode) */
export interface PlanModeFrame {
  type: "plan_mode";
  sessionId: string;
  enabled: boolean;
  planFilePath: string | null;
}

/** Computer-use session state frame (host/computer-mode.ts pushComputerMode) */
export interface ComputerModeFrame {
  type: "computer_mode";
  sessionId: string;
  enabled: boolean;
  /** Present when the toggle failed (kimi-cu not installed / connect failed, gate closed, prelude unavailable) — surfaced as a red toast */
  error?: string;
}

/** Session created/reused snapshot frame (host/host.ts / 2540-2551 / 2573-2584 session_created) */
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
  /** Scheduler-spawned session: register the slot but never activate/close the automations view */
  automation?: { id: string; title: string };
  background?: boolean;
  /** True while the SDK agent run is live: a UI opening a running session mid-turn
   * seeds its spinner from this (turn boundary frames alone would leave the view dark
   * until the next event lands — long tool calls emit nothing). */
  busy?: boolean;
}

/** Run-finished broadcast (session-lifecycle agent_end terminal): reaches EVERY UI
 * connection, including channels that never attached this session — they cannot see
 * the per-session turn_end frame, so without this push the sidebar's unread dot
 * (local unseenFinished set) never lights on the other side. */
export interface SessionFinishedFrame {
  type: "session_finished";
  sessionId: string;
  path: string;
}

/** Session list frame (host/host.ts handleListSessions) */
export interface SessionListFrame {
  type: "session_list";
  projects: DiskProject[];
  allProjects: string[];
  removedProjects: string[];
  expandedProjects: string[];
  pinnedSessions: string[];
  /** App-owned backing dir for "work without a project" (never in allProjects). */
  defaultWorkspace?: string;
  /** allProjects entries whose working tree carries a .git entry (gates the row's Git entry). */
  gitProjects?: string[];
}

/** Pool residency snapshot (state.ts pushPoolSnapshot): every session the host still holds in memory */
export interface PoolSessionsFrame {
  type: "pool_sessions";
  // busy = the SDK agent run is live (state.ts poolEntryBusy). Lets a channel
  // that never loaded the session (remote control watching the desktop, or
  // vice versa) render the sidebar running spinner for it.
  sessions: { id: string; path: string; cwd: string; title: string | null; busy?: boolean }[];
}

/** Sidebar full-text search hits (host/rpc/session.ts search_session_text): match inside a user prompt or agent reply */
export interface SessionTextSearchFrame {
  type: "session_text_search";
  query: string; // echo of the request; the UI drops a frame whose query no longer matches the input
  hits: {
    path: string;
    id: string;
    cwd: string;
    title: string | null;
    modified: string; // ISO
    snippet: string;
  }[];
}

/** session_unload receipt: the session left the host's in-memory pool (disk file untouched) */
export interface SessionUnloadedFrame {
  type: "session_unloaded";
  path: string;
  unloaded: boolean;
}

/** Full message snapshot frame (host/host.ts / 912 / 1031 / 2552 / 2586 / 2768 / 2868) */
export interface MessagesFrame {
  type: "messages";
  sessionId: string;
  messages: TranscriptItem[];
}

/** Session archive reply (host/host.ts) */
export interface SessionArchivedFrame {
  type: "session_archived";
  path: string; // session file path, the addressing key both branches share
  ok: boolean; // always true
  archived: boolean;
}

/** Session abort reply (host/host.ts) */
export interface SessionAbortedFrame {
  type: "session_aborted";
  sessionId: string;
  ok: boolean; // always true
}

/** Session rename reply (host/host.ts) */
export interface SessionRenamedFrame {
  type: "session_renamed";
  path: string; // session file path, the addressing key both branches share
  ok: boolean; // always true
  title: string;
}

/** Session title change push (host/host.ts listens to onSessionNameChanged) */
export interface SessionTitleChangedFrame {
  type: "session_title_changed";
  sessionId: string;
  title: string;
}

/** Manual compaction reply (host/host.ts empty session / 874 success / 876 failure) */
export interface SessionCompactedFrame {
  type: "session_compacted";
  sessionId: string;
  ok?: boolean; // success only
  error?: string; // failure only
}

/** Session fork reply (host/host.ts cancelled / 913-921 success / 926 failure) */
export interface SessionBranchedFrame {
  type: "session_branched";
  sessionId: string;
  ok: boolean;
  newSessionId?: string; // success only
  newPath?: string; // success only
  selectedText?: string; // success only
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

/** Cross-file branch-family tree reply (host/host.ts failure / 965-979 success) */
export interface SessionTreeFrame {
  type: "session_tree";
  sessionId: string;
  ok: boolean;
  branches?: SessionBranch[]; // success only
  error?: string; // failure only
}

/** In-session entry tree reply (host/host.ts get_entry_tree; ok is always true, failures go through the error frame) */
export interface EntryTreeFrame {
  type: "entry_tree";
  sessionId: string;
  ok: boolean; // always true
  leafId: string | null;
  roots: EntryTreeNode[];
}

/** In-tree navigation reply (host/host.ts / 1021 / 1025 failure / 1032-1039 success / 1042 failure) */
export interface SessionNavigatedFrame {
  type: "session_navigated";
  sessionId: string;
  ok: boolean;
  editorText?: string | null; // success only
  // TODO(narrowing pass): editorImages is the image-attachment array of the target user message; element shape follows the base
  editorImages?: unknown[] | null; // success only
  error?: string; // failure only
}

/** External-write notice frame (host/host.ts re-sent on pool reuse / 3142 detected by pollExternalWrites) */
export interface SessionExternalWriteFrame {
  type: "session_external_write";
  sessionId: string;
  // Set when the file is back to a state the manager knows (its own writes landed
  // after a rewrite shifted the poll offset): the bar comes down without a reload.
  clear?: boolean;
}

/** Single-file diff reply (host/host.ts get_file_diff) */
export interface FileDiffFrame {
  type: "file_diff";
  cwd: string;
  path: string;
  diff: string; // truncated to 500KB
}

/** File content reply (host/host.ts too large / 1123 binary / 1126 success) */
export interface FileContentFrame {
  type: "file_content";
  path: string;
  text?: string; // success only
  error?: string; // failure only
}

/** Image content reply (host/host.ts format / 1150 not a file / 1154 too large / 1158 success) */
export interface ImageContentFrame {
  type: "image_content";
  path: string;
  mime?: string; // success only
  data?: string; // success only, base64
  error?: string; // failure only
}

/** Single-level directory listing reply (host/host.ts list_dir) */
export interface DirListFrame {
  type: "dir_list";
  path: string;
  entries: DirEntry[];
}

/** @ file candidates reply (host/host.ts list_files; reqId echoed back unchanged).
 *  File-tab search replies carry target:"fileTab" so the store can route them away from the composer mention list. */
export interface FileMatchesFrame {
  type: "file_matches";
  reqId: number;
  matches: FileMatch[];
  target?: "fileTab";
}

/** ! local command start frame (host/host.ts bash_exec) */
export interface BashStartFrame {
  type: "bash_start";
  sessionId: string;
  command: string;
  excludeFromContext: boolean;
}

/** ! local command output stream frame (host/host.ts bash_chunk) */
export interface BashChunkFrame {
  type: "bash_chunk";
  sessionId: string;
  chunk: string;
}

/** ! local command done frame (host/host.ts success / 1255-1260 failure / 1269 bash_abort) */
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

/** ! bash-mode completion reply (host/rpc/bash-complete.ts): items carry the
    full token replacement text (cmd/dir/file kinds) */
export interface BashCompleteResultFrame {
  type: "bash_complete_result";
  reqId: number;
  items: Array<{ label: string; kind: "cmd" | "dir" | "file" }>;
}

/** Context detail reply (host/host.ts get_context_detail) */
export interface ContextDetailFrame {
  type: "context_detail";
  sessionId: string;
  breakdown: ContextBreakdown | null;
  stats: ContextDetailStats;
}

/** Session quota reply (host/host.ts get_limits) */
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

/** Provider quota reply (host/host.ts get_provider_limits) */
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

/** Stage reply (host/host.ts git_stage) */
export interface GitStagedFrame {
  type: "git_staged";
  cwd: string;
  ok?: boolean; // always true (on success)
  error?: string; // failure only
}

/** Unstage reply (host/host.ts git_unstage) */
export interface GitUnstagedFrame {
  type: "git_unstaged";
  cwd: string;
  ok?: boolean;
  error?: string;
}

/** Discard changes reply (host/host.ts git_discard) */
export interface GitDiscardedFrame {
  type: "git_discarded";
  cwd: string;
  ok?: boolean;
  error?: string;
}

/** Commit reply (host/host.ts / 1444 failure / 1447 success) */
export interface GitCommittedFrame {
  type: "git_committed";
  cwd: string;
  ok?: boolean;
  commit?: string; // success only, new commit sha
  error?: string; // failure only
}

/** Push reply (host/host.ts failure / 1457 success) */
export interface GitPushedFrame {
  type: "git_pushed";
  cwd: string;
  ok?: boolean;
  result?: string; // success only (stderr or stdout, whitespace stripped)
  error?: string; // failure only
}

/** Changed-files list reply (host/host.ts get_git_diff) */
export interface GitStatusFrame {
  type: "git_status";
  cwd: string;
  files: GitStatusFile[];
  /** Mutating operation in flight, so the UI can explain refused actions. */
  state?: GitOperationState;
}

/** Branch list reply (host/rpc/files.ts not a git repo / get_git_branches normal) */
export interface GitBranchesFrame {
  type: "git_branches";
  cwd: string;
  isGit: boolean;
  current: string | null;
  branches: string[];
  remotes: string[]; // remote-tracking refs, "origin/xxx" form (local refs/remotes snapshot; symbolic */HEAD dropped)
  /** HEAD is not on any branch: `current` then carries the short oid. */
  detached?: boolean;
}

/** One commit row of the Git manager graph (host/rpc/git-graph.ts). */
export interface GitGraphCommitWire {
  oid: string;
  parents: string[];
  subject: string;
  author: string;
  authorTime: number; // unix epoch seconds
  refs: string[]; // branches/tags on this commit, prefixes stripped
}

/** One changed file of a commit detail (numstat row). */
export interface GitCommitFileWire {
  path: string;
  /** Pre-rename path when the commit renamed/copied this file (numstat -z record). */
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Header fields of one commit (host/rpc/git-graph.ts git_commit_detail). */
export interface GitCommitDetailWire {
  oid: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
  body: string;
}

/** Commit graph reply (host/rpc/git-graph.ts git_graph): log rows + branch lists. */
export interface GitGraphFrame {
  type: "git_graph";
  reqId: number;
  cwd: string;
  ok: boolean;
  error?: string;
  root?: string;
  branch?: string;
  commits?: GitGraphCommitWire[];
  hasMore?: boolean;
  branches?: { local: string[]; remotes: string[]; tags: string[] };
}

/** Commit detail reply (host/rpc/git-graph.ts git_commit_detail). */
export interface GitCommitDetailFrame {
  type: "git_commit_detail";
  reqId: number;
  cwd: string;
  oid: string;
  ok: boolean;
  error?: string;
  commit?: GitCommitDetailWire;
  files?: GitCommitFileWire[];
  additions?: number;
  deletions?: number;
  commitCount?: number | null;
}

/** One file's patch inside a commit (host/rpc/git-graph.ts git_commit_file_diff). */
export interface CommitFileDiffFrame {
  type: "commit_file_diff";
  reqId: number;
  cwd: string;
  oid: string;
  path: string;
  ok: boolean;
  error?: string;
  diff?: string;
}

/** Branch switch reply (host/host.ts; failures go through the error frame) */
export interface GitBranchSwitchedFrame {
  type: "git_branch_switched";
  cwd: string;
  branch: string;
}

/** Approval mode reply (host/host.ts set_approval_mode) */
export interface ApprovalModeFrame {
  type: "approval_mode";
  mode: ApprovalMode;
}

/** Approval resolved frame (host/host.ts approval_response) */
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

/** Approval request frame (host/host.ts select stamped / 2278 confirm stamped / 2301 editor stamped) */
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
  // The ask tool's `i` intent (captured by the host from tool_execution_start);
  // not rendered by the card (dropped when the head became header-pill + question),
  // kept for wire parity with the host frame
  intent?: string;
  // Plan-approval payload: raw plan text + title + on-disk path (read before the
  // proposal turn aborts). Drives the approval card's plan body and the todo
  // card's "plan output" row; absent on every other approval variant.
  plan?: { title: string; path: string; content: string };
  hi?: string; // stamped frame
  seq?: number;
}

/** Session model reply (host/host.ts set_model / 2789-2797 notifyConfigChanged) */
export interface SessionModelFrame {
  type: "session_model";
  sessionId: string;
  model: string | null;
  thinking: string;
}

/** Session thinking level reply (host/host.ts set_thinking) */
export interface SessionThinkingFrame {
  type: "session_thinking";
  sessionId: string;
  level: string;
}
