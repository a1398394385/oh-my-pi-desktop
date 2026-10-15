// Single funnel for process-wide shared mutable state.
// Variables read/written across modules must hang off the H object (bare ESM
// let bindings are read-only to importers, object properties can be assigned
// cross-module); containers whose reference never changes (Maps) are exported
// directly. SDK references and load-order constraints: see bootstrap.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { createAgentSession } from "./bootstrap.ts";
import type { KeepaliveState } from "./keepalive.ts";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { hostI18n } from "./i18n/host.ts";

// ---------- Session pool types (declared up front for profile-switch cleanup) ----------
// TranscriptItem/TurnUsage moved to the wire contract (wire/payloads.ts, A10) as
// the single source shared with the UI; re-exported here so the existing host
// import surface (translate/session-lifecycle/rpc domains) stays untouched.
// The wire version is the field superset (adds role "error" + the `intent` field).
import type { TranscriptItem, TurnUsage } from "./wire/payloads.ts";
export type { TranscriptItem, TurnUsage };
export type PoolEntry = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionResult: Awaited<ReturnType<typeof createAgentSession>>; // Host injection points such as setToolUIContext
  unsubscribe: () => void;
  // Currently attached ws: when handleLoadSession hits a pooled entry, this
  // decides whether subscriptions need re-attaching (after a frontend reload
  // it is a new connection; old subscriptions would send to a closed ws and
  // events would be lost). Reference comparison only, hence unknown
  attachedWs: unknown;
  // Sticky key for the session's request credentials (= sessionManager.getSessionId()):
  // get_limits resolves getApiKey with the same parameters as the session, so
  // with multiple accounts the detail-card quota matches the account this
  // session actually hits
  providerSessionId: string;
  // Whether the extension runner's session_start was already dispatched for
  // this entry (attachEntry re-runs on pool reuse; a repeat dispatch resets
  // extension state — keepalive would drop its capture)
  extSessionStarted?: boolean;
  // ACP dual-zone runtime handle (host/acp-runtime.ts), present only when the
  // master switch was on at session creation. Read-only here: get_context_detail
  // reports the compressed-zone / active-zone split from the runtime's latest
  // round status. Structural type so this shared state module does not depend on
  // the ACP graph.
  acpRuntime?: {
    degraded: boolean;
    roundStatus: {
      tier: "none" | "L1" | "L2" | "L3";
      zoneTokens: number;
      activeTokens: number;
    } | null;
  };
  // Extension-injected status badges (key → text, e.g. ponytail's setStatus):
  // captured by the uiCtx.setStatus injected at attachEntry, pushed to the
  // frontend as extension_status frames and snapshotted into get_capabilities.
  // Undefined text removes the key. Lives on the entry so it survives re-attach.
  extStatuses?: Map<string, string>;
  // Cache keepalive intent (source of the keepalive extension's isWanted):
  // set true when a turn truly wraps up (unread output exists), set false on
  // user create/load/send/mark_seen — only sessions the user has not seen yet are probed.
  // Writes go through keepalive-host.ts's markTurnWrapped / markSeen (A16);
  // direct assignment outside that module is a boundary violation.
  keepaliveWanted: boolean;
  // Latest keepalive runtime snapshot reported by the injected extension
  // (undefined = the extension was never injected for this entry: keepalive
  // off or the plugin double-load guard at creation time)
  keepaliveState?: KeepaliveState;
  // Session id for keepalive_status pushes fired from reportState (set right
  // after entry creation; the closure cannot capture the pre-generated id)
  keepaliveSid?: string;
  transcript: TranscriptItem[];
  assistantDraft: string; // Streaming text accumulated for the current turn, finalized at turn_end
  thinkingDraft: string;
  thinkingStartedAt: number | null;
  // Session active duration (same semantics as the TUI status-line
  // time_spent): sum of completed agent_start→agent_end windows plus the
  // in-flight window (counted from activeStartedAt); idle wall time excluded.
  // Lives with the in-memory session state; loading a past session starts
  // from 0 (matching the TUI meter, no disk backfill)
  activeMs: number;
  activeStartedAt: number | null;
  // When the last session_stats frame was pushed (live refresh; see
  // maybePushSessionStats in session-lifecycle). message_end /
  // tool_execution_end fire many times per turn, so they are coalesced by a
  // minimum interval to keep the stats frames off the wire in floods.
  // null = this session has not pushed a live frame yet
  statsPushedAt: number | null;
  path: string; // Session file path (on-disk identity)
  cwd: string;
  isGit: boolean;
  // (18.5) The old queuedTexts/consumedTexts turn_end diff backstop is gone:
  // the base now restores undelivered queued messages on abort
  // (pi-agent-core agent.ts #restoreUndeliveredQueuedMessages) and every
  // queue mutation fires onQueueChange, which session-lifecycle pushes as
  // realtime queued frames; turn_end keeps one calibration push only
  // followUp parking lot (including hidden companions, original queue
  // elements): the base's injection boundary drains the followUp queue to
  // empty, so multiple queued messages would ride out in the same run. The
  // host keeps only 1 entry in the base queue (the next to consume) and parks
  // the rest here; each agent_end puts 1 back and triggers consumption —
  // queued messages stay FIFO across turns, one independent turn each
  parkedFollowUp: any[];
  // Consumed-pending texts (queue-card double-display fix): texts already
  // announced to the UI via steer_consumed whose injection has not been
  // confirmed yet. The base keeps a dequeued message visible through the
  // preparation claim (peekFollowUpQueue/peekSteeringQueue prepend claimed
  // originals), and releasing the claim fires no onQueueChange — so the
  // realtime queued frame would re-add the consumed message to the queue
  // card for the whole turn, until the agent_end calibration drops it.
  // sendQueued filters these texts; cleared on user message_start
  // (injection confirmed) and at terminal agent_end (abort-restore
  // visibility).
  consumedPending: Set<string>;
  // Pooled MCP mounts (mcp-mount.ts): release handles for every connection
  // this session acquired (shared pool entries + private session-level
  // connections), and a generation counter fencing async mounts that complete
  // after the session was detached/evicted in the meantime
  mcpReleases: Array<() => void>;
  // In-flight mount promise (mcp-mount.ts): the prompt path awaits it (bounded)
  // so the first request carries the full tool surface; cleared on completion
  mcpMountInFlight?: Promise<void>;
  mcpMountGen: number;
  // (18.5) RpcSubagentRegistry built from this session's subagent event bus on
  // first attach (modes/rpc/rpc-subagents): control_subagent resolves live
  // subagents through it; lives on the entry so a frontend reload reuses the
  // accumulated snapshots instead of starting blind
  subagentRegistry?: unknown;
  // The session's SessionManager instance: used by rename (setSessionName) and to rebuild the transcript after compact
  manager: any;
  // User-renamed title (lazily created, unpersisted sessions are invisible to
  // listAll, so the fallback entry in list_sessions renders through this;
  title: string | null;
  // Subagent session identity (derived from parent session file on disk)
  isSubagent?: boolean;
  parentPath?: string;
  // Set when the scheduler spawned this session for an automation: surfaced on
  // session_list rows (sidebar clock badge) and echoed as a live user-message
  // event (automation sessions have no local composer send to draw the bubble)
  automation?: { id: string; title: string };
  // fileMention read-back cursor: at agent_end, re-reads manager.getEntries()
  // and turns fileMention entries added since this index into mention frames
  // (the base persists them inside prompt() with no matching event)
  mentionScanIndex: number;
  // /goal command controller: command dispatch + goal re-run scheduling (see host/goal.ts)
  goal: GoalController;
  // External-write detection: file byte size already parsed (0 = not first-scanned yet; the first scan compares the whole file)
  pollKnownSize: number;
  // Fresh session whose file is lazily persisted: the external-write poll flips
  // this off and pushes a session_list the moment the file first exists, so the
  // sidebar's pending row (copy-session-id disabled) clears mid-run instead of
  // waiting for the run-end list refetch
  awaitDiskList: boolean;
  // An external process (e.g. the CLI) has been seen writing this session:
  // once set, the notice bar stays until reload (cleared when entries are rebuilt)
  externalWrite: boolean;
  // Session file locations this entry previously owned (most recent last):
  // the SDK's persistence notice moves a contested session to a sibling file
  // and the host repoints entry.path, but the frontend keeps the path it was
  // handed at open time — path-keyed RPCs must still resolve the live entry
  // through its old locations instead of forking a second session over the
  // abandoned file
  previousPaths: string[];
};

// key = the sessionId the frontend holds
export const sessions = new Map<string, PoolEntry>();

// The currently attached UI websocket (last connection wins). Modules that must
// not import rpc/ (automations/scheduler) read this from an injected notify
// callback to push frames; main.ts assigns it on websocket open/close.
export const activeWs: { value: unknown } = { value: null };

export const defaultCwd = os.homedir();

// The "work without a project" backing directory. It is app-owned: always a real
// cwd for agents (they cannot run without one) but never a registrable project —
// the project-list guards live in profile.ts / rpc/session.ts, and the frontend
// injects it as a fixed row instead of reading it from omp-desktop.json.
export const defaultWorkspaceDir = path.join(os.homedir(), ".omp-default");

/** Idempotent mkdir so the backing directory exists before any agent spawns there. */
export function ensureDefaultWorkspaceDir(): string {
  fs.mkdirSync(defaultWorkspaceDir, { recursive: true });
  return defaultWorkspaceDir;
}

// Desktop project manifest (omp-desktop.json under the current profile's config dir, full paths)
export type DesktopProjects = {
  allProjects: string[];
  removedProjects: string[];
  expandedProjects: string[];
  pinnedSessions: string[];
  archivedSessions: string[];
  mcpSharing?: Record<string, "session" | "project" | "global">;
};
export type DesktopEnv = { httpProxy: string; noProxy: string; caCerts: string };

export const H = {
  currentProfile: "",
  // Process-level base (one per process, dynamically reloaded with activeProfile)
  agentDir: "",
  // Placeholder until applyProfile() finishes; RPC handlers only run after that.
  authStorage: undefined as unknown as AuthStorage,
  modelRegistry: undefined as any,
  settings: undefined as any,
  // OMP login flow (the default entry for adding providers) in-flight flag and prompt relay table
  loginInFlight: false,
  loginAbort: null as AbortController | null,
  // Desktop env proxy/certs (desktop-env.json under agentDir)
  desktopEnvPath: "",
  desktopEnvFilePresent: false,
  desktopEnv: { httpProxy: "", noProxy: "", caCerts: "" } as DesktopEnv,
  // Desktop project manifest
  desktopProjectsPath: "",
  desktopProjects: { allProjects: [], removedProjects: [], expandedProjects: [], pinnedSessions: [], archivedSessions: [], mcpSharing: {} } as DesktopProjects,
  // Model catalog (refreshed with profile / login / start-stop)
  availableModels: [] as any[], // chat-only pool: sessions, enable/disable scoping, composer menu
  allModels: [] as any[], // all kinds incl. keyless local runners: settings catalog + role assignment
  scopedModels: [] as any[],
  modelOverride: undefined as any,
  cachedProfiles: ["default", "omp-desktop"] as string[],
  // Callback fired when the online model catalog refresh completes (assigned
  // at host.ts startup: pushes a catch-up models frame to the current WS
  // connection; triggered after applyProfile in profile.ts finishes its
  // background refresh)
  onModelsRefreshed: undefined as (() => void) | undefined,
};

// Default thinking level for enabledModels entries of the form "provider/id:thinking"
export const enabledDefaults = new Map<string, string | null>();
// Login flow onPrompt relay table: id -> resolve
export const loginPendingPrompts = new Map<number, (text: string) => void>();

// ---------- WS event stamps and approval bridge (push infrastructure shared by main.ts and domain modules) ----------
// Event stamps: hi = host instance identity (the UI uses it to detect a host
// restart dropping old frames), seq = monotonically increasing event number within the process
export const HOST_INSTANCE_ID = crypto.randomUUID();
let eventSeq = 0;
export function stampEvent<T extends object>(payload: T): T & { hi: string; seq: number } {
  return { ...payload, hi: HOST_INSTANCE_ID, seq: ++eventSeq };
}

/** command_output frame: find the currently attached connection by sessionId and push (for cross-connection output such as the goal controller). */
export function pushCommandOutput(sessionId: string, text: string) {
  const w = sessions.get(sessionId)?.attachedWs as { send(data: string): unknown } | null;
  if (w) w.send(JSON.stringify({ type: "command_output", sessionId, text }));
}

// Pending approval requests. The whole approval state machine lives in this
// file: entries are created by requestApproval and settled by
// settleApprovalResponse (the approval_response RPC, bottom of this file);
// agent-abort cleanup is requestApproval's AbortSignal listener.
// `onSliderIndex` fires before resolve() so the plan approval flow can read the
// picked execution tier; ordinary approvals never set it.
export const pendingApprovals = new Map<
  string,
  {
    resolve: (v: string | undefined) => void;
    onSliderIndex?: (index: number) => void;
    // (18.5) Ask-dialog variant: the questions pushed on the frame; the
    // entry's resolve (session-lifecycle askDialog) parses the serialized
    // ExtensionAskDialogSubmitResult answer itself
    questions?: unknown[];
    // Owning session id + which user-dialog family the wait belongs to:
    // the keepalive block-probing toggles read this (keepalive.ts blockState)
    sessionId: string;
    blockKind: "approval" | "ask";
  }
>();

/**
 * Approval request frame: send approval_request to the UI and wait for
 * approval_response to settle; agent abort (AbortSignal) ends as cancelled.
 *
 * `presentation` carries the plan-approval extras the plain confirm/editor
 * variants do not use: the keep-context row's live token counts, disabled row
 * indices, the execution-model slider, and the editor inline-input flags.
 * Absent for every other approval, so the frame shape is unchanged there.
 * `onSliderIndex` receives the tier the operator picked, delivered just before
 * the promise settles (the plan flow reads it in its own continuation).
 */
export function requestApproval(
  ws: { send(data: string): unknown },
  sessionId: string,
  title: string,
  options: string[],
  signal?: AbortSignal,
  presentation?: {
    keepContextTokens?: { tokens: number; contextWindow: number };
    disabledIndices?: number[];
    slider?: { caption: string; index: number; segments: { label: string; detail: string }[] };
    editable?: boolean;
    editableIndex?: number;
    // Editor variant's inline-input prefill (ask's "Other" free text): the UI
    // seeds the input row with it. Frame field, rides verbatim like the rest.
    prefill?: string;
    // Ask-tool intent metadata (the `i` field stashed off message_start): not
    // a presentation concern, but it rides this verbatim frame-field channel
    // so the ask-dialog frame keeps its exact field set.
    intent?: unknown;
    // Plan-approval payload: the raw plan text plus its title/disk path, read
    // before the proposal turn is aborted. The approval card renders the text
    // above the options; the todo card links to the full file in the right panel.
    plan?: { title: string; path: string; content: string };
  },
  onSliderIndex?: (index: number) => void,
  questions?: unknown[],
  // Pending-entry family override: blockKind derives from questions ("ask")
  // or defaults to "approval", but the editor variant is an ask-family dialog
  // with no questions on the frame — keepalive's blockState probes the two
  // families through different toggles, so the classification must stay exact.
  blockKind?: "approval" | "ask",
): Promise<string | undefined> {
  const requestId = crypto.randomUUID();
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const settle = (v: string | undefined) => {
    pendingApprovals.delete(requestId);
    resolve(v);
  };
  pendingApprovals.set(requestId, {
    resolve: settle,
    onSliderIndex,
    questions,
    sessionId,
    // Ask-family dialogs (the ask tool's select rounds and the rich askDialog)
    // pass questions; the editor variant pins "ask" via the parameter; every
    // other caller is a permission-family dialog.
    blockKind: blockKind ?? (questions ? "ask" : "approval"),
  });
  // Agent abort / tool cancel: on AbortSignal, settle the pending request as cancelled (undefined)
  signal?.addEventListener("abort", () => settle(undefined), { once: true });
  ws.send(
    JSON.stringify(
      stampEvent({
        type: "approval_request",
        sessionId,
        requestId,
        title,
        options,
        ...(questions ? { questions } : {}),
        // Presentation fields ride the frame verbatim (slider / disabledIndices /
        // keepContextTokens / editable* / prefill / intent): the UI renders or
        // consumes each when present. They
        // were once hand-picked onto the frame and the slider was missed, so the
        // approval card silently dropped it and execution fell back to the
        // default role tier without the operator seeing a choice.
        ...(presentation ?? {}),
      }),
    ),
  );
  return promise;
}

/**
 * approval_response RPC body: settle a pending approval/ask wait. Lives beside
 * requestApproval so the approval state machine (pending table + request +
 * settle) stays in one module; the rpc/settings handler table entry is
 * registration only.
 */
export function settleApprovalResponse(
  ws: { send(data: string): unknown },
  msg: { requestId: string; sliderIndex?: number; answer?: unknown },
) {
  const pending = pendingApprovals.get(msg.requestId);
  if (!pending) throw new Error(hostI18n.t("errors.setting.approvalNotFound", { requestId: msg.requestId }));
  // The plan approval slider rides the same response; deliver it before
  // resolve() so the flow's continuation already sees the picked tier.
  if (pending.onSliderIndex && typeof msg.sliderIndex === "number") pending.onSliderIndex(msg.sliderIndex);
  // Plain approvals take the raw string; the ask-dialog variant's stored
  // resolve (session-lifecycle askDialog) parses the serialized
  // ExtensionAskDialogSubmitResult itself, so this stays pass-through.
  pending.resolve(typeof msg.answer === "string" ? msg.answer : undefined);
  ws.send(JSON.stringify({ type: "approval_resolved", requestId: msg.requestId }));
}
