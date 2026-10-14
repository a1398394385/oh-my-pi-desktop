// Live-stream frame members of the wire contract (A10): event-stream,
// subagent, queued, voice, keepalive, ssh, automations and /btw frames.
// Shared payload shapes live in payloads.ts, the HostFrame union in index.ts.
import type { QueuedMessage, SessionStatsPayload, UiEvent } from "./payloads";
import type { BrowserTabInfo } from "./frames-models";
import type { Automation, AutomationRun } from "../automations/types";


/** Context usage frame (host/host.ts pushContext; stamped) */
export interface ContextFrame {
  type: "context";
  sessionId: string;
  tokens: number;
  window: number;
  percent: number;
  hi?: string; // stamped frame
  seq?: number;
}

/** Whole-session stats frame (host/host.ts pushSessionStats) */
export interface SessionStatsFrame extends SessionStatsPayload {
  type: "session_stats";
  sessionId: string;
}

/** Session event frame (host/host.ts translateEvent stamped / 2211 mention sent directly, unstamped) */
export type EventFrame = {
  type: "event";
  sessionId: string;
  hi?: string; // stamped variant (translateEvent path)
  seq?: number;
} & UiEvent;

/** Subagent lifecycle frame (host/host.ts; stamped) */
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
  result?: string; // terminal statuses only: submitted report (last assistant text, host-read from the child transcript)
  hi?: string; // stamped frame
  seq?: number;
}

/** Subagent aggregated progress frame (host/host.ts regular / 2431 terminal-state re-send; unstamped) */
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
  sessionFile?: string; // child transcript file; collected from either channel like the TUI registry (started may predate persistence)
}

/** Subagent event frame (host/host.ts translateSubagentEvent; stamped) */
export type SubagentEventFrame = {
  type: "subagent_event";
  sessionId: string;
  subagentId: string;
  hi?: string; // stamped frame
  seq?: number;
} & UiEvent;

/** Pre-consumption notice for steer/queued messages (host/host.ts dequeue hook; stamped) */
export interface SteerConsumedFrame {
  type: "steer_consumed";
  sessionId: string;
  texts: string[];
  hi?: string; // stamped frame
  seq?: number;
}

/** Queued snapshot frame (host/host.ts sendQueued; stamped) */
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

/** Dictation target text (host/voice.ts SttTarget bridge; stamped). The host
 * joins anchor + committed + volatile into one full draft string, so the
 * frontend only ever calls setComposerValue with it. */
export interface SttDraftFrame {
  type: "stt_draft";
  sessionId: string;
  text: string;
  hi?: string; // stamped frame
  seq?: number;
}

/** Dictation lifecycle / progress (host/voice.ts SttCallbacks bridge; stamped).
 * state "idle" ends the capture (message carries warnings or download progress). */
export interface SttStateFrame {
  type: "stt_state";
  sessionId: string;
  state: "recording" | "transcribing" | "idle";
  message?: string;
  hi?: string; // stamped frame
  seq?: number;
}

/** Dictation auto-submit (host/voice.ts; the configured stt.submitTrigger was met; stamped) */
export interface SttSubmitFrame {
  type: "stt_submit";
  sessionId: string;
  hi?: string; // stamped frame
  seq?: number;
}

/** Speech-out delta (host/voice.ts handleVoiceEvent; stamped). The UI-side
 * system speechSynthesis speaks these — the bundled Kokoro has no Chinese
 * G2P, OS voices cover both languages. */
export interface TtsDeltaFrame {
  type: "tts_delta";
  sessionId: string;
  text: string;
  hi?: string; // stamped frame
  seq?: number;
}

/** Speak the buffered trailing partial now (message/turn end; stamped) */
export interface TtsFlushFrame {
  type: "tts_flush";
  hi?: string; // stamped frame
  seq?: number;
}

/** Silence playback immediately (user message / abort; stamped) */
export interface TtsStopFrame {
  type: "tts_stop";
  hi?: string; // stamped frame
  seq?: number;
}

/** Test-mode dictation result (settings page; final text; stamped) */
export interface SttTestResultFrame {
  type: "stt_test_result";
  sessionId: string;
  text: string;
  hi?: string; // stamped frame
  seq?: number;
}

/** STT model download progress (settings page; stamped) */
export interface SttDownloadProgressFrame {
  type: "stt_download_progress";
  percent: number;
  status: string;
  label: string;
  hi?: string; // stamped frame
  seq?: number;
}

/** Voice settings snapshot reply (settings page: dictation model + cache state) */
export interface VoiceStatusFrame {
  type: "voice_status";
  modelId: string | null;
  modelKey: string | null;
  ready: boolean;
  downloading: boolean;
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

/** Physical display enumeration reply (host/rpc/settings.ts list_displays; feeds the computer-control display dropdown) */
export interface DisplaysFrame {
  type: "displays";
  displays: Array<{ id: string; name: string; width: number; height: number; isPrimary: boolean }>;
  error: string | null;
  /** TCC preflight label for screen capture: granted | denied | unavailable (native DesktopCapabilities.capturePermission) */
  capturePermission: string;
}

/** SSH host table reply (host/rpc/ssh.ts ssh_list_hosts / after save/remove; user-scope ssh.json entries) */
export interface SshHostsFrame {
  type: "ssh_hosts";
  hosts: Array<{
    name: string;
    host: string;
    username?: string;
    port?: number;
    keyPath?: string;
    description?: string;
    compat?: boolean;
  }>;
}

/** SSH connectivity probe reply (host/rpc/ssh.ts ssh_test_host) */
export interface SshTestResultFrame {
  type: "ssh_test_result";
  /** Probe target alias; null when the form was probed inline before saving */
  name: string | null;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Remote workspace creation reply (host/rpc/ssh.ts add_remote_workspace; ok:false carries the probe error) */
export interface RemoteWorkspaceAddedFrame {
  type: "remote_workspace_added";
  ok: boolean;
  cwd?: string;
  host?: string;
  remotePath?: string;
  error?: string;
}

/** Remote directory listing reply (host/rpc/ssh.ts ssh_list_dirs; single-level names under the echoed path) */
export interface SshDirsFrame {
  type: "ssh_dirs";
  ok: boolean;
  /** Directory the listing describes (the request's base path) */
  path: string;
  /** Subdirectory names (no trailing slash); absent on failure */
  dirs?: string[];
  error?: string;
}

// ---------- UI → host client frames ----------

/** UI locale switch (UI → host; fire-and-forget, host persists it and applies it to its own surfaces) */
export interface SetLocaleFrame {
  type: "set_locale";
  lang: "zh-CN" | "en";
}


/** Automations list snapshot (host/rpc/automations.ts replyList; pushed after every mutating
 *  automations_* RPC and by the scheduler's UI notify). runs keyed by automation id, ≤10 each. */
export interface AutomationsListFrame {
  type: "automations_list";
  automations: Automation[];
  runs: Record<string, AutomationRun[]>;
}

/** Manual-run receipt (automations_run_now reply): the session was created, the prompt turn
 *  keeps running async (host/automations/scheduler.ts runAutomationNow). */
export interface AutomationRunStartedFrame {
  type: "automation_run_started";
  runId: string;
  sessionId?: string;
}

/** Next-run preview (automations_preview reply): up to three future trigger times for the
 *  submitted schedule (editor live preview; empty array = the schedule never fires). */
export interface AutomationPreviewFrame {
  type: "automation_preview";
  nextRunsAt: number[];
}

// ---------- /btw side conversations (host/btw.ts) ----------

/** One Q/A turn of a side-conversation topic (mirrors the SDK BtwHistoryTurn sidecar schema). */
export interface BtwTurn {
  question: string;
  answer: string;
  status: "running" | "complete" | "cancelled" | "error" | "interrupted";
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** A side-conversation topic: the opening turn plus optional follow-up turns (BtwHistoryRecord). */
export interface BtwRecord extends BtwTurn {
  id: string;
  leafId: string | null;
  followUps?: BtwTurn[];
}

/** Answer text delta for a running side-conversation turn. */
export interface BtwDeltaFrame {
  type: "btw_delta";
  sessionId: string;
  recordId: string;
  delta: string;
}

/** Topic checkpoint: pushed when a turn starts (status running) and whenever a turn reaches a terminal status. */
export interface BtwRecordFrame {
  type: "btw_record";
  sessionId: string;
  record: BtwRecord;
}

/** Full topic list for a session (btw_history RPC reply), newest first. */
export interface BtwHistoryFrame {
  type: "btw_history";
  sessionId: string;
  records: BtwRecord[];
}

/** Host asks the UI to open (or focus) a right-panel tab, e.g. /btw pulling up the Side Chat. */
export interface OpenRightTabFrame {
  type: "open_right_tab";
  name: string;
}
