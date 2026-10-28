// Session slice: the openSessions container and the current-session pointer, the model catalog
// container, the event-stream guard (hi/seq), event frame handling, queued/steer messages, the LRU
// gate, system notifications. Moved over from store.ts (P3 wave 2).
// Transitional: container references stay constant (mutate + bump fallback; references get swapped
// in wave 3 when components switch to selectors).
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { findLast, pathOfSessionId } from "./session-lookup";
import { notifyDesktop, alertTitle } from "./notify";
import { invoke } from "./ws";
import { sealRunItems, endingErrorText } from "./run-seal";
// Per-session right panel snapshots: activateSession is the single funnel for all session
// activations, so save/restore hooks live here (right.ts also imports activeOpen from this
// module — both directions are runtime-only calls inside function bodies, no load-time eval)
import { saveRightSlot, restoreRightSlot } from "./right";
import { t } from "../i18n";
import type { ApprovalMode, EventFrame, HostRequest, MessagesFrame, PoolSessionsFrame, PromptAttachment, TurnUsage } from "../types/frames";
import type { AssistantItem, ChatItem, LoopItem, OpenSession, ThinkingItem, ToolArgs, ToolDetails, ToolItem, UserItem } from "../types/session";
import type { SessionItem } from "../types/session";

// Send helper via the ws slice (stable reference, equivalent to the old top-level send)
const send = (obj: HostRequest): void => {
  useAppStore.getState().send(obj);
};

/** One row of the host pool snapshot (pool_sessions frame) */
type PoolSessionInfo = PoolSessionsFrame["sessions"][number];

/** setTimeout handle (DOM vs Node return types differ; unified alias) */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface SessionSlice {
  activePath: string | null;
  selectedSubagent: string | null;
  approvalMode: ApprovalMode;
  evtHost: string | null; // host process instance id (ready.hi / stamped event .hi); a change means the host restarted
  pendingCreate: boolean;
  pendingNewPrompt: { text: string; files: PromptAttachment[] } | null;
  // ! bash command submitted on the welcome page: executed right after the
  // auto-created session lands (session_created handler)
  pendingNewBash: { command: string; excludeFromContext: boolean } | null;
  openSessions: Map<string, OpenSession>; // path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...}
  // Host in-memory pool residency (pool_sessions frames; sidebar "active tasks"). The
  // host pool, not openSessions: that map has an LRU cap and drops slots the pool still holds
  poolSessions: PoolSessionInfo[];
  // Paths of pool sessions with busy === true (maintained by landPoolSessions): O(1) per-row
  // busy lookups instead of scanning the pool array per sidebar row per store notification
  busyPaths: Set<string>;
  // Paths the host still holds in memory (same writer as busyPaths): the eject action keys
  // off this, not openSessions — the frontend slot map has an LRU cap, so a row can leave
  // that map while the session is still resident in the host pool
  poolPaths: Set<string>;
  // Latest word-completion reply (complete_text RPC): overwritten per frame;
  // GhostTextPlugin matches it against its pending request and drops stale hits
  completionResult: CompletionResult | null;
  // Background job snapshots keyed by bgJobsKey(sessionId, subagentId) (18.5 bg_jobs
  // frames; full-replace semantics per key)
  bgJobs: Map<string, BgJobEntry[]>;
}

/** Store landing shape of the host `completion` frame (complete_text RPC reply) */
export interface CompletionResult {
  sessionId: string;
  suggestion: string;
}

/** One background job row (18.5 BgJobsFrame jobs entry; snapshot per session) */
export interface BgJobEntry {
  id: string;
  type: string;
  label: string | null;
  command: string | null;
  cwd: string | null;
  pids: number[];
  exitCode: number | null;
  running: boolean;
}

/** Snapshot slot key: one per (session, subagent scope). Subagent-scoped replies replace
    only their own slot, so switching the selected subagent cannot show another's rows. */
export function bgJobsKey(sessionId: string, subagentId?: string): string {
  return `${sessionId}::${subagentId ?? ""}`;
}

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = () => ({
  activePath: null,
  selectedSubagent: null,
  approvalMode: "always-ask",
  evtHost: null,
  pendingCreate: false,
  pendingNewPrompt: null,
  pendingNewBash: null,
  openSessions: new Map(),
  poolSessions: [],
  busyPaths: new Set(),
  poolPaths: new Set(),
  completionResult: null,
  bgJobs: new Map(),
});

// ---------- Shared helpers (session domain) ----------
export function isJunkPlaceholder(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

/** Expansion-state field of a tool row (the render layer picks one per kind: terminal/background/device
    rows cmdExpanded, edit rows diffExpanded, read rows readExpanded, see chat/ToolRow.jsx and
    chat/EditRow.jsx) — "expand while running" lands on the field chosen here */
export function toolExpandKey(name: string | null | undefined): "readExpanded" | "diffExpanded" | "cmdExpanded" {
  if (name === "read" || name === "grep" || name === "glob" || name === "ls") return "readExpanded";
  if (name === "edit" || name === "write" || name === "apply_patch") return "diffExpanded";
  return "cmdExpanded";
}

// Deduplicate tool-row file lists (moved over from tool-rows.js uniqueFiles; needed by the store's tool handling)
function uniqueFiles(files: string[] | null | undefined): string[] {
  return [...new Set(files ?? [])];
}

/** Immutable session update (P3): copy the session (items array too when needed) → the callback
 *  mutates the copy → swap the openSessions Map reference (selectors subscribed to session/fields
 *  detect by reference). */
export function updateSession(sessionId: string, fn: (s: OpenSession) => void, withItems = true): void {
  const st = useAppStore.getState();
  const hit = pathOfSessionId(sessionId, st.openSessions);
  if (hit === undefined) return;
  const cur = st.openSessions.get(hit);
  if (!cur) return;
  const next = withItems ? { ...cur, items: cur.items.slice() } : { ...cur };
  fn(next);
  useAppStore.setState((st2) => ({ openSessions: new Map(st2.openSessions).set(hit, next) }));
}

// ---------- Locating and activating ----------
export function activeOpen(): OpenSession | undefined {
  const st = useAppStore.getState();
  return st.activePath ? st.openSessions.get(st.activePath) : undefined;
}

export function findBySessionId(id: string): OpenSession | undefined {
  const st = useAppStore.getState();
  const p = pathOfSessionId(id, st.openSessions);
  return p === undefined ? undefined : st.openSessions.get(p);
}

/** Full-replace landing for pool_sessions frames: swaps the pool array and rebuilds the
 *  busy-path set in one write (both containers always agree; see SessionSlice.busyPaths). */
export function landPoolSessions(sessions: PoolSessionInfo[] | undefined): void {
  const list = sessions ?? [];
  const busyPaths = new Set<string>();
  const poolPaths = new Set<string>();
  for (const p of list) {
    poolPaths.add(p.path);
    if (p.busy === true) busyPaths.add(p.path);
  }
  useAppStore.setState({ poolSessions: list, busyPaths, poolPaths });
}

// ---------- Render memory gate: LRU eviction for openSessions ----------
/** Resident cap for opened sessions. An evicted session is reloaded through the load_session path
    when the user switches back (SessionRow / BranchTreePage both implement the "not open → load via
    host" branch); the host session pool is unaffected. */
const OPEN_SESSIONS_MAX = 8;

/** Activate a session: make it current, mark most-recently-used, then evict by cap.
 *  On switch, saves the outgoing session's right panel snapshot first and restores the
 *  incoming session's right panel after (per-session independence). */
export function activateSession(path: string): void {
  const st0 = useAppStore.getState();
  // Stale slot after a reconnect (or host restart): the host dropped this entry's UI subscription
  // with the old socket, so activating it would show a frozen view whose abort button never lands.
  // Remount through load_session — the host's reuse branch re-attaches and replays the transcript.
  const resident = st0.openSessions.get(path);
  if (resident && resident.connEpoch !== st0.connEpoch) {
    useAppStore.setState({ isCreatingNew: false });
    st0.send({ type: "reload_settings" });
    st0.send({ type: "load_session", path });
    return;
  }
  const prev = st0.activePath;
  // In-place message editing never survives a session switch (cancel-on-switch spec)
  if (prev !== path) {
    saveRightSlot(prev); // same-path re-activation: neither save nor restore
    if (st0.editingEntryId !== null) useAppStore.setState({ editingEntryId: null });
  }
  useAppStore.setState((st) => {
    const cur = st.openSessions.get(path);
    const openSessions = new Map(st.openSessions);
    if (cur) {
      openSessions.delete(path);
      openSessions.set(path, cur);
    }
    return { openSessions, activePath: path, mainViewMode: "chat" };
  });
  // Read receipt: frontend switches between already-open sessions send no load_session; the unread state kept alive by cache keepalive is cleared via this message
  useAppStore.getState().send({ type: "mark_seen", path });
  if (prev !== path) restoreRightSlot(path); // no snapshot (first open/newly created) = inherit current panel
  scheduleEvict();
}

/** Unified switch/open session: clear new-session state, close welcome, drop unread mark,
 *  then activate or load via host and refresh Git Diff. selectedFile/selectedSubagent
 *  cleanup is owned by restoreRightSlot (already-open branch) and the session_created
 *  frame (host-load branch) — resetting here would clobber the just-restored panel state. */
export function openSessionByPath(path: string, cwd?: string): void {
  useAppStore.setState({ isCreatingNew: false, mobileCol: "main" }); // narrow: opening a session leaves the list page
  useAppStore.getState().hideWelcomeScreen();
  useAppStore.setState((st) => ({
    unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)),
  }));
  useAppStore.getState().saveUnseen();
  if (cwd) useAppStore.getState().expandProject(cwd);
  if (useAppStore.getState().openSessions.has(path)) {
    activateSession(path);
    useAppStore.getState().refreshGitDiff();
  } else {
    useAppStore.getState().send({ type: "reload_settings" });
    useAppStore.getState().send({ type: "load_session", path });
  }
}

// Delayed eviction (coalesces multiple triggers). Must be delayed, not synchronous: after runEnd the
// host may **immediately continue the run** (parked followUp put back + a.continue(), see attachEntry
// in host.ts); synchronous eviction would kick the session out of openSessions before the resumed
// run's turn_start frame, later frames would be dropped on findBySessionId misses, and the session
// would appear frozen in the UI. Wait a moment so resumed-run frames land first (they set streaming
// back to true, which naturally protects the session).
let evictTimer: TimerHandle | undefined;
function scheduleEvict(): void {
  clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    evictTimer = undefined;
    evictOpenSessions();
  }, 3000);
}

/** Over-cap eviction: start from the least-recently-activated end, skipping the current session and
    streaming sessions (evicting a streaming session would lose its subsequent event frames — dropped
    on findBySessionId misses). */
export function evictOpenSessions(): void {
  const evicted: string[] = [];
  useAppStore.setState((st) => {
    if (st.openSessions.size <= OPEN_SESSIONS_MAX) return {};
    const openSessions = new Map(st.openSessions);
    for (const [p, s] of openSessions) {
      if (openSessions.size <= OPEN_SESSIONS_MAX) break;
      if (p === st.activePath || s.streaming) continue;
      openSessions.delete(p);
      evicted.push(p);
    }
    return { openSessions };
  });
  // Pool boundary: tell the host to drop the evicted sessions' MCP mounts and their
  // socket attachment (idempotent; switching back re-attaches and re-mounts through the
  // load_session path). Detaching is what lets the host's idle sweep reclaim the entry.
  for (const p of evicted) useAppStore.getState().send({ type: "mcp_detach", path: p });
}

// Clear the fork/navigation double-click guards (item.branching lives with the item data), recursing into loop groups
export function clearBranchingMarks(items: SessionItem[]): void {
  for (const it of items) {
    if (it.role === "assistant" && it.branching) it.branching = false;
    if (it.role === "loop" && it.items) clearBranchingMarks(it.items);
  }
}

// Turn teardown / host restart: reset tool items still marked running. Interrupted and error paths
// may never see a tool_update; without the reset the row keeps an eternal spinner (same purpose as
// hostInstanceReset clearing "ghost spinners")
function clearRunningTools(s: OpenSession): void {
  const walk = (list: SessionItem[] | undefined): void => {
    for (const it of list || []) {
      if (it.role === "loop") walk(it.items);
      else if (it.role === "tool" && it.running) it.running = false;
    }
  };
  walk(s.items);
}

// Abort-receipt fallback. host/rpc/session.ts acks `abort_session` as soon as the base's
// abort() returns, which does NOT mean the run ended: a run wedged in a provider request
// that never answers emits no turn_end, so the working row keeps counting, the tool rows
// keep spinning, and (because Composer's stop button only re-arms when canAbort flips)
// the user cannot retry. Settle what the user can see once no turn_end follows the receipt.
// turnItemStart stays untouched: a late turn_end still seals the run normally, and the
// draft is pushed as a plain assistant row so the text produced before the abort is kept.
// busyPaths is deliberately NOT cleared here — the sidebar spinner comes from the host's
// own busy flag, and that is the honest signal that the run has not actually ended yet.
const ABORT_SETTLE_GRACE_MS = 2000;
export function settleAbortedRunLater(sessionId: string): void {
  setTimeout(() => {
    const s = findBySessionId(sessionId);
    if (!s?.streaming) return; // a real turn_end already settled it
    updateSession(sessionId, (x) => {
      if (x.assistantDraft && !isJunkPlaceholder(x.assistantDraft)) {
        x.items.push({ role: "assistant", text: x.assistantDraft });
        x.assistantDraft = "";
      }
      x.streaming = false;
      x.workingText = null;
      x.pendingApprovals = [];
      clearRunningTools(x);
    });
  }, ABORT_SETTLE_GRACE_MS);
}

// ---------- Run sealing / queued messages (moved over from core.js; render calls now bump) ----------
// Run sealing lives in ./run-seal.ts (advisor rows split the run, so the logic no longer
// fits this file's ratchet); re-exported for the existing callers.
export { sealRunItems };

// Queue actions (drop/edit/send-now/requeue) moved to store/queue-actions.ts; re-exported here
// so the "../store" barrel and its consumers keep a single import surface.
export { dropQueueMsg, editQueueMsg, sendNowQueueMsg, requeueSteerMsg, reorderQueueMsg } from "./queue-actions";


// ---------- Streaming delta coalesced rendering: many frames within a 100ms window swap the reference once (prevents high-frequency re-renders from saturating the main thread) ----------
// Delta frames mutate the current session object in place (no set, invisible to zustand, zero
// renders); at window close each accumulated session gets one shallow copy and reference swap, and
// subscribers re-render together — same semantics as the old "mutate + delayed notify".
const pendingDelta = new Set<string>();
let deltaRenderTimer: TimerHandle | undefined;
export function applyDelta(sessionId: string, fn: (s: OpenSession) => void): void {
  const s = findBySessionId(sessionId);
  if (!s) return;
  fn(s);
  pendingDelta.add(sessionId);
  if (deltaRenderTimer) return;
  deltaRenderTimer = setTimeout(() => {
    deltaRenderTimer = undefined;
    const ids = [...pendingDelta];
    pendingDelta.clear();
    for (const id of ids) updateSession(id, () => {}, true); // withItems: the items array reference must swap too, or subscribers keyed on items never re-render (streaming would freeze)
  }, 100);
}

// ---------- Event-stream position guard (consumer side of the host's stamped hi/seq) ----------
// A hi change = the host process restarted: clear dead streaming state in all sessions (ghost
// spinners / half-finished drafts) so leftovers from the old instance never wedge the view; within
// the same hi, frames with a behind-position seq are dropped (drop, not merge, for behind-position
// frames); gaps only warn without dropping (reconnect hole-filling is unimplemented, observing for now).
// Module-level event watermark: nothing in the UI subscribes to it, so keeping it out of the
// store saves re-running every subscribed selector once per token (it only gates frame
// admission here). Reset alongside evtHost — a host restart resets the position stream.
let evtSeq = 0;

export function hostInstanceReset(hi: string | null, seq: number): void {
  evtSeq = seq; // the watermark follows the host instance: reset paths included
  useAppStore.setState((st) => {
    if (st.evtHost === null || st.evtHost === hi) {
      return { evtHost: hi };
    }
    // Align with turn_end teardown (a dead host = every turn waits forever for a turn_end that never comes)
    const openSessions = new Map<string, OpenSession>();
    for (const [p, s] of st.openSessions) {
      const next = { ...s, items: s.items.slice() }; // copy items too: resetting running mutates items
      next.assistantDraft = "";
      next.streaming = false;
      next.workingText = null;
      next.turnItemStart = null;
      next.turnStartAt = null;
      next.pendingApprovals = [];
      clearRunningTools(next);
      for (const sub of next.subagents.values()) {
        sub.streaming = false;
        for (const t of sub.tools) t.running = false;
      }
      openSessions.set(p, next);
    }
    return { openSessions, poolSessions: [], busyPaths: new Set(), poolPaths: new Set(), evtHost: hi };
  });
}

/** Position-stamp subset carried by stamped frames (only stampEvent frames have hi/seq) */
interface EventStampFields {
  hi?: string;
  seq?: number;
}

export function admitStampedEvent(msg: EventStampFields): boolean {
  const st = useAppStore.getState();
  if (st.evtHost !== msg.hi) {
    // hi/seq are stamped in pairs (host/host.ts:659-662); falling back to null/0 when missing is a
    // type-level fallback only, unreachable at runtime
    hostInstanceReset(msg.hi ?? null, msg.seq ?? 0);
    return true;
  }
  const seq = msg.seq!; // stamped frames always have seq (same as above); the assertion only tightens the type, runtime semantics match the original
  if (seq <= evtSeq) return false; // behind position: drop
  if (seq > evtSeq + 1) console.warn(`[evt] 跳号 ${evtSeq} → ${seq}（按序放行，仅观测）`);
  evtSeq = seq;
  return true;
}

// ---------- Optimistic run start (the single local run-start write; sunk from the composer, A14) ----------
/** The single way a run starts locally: insert the user bubble (images when present) and flip the
 *  running state right away — the elapsed clock and the stop button appear at send time; the host
 *  turn_start keeps the origin instead of resetting it. Shared by the composer pipeline
 *  (composer/send.ts), the pendingNewPrompt consumption and the automation user_message echo. */
export function startLocalRun(
  sessionId: string,
  text: string,
  images?: UserItem["images"],
  automation?: UserItem["automation"],
): void {
  updateSession(sessionId, (s) => {
    s.items.push({ role: "user", text, ...(images && images.length > 0 ? { images } : {}), ...(automation ? { automation } : {}) });
    s.streaming = true;
    s.turnStartAt = Date.now();
  });
}

/** Image bubble payload extracted from prompt attachments (wire image entries only). */
export function bubbleImages(files: PromptAttachment[] | null | undefined): UserItem["images"] {
  return (files ?? [])
    .filter((f) => f.kind === "image" && typeof f.data === "string")
    .map((f) => ({ type: "image", data: f.data as string, mimeType: f.mime || "image/png" }));
}

/** Optimistic run start + prompt dispatch over the wire (steer flag rides along). */
export function dispatchPrompt(sessionId: string, text: string, files: PromptAttachment[], steer?: boolean): void {
  startLocalRun(sessionId, text, bubbleImages(files));
  send({ type: "prompt", sessionId, text, files, ...(steer ? { steer: true } : {}) });
}

/** Promote stranded pending-steer bubbles at a fresh run's turn_start. A steer
 *  sent while the UI still showed streaming can race the run's real end: the
 *  base then ignores streamingBehavior and opens a plain new turn, no
 *  steer_consumed ever fires, and the runEnd seal folds the bubble into a
 *  collapsed loop group. This fallback (piercing groups, same extraction as
 *  applySteerConsumed) is a no-op on every well-behaved path: consumption
 *  already cleared pending before turn_start, and direct prompts never create
 *  a pending bubble. */
function promoteStrandedSteerBubbles(s: OpenSession): void {
  const stranded: UserItem[] = [];
  for (let i = s.items.length - 1; i >= 0; i--) {
    const x = s.items[i];
    if (x.role === "loop") {
      const inner = x.items ?? [];
      for (let j = inner.length - 1; j >= 0; j--) {
        const k = inner[j];
        if (k.role === "user" && k.pending) {
          inner.splice(j, 1);
          stranded.push(k);
        }
      }
      if (inner.length === 0) s.items.splice(i, 1);
    } else if (x.role === "user" && x.pending) {
      s.items.splice(i, 1);
      stranded.push(x);
    }
  }
  for (const b of stranded) {
    b.pending = null;
    b.steerDone = true;
    s.items.push(b);
    const st2 = s.steering ?? [];
    const j = st2.findIndex((m) => (m.text || "") === b.text);
    if (j >= 0) st2.splice(j, 1);
  }
}

// ---------- event frame handling (all kind branches of the old onMessage case "event"; immutable updates via updateSession) ----------
// Target row for a live tool frame: call id first, display name as the fallback (older frames may
// lack the id); zero-copy reverse scans since the chat list can be long.
function findToolRow(s: OpenSession, toolCallId?: string, name?: string): ToolItem | undefined {
  return (
    findLast(s.items, (it): it is ToolItem => it.role === "tool" && !!it.toolCallId && it.toolCallId === toolCallId) ||
    findLast(s.items, (it): it is ToolItem => it.role === "tool" && (it.name || it.text) === name)
  );
}

export function applyEvent(msg: EventFrame): void {
  const st = useAppStore.getState();
  if (msg.kind === "turn_start") {
    updateSession(
      msg.sessionId,
      (s) => {
        s.streaming = true;
        s.assistantDraft = "";
        // Keep the previous tool's intent showing through in-run continuation turns (the gap
        // between a finished tool and the next model response); only the run's first turn
        // (workingText still null from local send) falls back to the generic label
        s.workingText = s.workingText ?? t("notify.working");
        // Initialize the process start and clock only on the run's first turn: in-run continuations
        // (tool loops) don't reset, otherwise every model turn would form its own group and
        // duration/usage would be per-turn (live vs reloaded views would diverge);
        // the start may already be preset by local sending (send = start the clock), don't overwrite
        if (s.turnItemStart == null) {
          // Degenerated steer (raced the run's end): no steer_consumed will
          // come, rescue its bubble before this run's process starts
          promoteStrandedSteerBubbles(s);
          s.turnStartAt = s.turnStartAt ?? Date.now();
          // A UI that attached mid-run missed the run's first turn_start; the first one it
          // sees is a tool-loop continuation's, which would split the run's fold at the attach
          // moment. Anchor at the turn's leading user message instead so sealRunItems folds
          // the whole run like the reload path; a partial-turn loop group already in the items
          // (transcript rebuilt mid-run) lands inside the range and is un-nested by the seal.
          let anchor = s.items.length;
          for (let i = s.items.length - 1; i >= 0; i--) {
            if (s.items[i].role === "user") { anchor = i + 1; break; }
          }
          s.turnItemStart = anchor;
        }
      },
      false,
    );
  } else if (msg.kind === "user_message") {
    // Host-side send echo (another channel's prompt, an automation run, or this
    // channel's own degenerate-idle prompt — BUG-080 half: the message was queued
    // on a stale streaming flag and drew no optimistic bubble). Dedup against the
    // sender's optimistic bubble: the tail user row without an entryId carrying
    // the same text IS that bubble, so the echo never doubles it.
    const cur = findBySessionId(msg.sessionId);
    const dupe = findLast(cur?.items ?? [], (it): it is UserItem => it.role === "user" && !it.entryId && it.text === msg.text);
    if (!dupe) startLocalRun(msg.sessionId, msg.text, msg.images, msg.automation);
  } else if (msg.kind === "text_delta") {
    applyDelta(msg.sessionId, (s) => {
      s.assistantDraft += msg.text;
    });
  } else if (msg.kind === "thinking") {
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
        s.items.push({ role: "assistant", text: s.assistantDraft });
      }
      s.assistantDraft = "";
      if (msg.phase === "start") {
        s.workingText = t("notify.thinking");
        s.items.push({ role: "thinking", text: t("notify.thinkingLabel"), thinking: "", streaming: true, expanded: st.uiPrefs.showThinking });
      } else {
        const last = findLast(s.items, (it): it is ThinkingItem => it.role === "thinking");
        if (last) {
          last.text = t("notify.thinkingDone", { label: msg.durationLabel || t("notify.thinkingTookSeconds") });
          last.thinking = msg.thinking || "";
          last.expandable = !!msg.expandable;
          last.streaming = false;
          last.expanded = false; // collapse the label when thinking completes
        }
        s.workingText = t("notify.working");
      }
    });
  } else if (msg.kind === "thinking_delta") {
    // Only touch fields of the last thinking item; mutate in place, references swap together at the 100ms window flush
    applyDelta(msg.sessionId, (s) => {
      const last = findLast(s.items, (it): it is ThinkingItem => it.role === "thinking" && !!it.streaming);
      if (last) last.thinking = (last.thinking || "") + msg.text;
    });
  } else if (msg.kind === "tool") {
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
        s.items.push({ role: "assistant", text: s.assistantDraft });
      }
      s.assistantDraft = "";
      const toolItem: SessionItem = {
        role: "tool",
        text: msg.name,
        name: msg.name,
        toolCallId: msg.toolCallId,
        // wire shape is Record<string, unknown>; narrowed here to the supertype of the fields this repo reads
        args: msg.args as ToolArgs | undefined,
        intent: msg.intent,
        files: msg.files,
        // The tool frame = the tool starts executing (args arrived, result not yet); only the
        // tool_update frame sets it back to false. Set for every tool unconditionally: the result
        // slot renders a Spin placeholder while running; "no output" is judged only when not running
        running: true,
      };
      // "expand while running" (Ctrl+O): the output card stays expanded during the run, tool_update collapses it at the end
      if (st.uiPrefs.expandToolOutput) toolItem[toolExpandKey(msg.name)] = true;
      s.items.push(toolItem);
      if (msg.intent) s.workingText = msg.intent;
      else if (msg.name === "wait") s.workingText = t("notify.waiting"); // wait tool declares intent "optional" — show what it blocks on
    });
  } else if (msg.kind === "tool_update") {
    updateSession(msg.sessionId, (s) => {
      const last = findToolRow(s, msg.toolCallId, msg.name);
      if (last) {
        if (msg.files) last.files = uniqueFiles(msg.files);
        if (msg.added != null) last.added = msg.added;
        if (msg.removed != null) last.removed = msg.removed;
        if (msg.todo) last.todo = msg.todo;
        if (msg.output != null) last.output = msg.output;
        if (msg.details != null) last.details = msg.details as ToolDetails; // wire is unknown; narrowed to the supertype of the fields this repo reads
        if (msg.diffContent != null) last.diffContent = msg.diffContent; // the tool's real diff for this call; edit-row inline expansion prefers it
        last.running = false;
        // "expand while running": collapse at the end (the card auto-expanded during the run)
        if (st.uiPrefs.expandToolOutput) last[toolExpandKey(last.name)] = false;
      }
    });
  } else if (msg.kind === "tool_details") {
    // In-flight details refresh from a returned async tool (task spawn progress): the row is
    // already settled, so touch details only — never running/expand state.
    updateSession(msg.sessionId, (s) => {
      const last = findToolRow(s, msg.toolCallId, msg.name);
      if (last && msg.details != null) last.details = msg.details as ToolDetails;
    });
  } else if (msg.kind === "turn_end") {
    // In-run frames (runEnd:false, each model turn of a tool loop): only settle the draft, no
    // sealing, no clock stop — the whole run's process belongs to one loop group, intermediate
    // assistants stay inside the group (matching the reloaded view)
    if (!msg.runEnd) {
      updateSession(msg.sessionId, (s) => {
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
          // msg.final: this turn ended stopReason "stop" — a delivered output, lifted at seal
          s.items.push({ role: "assistant", text: s.assistantDraft, ...(msg.final ? { turnFinal: true } : {}) });
        }
        s.assistantDraft = "";
      });
      return;
    }
    // Run teardown frame (mapped from the host's agent_end; usage is already the whole-run total,
    // duration counts from turnStartAt): seal once + backfill entryIds. Reset running tools before
    // sealing — interrupted/error paths may never see a tool_update; without the reset the rows
    // keep an eternal spinner
    // Read the run's outward result BEFORE sealing: the base auto-retries a failed request and
    // keeps running, so a mid-run failure row sits above the retry's own output — only a tail
    // error row means this run was interrupted by the failure. Output streamed after that row
    // is still in assistantDraft until the seal flushes it.
    const pre = findBySessionId(msg.sessionId);
    const endedWithError = pre && !isJunkPlaceholder(pre.assistantDraft) ? null : endingErrorText(pre?.items ?? []);
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
      s.assistantDraft = "";
      // When an AbortSignal ends the wait, the host sends no separate approval_resolved; clean up leftover requests at turn end.
      s.pendingApprovals = [];
      s.streaming = false;
      s.workingText = null;
      clearRunningTools(s);
      sealRunItems(s, msg.usage);
      // After persisting completes, the host sticks the entryId of this run's user message back on
      // (addressing key of the message row's fork button); attach it to the last user message of
      // this run without an entryId (the optimistically inserted one)
      if (msg.userEntryId) {
        const u = findLast(s.items, (it): it is UserItem => it.role === "user" && !it.entryId);
        if (u) u.entryId = msg.userEntryId;
      }
      // entryId of the assistant at the end of this run's output (addressing key of the
      // .turn-acts fork button): after sealing, intermediate assistants are inside the loop group,
      // only this turn-final output remains at top level
      if (msg.assistantEntryId) {
        const a = findLast(s.items, (it): it is AssistantItem => it.role === "assistant" && !it.entryId);
        if (a) a.entryId = msg.assistantEntryId;
      }
      // End timestamp of this run (shown at the output tail): the live path takes the runEnd
      // arrival time, the reload path is backfilled by the host from the on-disk entry timestamp;
      // both agree
      const tailA = findLast(s.items, (it): it is AssistantItem => it.role === "assistant");
      if (tailA && tailA.endMs == null) tailA.endMs = Date.now();
      s.turnItemStart = null; // the run is fully over, stop accumulating
      s.turnStartAt = null;
    });
    // ---- Side effects (after the data update; updateSession already carries the _v bump) ----
    const st2 = useAppStore.getState();
    const s = findBySessionId(msg.sessionId);
    if (!s) return;
    // A new turn has been persisted (post-navigation chat lands here too): the entry tree is stale, the session-tree page refetches on next render
    if (st2.entryTree?.sessionId === msg.sessionId) {
      useAppStore.setState((st3) => ({ entryTree: null }));
    }
    send({ type: "list_sessions" }); // title/firstMessage may have changed
    if (s.isGit) st2.refreshGitDiff(true); // the agent may have changed files, force a refetch
    // Session finished: mark sessions other than the one being viewed as "unseen"; the list shows a dimmed dot
    const p = [...st2.openSessions.entries()].find(([, v]) => v === s)?.[0];
    if (p && p !== st2.activePath) {
      useAppStore.setState((st3) => ({ unseenFinished: new Set(st3.unseenFinished).add(p) }));
      useAppStore.getState().saveUnseen();
    }
    // Background session finished → desktop alert: the title comes from the session title in the
    // on-disk list (notify.bgSessionTitle when not listed). An interrupted run alerts as "error"
    // with the failure text (the error frame itself stays silent: the base retries it); a
    // completed one alerts with the last assistant text truncated to 80 chars as the summary
    // (notify.finished when absent).
    const summary =
      endedWithError ??
      ((findLast(s.items, (it): it is AssistantItem => it.role === "assistant" && !isJunkPlaceholder(it.text))?.text || "").trim() ||
        t("notify.finished"));
    notifyDesktop(endedWithError === null ? "turn_end" : "error", s, alertTitle(s), summary.length > 80 ? `${summary.slice(0, 80)}…` : summary);
    // One extra eviction pass after this session leaves streaming state: when a new session is
    // opened while every session is running, the eviction loop deletes nothing because "streaming
    // sessions are protected"; if eviction only triggered at activation, those sessions would keep
    // holding memory after finishing until the user's next session switch. Placed at the end of the
    // runEnd block — the unread marking and system notification above depend on s still being in
    // openSessions (unseenFinished reverse-looks-up the path from the Map). Use the delayed variant:
    // the host may immediately continue the run, and synchronous eviction would kick the session out
    // before the resumed-run frames arrive.
    scheduleEvict();
  } else if (msg.kind === "thinking_level") {
    // Auto-level resolution frame: only records the resolved level for the bottom-right "auto · level" display; does not touch s.thinking
    if (msg.configured === "auto") {
      updateSession(
        msg.sessionId,
        (s) => {
          s.autoResolved = msg.resolved;
        },
        false,
      );
    }
  } else if (msg.kind === "mention") {
    // @ mention persisted read-back: fileMention messages have no streaming-event counterpart; the host re-reads the session file at agent_end and re-sends it
    updateSession(msg.sessionId, (s) => {
      s.items.push({ role: "mention", text: "", files: msg.files || [] });
    });
  } else if (msg.kind === "advisor") {
    // Advice batch: a row at its injection point (mid-run blocker, or the run-boundary
    // batch). Not folded into a loop group — the renderer lifts blockers out of the
    // turn's closing card based on where this row lands.
    updateSession(msg.sessionId, (s) => {
      s.items.push({ role: "advisor", text: "", notes: msg.notes });
    });
  } else if (msg.kind === "ttsr") {
    // TTSR rule injection: a read-only notice at the interruption point. The prose the rewind
    // cut off settles first, mirroring the host transcript (it flushed the draft before pushing
    // the row), so live and reloaded order agree.
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
      s.assistantDraft = "";
      s.items.push({ role: "ttsr", text: msg.rules.map((r) => r.name).join(", "), rules: msg.rules });
    });
  } else if (msg.kind === "error") {
    // Provider/request failure (quota, auth, transport): one row of its own.
    // Settle the in-flight draft first so text produced before the failure stays above it.
    // No alert here: the base auto-retries most failures and the run keeps going — the
    // turn_end branch alerts only when the failure actually ended the run.
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
      s.assistantDraft = "";
      s.items.push({ role: "error", text: msg.text });
    });
  }
}

/** Field patch for an entry inside a session (used by batch-C components: item-level toggles like
 *  tool-row expansion / loop collapse). Recurses through loop groups to locate the first matching
 *  item, copying arrays along the way and mutating the copy, then swaps the openSessions reference. */
export function patchSessionItem(sessionId: string, match: (it: SessionItem) => boolean, patch: (it: SessionItem) => void): void {
  const walk = (list: SessionItem[]): SessionItem[] | null => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (match(it)) {
        const next = list.slice();
        const copy = { ...it };
        patch(copy);
        next[i] = copy;
        return next;
      }
      if (it.role === "loop" && it.items) {
        const inner = walk(it.items);
        if (inner) {
          const next = list.slice();
          next[i] = { ...it, items: inner };
          return next;
        }
      }
    }
    return null;
  };
  updateSession(sessionId, (s) => {
    const items = walk(s.items);
    if (items) s.items = items;
  });
}

// ---------- steer_consumed frame handling (queue consumption is the split point; moved over from the onMessage case; immutable update) ----------
export function applySteerConsumed(msg: { sessionId: string; texts?: string[] }): void {
  const prev = findBySessionId(msg.sessionId);
  if (!prev) return;
  updateSession(msg.sessionId, (s) => {
    const bubbles: { bubble: UserItem; loop?: LoopItem }[] = [];
    // Bubble lookup must pierce loop groups: turn_end may arrive before this frame and seal the bubble into a group
    const findBubble = (t: string): { bubble: UserItem; loop?: LoopItem } | null => {
      for (let i = s.items.length - 1; i >= 0; i--) {
        const x = s.items[i];
        if (x.role === "loop") {
          const hit = findLast(x.items ?? [], (it): it is UserItem => it.role === "user" && !!it.pending && it.text === t);
          if (hit) return { bubble: hit, loop: x };
        } else if (x.role === "user" && x.pending && x.text === t) {
          return { bubble: x };
        }
      }
      return null;
    };
    for (const t of msg.texts ?? []) {
      const found = findBubble(t);
      if (!found && findLast(s.items, (x): x is UserItem => x.role === "user" && !!x.steerDone && x.text === t)) {
        // Duplicate consumption frame (RPC double-push): the text already has a promoted bubble — don't repaint it
        continue;
      }
      const q = s.queued ?? [], st2 = s.steering ?? [];
      const i = q.findIndex((m) => (m.text || "") === t);
      const j = st2.findIndex((m) => (m.text || "") === t);
      const images = i >= 0 ? q[i]?.images : j >= 0 ? st2[j]?.images : undefined; // queue row images -> fallback bubble
      bubbles.push(found ?? { bubble: { role: "user", text: t, ...(images ? { images } : {}) } });
      if (i >= 0) q.splice(i, 1);
      if (j >= 0) st2.splice(j, 1);
    }
    const done: UserItem[] = [];
    for (const b of bubbles) {
      const bubble = b.bubble;
      const k = s.items.indexOf(bubble);
      if (k >= 0) s.items.splice(k, 1);
      else if (b.loop) {
        const items = b.loop.items ?? []; // a loop item always has its items array (established when the group was assembled)
        const ki = items.indexOf(bubble);
        if (ki >= 0) items.splice(ki, 1);
        if (items.length === 0) {
          const li = s.items.indexOf(b.loop);
          if (li >= 0) s.items.splice(li, 1);
        }
      }
      bubble.pending = null;
      bubble.steerDone = true;
      done.push(bubble);
    }
    if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
    s.assistantDraft = "";
    sealRunItems(s, null);
    for (const b of done) s.items.push(b);
    s.turnItemStart = s.items.length;
    s.streaming = true;
    s.workingText = t("notify.working");
    s.turnStartAt = Date.now();
  });
}

/** Rebuild the transcript from a messages frame (wholesale replacement after compact/branch/navigate/load; immutable update) */
export function rebuildMessages(msg: MessagesFrame): void {
  const prev = findBySessionId(msg.sessionId);
  if (!prev) return;
  updateSession(msg.sessionId, (s) => {
    // In-flight separator rows are not part of the transcript; keep them at the tail on rebuild; if the persisted done row of the same command already arrived, they're absorbed
    const pendingPhases = s.items.filter(
      (it) =>
        it.role === "phase" &&
        it.phase === "start" &&
        !msg.messages.some((m) => m.role === "phase" && m.phase === "done" && m.command === it.command),
    );
    // Wire entries (TranscriptItem, role is a string union) asserted one by one into the local discriminated union: field names share the same origin (host/state.ts)
    s.items = msg.messages.map((m) => ({ ...m }) as SessionItem).concat(pendingPhases);
  });
  // The transcript was wholesale-replaced (after compact/branch/navigate): the entry tree necessarily changed, invalidate it so the next render refetches
  const st = useAppStore.getState();
  if (st.entryTree?.sessionId === msg.sessionId) {
    useAppStore.setState((st2) => ({ entryTree: null }));
  }
}
