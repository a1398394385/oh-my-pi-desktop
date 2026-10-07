// Session slice: the openSessions container and the current-session pointer, the model catalog
// container, the event-stream guard (hi/seq), event frame handling, queued/steer messages, the LRU
// gate, system notifications. Moved over from store.ts (P3 wave 2).
// Transitional: container references stay constant (mutate + bump fallback; references get swapped
// in wave 3 when components switch to selectors).
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { invoke } from "./ws";
// Per-session right panel snapshots: activateSession is the single funnel for all session
// activations, so save/restore hooks live here (right.ts also imports activeOpen from this
// module — both directions are runtime-only calls inside function bodies, no load-time eval)
import { saveRightSlot, restoreRightSlot } from "./right";
import { t } from "../i18n";
import type { ApprovalMode, EventFrame, MessagesFrame, PromptAttachment, TurnUsage } from "../types/frames";
import type { AssistantItem, ChatItem, LoopItem, OpenSession, ThinkingItem, ToolArgs, ToolDetails, ToolItem, UserItem } from "../types/session";
import type { SessionItem } from "../types/session";

// Send helper via the ws slice (stable reference, equivalent to the old top-level send)
const send = (obj: unknown): void => {
  useAppStore.getState().send(obj);
};

/** setTimeout handle (DOM vs Node return types differ; unified alias) */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface SessionSlice {
  activePath: string | null;
  selectedSubagent: string | null;
  approvalMode: ApprovalMode;
  evtHost: string | null; // host process instance id (ready.hi / stamped event .hi); a change means the host restarted
  evtSeq: number; // highest applied event sequence number under this instance (events behind the position are dropped outright)
  pendingCreate: boolean;
  pendingNewPrompt: { text: string; files: PromptAttachment[] } | null;
  // ! bash command submitted on the welcome page: executed right after the
  // auto-created session lands (session_created handler)
  pendingNewBash: { command: string; excludeFromContext: boolean } | null;
  openSessions: Map<string, OpenSession>; // path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...}
  // Latest word-completion reply (complete_text RPC): overwritten per frame;
  // GhostTextPlugin matches it against its pending request and drops stale hits
  completionResult: CompletionResult | null;
  // Background job snapshots per session id (18.5 bg_jobs frames; full-replace semantics)
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
  command: string | null;
  cwd: string | null;
  pids: number[];
  exitCode: number | null;
  running: boolean;
}

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = () => ({
  activePath: null,
  selectedSubagent: null,
  approvalMode: "always-ask",
  evtHost: null,
  evtSeq: 0,
  pendingCreate: false,
  pendingNewPrompt: null,
  pendingNewBash: null,
  openSessions: new Map(),
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
  useAppStore.setState((st) => {
    let hit: string | undefined;
    for (const [p, v] of st.openSessions) {
      if (v.sessionId === sessionId) {
        hit = p;
        break;
      }
    }
    if (hit === undefined) return {};
    const cur = st.openSessions.get(hit);
    if (!cur) return {};
    const next = withItems ? { ...cur, items: cur.items.slice() } : { ...cur };
    fn(next);
    return { openSessions: new Map(st.openSessions).set(hit, next) };
  });
}

// ---------- Locating and activating ----------
export function activeOpen(): OpenSession | undefined {
  const st = useAppStore.getState();
  return st.activePath ? st.openSessions.get(st.activePath) : undefined;
}

export function findBySessionId(id: string): OpenSession | undefined {
  for (const s of useAppStore.getState().openSessions.values()) if (s.sessionId === id) return s;
  return undefined;
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
  const prev = useAppStore.getState().activePath;
  if (prev !== path) saveRightSlot(prev); // same-path re-activation: neither save nor restore
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
  useAppStore.setState({ isCreatingNew: false });
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
  // Pool boundary: tell the host to drop the evicted sessions' MCP mounts
  // (idempotent; switching back re-mounts through the load_session path)
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

// ---------- Run sealing / queued messages (moved over from core.js; render calls now bump) ----------
// Seal the process of the current run from turnItemStart into a loop group (the intermediate
// assistant stays outside the group) and reset turnItemStart past the group: used both for the
// pre-seal when a user message is inserted mid-stream and for the resumed run after steer consumption
export function sealRunItems(s: OpenSession, usage?: TurnUsage | null): void {
  const startIdx = s.turnItemStart ?? s.items.length;
  const runItems = s.items.splice(startIdx);
  // Error rows stay outside the loop group: the run's process may collapse, the
  // reason it stopped must not (same layout as the reload path).
  const errors: SessionItem[] = [];
  for (let i = runItems.length - 1; i >= 0; i--) {
    const it = runItems[i];
    if (it.role !== "error") break;
    errors.unshift(it);
    runItems.splice(i, 1);
  }
  let lastA = -1;
  for (let i = runItems.length - 1; i >= 0; i--) {
    if (runItems[i].role === "assistant") {
      lastA = i;
      break;
    }
  }
  const finalOut = lastA >= 0 ? runItems.splice(lastA, 1) : [];
  if (runItems.length) {
    s.items.push({
      role: "loop",
      text: "",
      collapsed: true,
      items: runItems,
      durationSec: s.turnStartAt ? Math.round((Date.now() - s.turnStartAt) / 1000) : null,
      usage: usage ?? null,
    });
  }
  s.items.push(...finalOut, ...errors);
  s.turnItemStart = s.items.length;
}

function queueIndexOf(list: { text?: string }[] | undefined, text: string | undefined): number {
  return (list ?? []).findIndex((m) => (m.text || "") === text);
}

// Delete: dequeue + remove the bubble. Queue bubbles are always user entries (the pending marker
// only lands on UserItem); non-user entries hit the early return (never happens at runtime, exists
// only to narrow the discriminated union)
export function dropQueueMsg(s: OpenSession, item: SessionItem): void {
  if (item.role !== "user") return;
  const which = item.pending === "steer" ? "steering" : "followUp";
  const list = which === "steering" ? s.steering : s.queued;
  const i = queueIndexOf(list, item.text);
  if (i < 0 || !list) return; // when i >= 0 the list must exist (queueIndexOf always returns -1 for undefined)
  send({ type: "drop_queued", sessionId: s.sessionId, queue: which, index: i });
  updateSession(s.sessionId, (next) => {
    const l = which === "steering" ? next.steering : next.queued;
    const ni = queueIndexOf(l, item.text);
    if (ni >= 0 && l) l.splice(ni, 1); // re-look up after the update (concurrent frames may have changed the queue meanwhile)
    const j = next.items.lastIndexOf(item);
    if (j >= 0) next.items.splice(j, 1);
  });
}

// Edit: put the content back into the composer (composerSetSignal is consumed by a Composer effect), then delete
export function editQueueMsg(s: OpenSession, item: SessionItem): void {
  useAppStore.getState().setComposerValue(item.text ?? "");
  dropQueueMsg(s, item);
}

// Send now: switch from queued to steer state. No process truncation, no pre-seal — the split only
// happens at consumption time (steer_consumed seals the whole process above the bubble into a loop
// group); the bubble is pinned by the render layer at the bottom of the message stream
export function sendNowQueueMsg(s: OpenSession, item: SessionItem): void {
  const i = queueIndexOf(s.queued, item.text);
  if (i < 0) return;
  send({ type: "send_now", sessionId: s.sessionId, index: i });
  updateSession(s.sessionId, (next) => {
    const ni = queueIndexOf(next.queued, item.text);
    if (ni >= 0 && next.queued) next.queued.splice(ni, 1);
    next.steering = next.steering ?? [];
    next.steering.push({ text: item.text });
    next.items.push({ role: "user", text: item.text, pending: "steer" });
  });
}

// Requeue: switch steer state back to the head of the queue, removing the bubble (the message lives only in the queue card)
export function requeueSteerMsg(s: OpenSession, item: SessionItem): void {
  const i = queueIndexOf(s.steering, item.text);
  if (i < 0) return;
  send({ type: "requeue", sessionId: s.sessionId, index: i });
  updateSession(s.sessionId, (next) => {
    const ni = queueIndexOf(next.steering, item.text);
    if (ni >= 0 && next.steering) next.steering.splice(ni, 1);
    next.queued = next.queued ?? [];
    next.queued.unshift({ text: item.text });
    const j = next.items.lastIndexOf(item);
    if (j >= 0) next.items.splice(j, 1);
  });
}

// ---------- System notifications (Tauri shell send_desktop_notification; duplicated events → 10s dedupe) ----------
const notifyLastAt = new Map<string, number>();
export function notifyDesktop(kind: string, s: OpenSession, title: string, body: string): void {
  const now = Date.now();
  const key = `${s.sessionId}:${kind}`;
  if (now - (notifyLastAt.get(key) ?? 0) < 10_000) return;
  notifyLastAt.set(key, now);
  if (!invoke) return; // non-Tauri environment (browser direct-connect debugging): feature absent, skip silently
  const st = useAppStore.getState();
  const path = [...st.openSessions.entries()].find(([, v]) => v === s)?.[0];
  if (path === st.activePath && document.hasFocus()) return;
  invoke("send_desktop_notification", { title, body, sessionId: s.sessionId }).catch((err: unknown) =>
    console.warn("send_desktop_notification:", err),
  );
}

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
    for (const id of ids) updateSession(id, () => {}, false); // empty patch: the shallow copy + reference swap is the notification
  }, 100);
}

// ---------- Event-stream position guard (consumer side of the host's stamped hi/seq) ----------
// A hi change = the host process restarted: clear dead streaming state in all sessions (ghost
// spinners / half-finished drafts) so leftovers from the old instance never wedge the view; within
// the same hi, frames with a behind-position seq are dropped (drop, not merge, for behind-position
// frames); gaps only warn without dropping (reconnect hole-filling is unimplemented, observing for now).
export function hostInstanceReset(hi: string | null, seq: number): void {
  useAppStore.setState((st) => {
    if (st.evtHost === null || st.evtHost === hi) {
      return { evtHost: hi, evtSeq: seq };
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
    return { openSessions, evtHost: hi, evtSeq: seq };
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
  if (seq <= st.evtSeq) return false; // behind position: drop
  if (seq > st.evtSeq + 1) console.warn(`[evt] 跳号 ${st.evtSeq} → ${seq}（按序放行，仅观测）`);
  useAppStore.setState({ evtSeq: seq });
  return true;
}

// ---------- event frame handling (all kind branches of the old onMessage case "event"; immutable updates via updateSession) ----------
export function applyEvent(msg: EventFrame): void {
  const st = useAppStore.getState();
  if (msg.kind === "turn_start") {
    updateSession(
      msg.sessionId,
      (s) => {
        s.streaming = true;
        s.assistantDraft = "";
        s.workingText = t("notify.working");
        // Initialize the process start and clock only on the run's first turn: in-run continuations
        // (tool loops) don't reset, otherwise every model turn would form its own group and
        // duration/usage would be per-turn (live vs reloaded views would diverge);
        // the start may already be preset by local sending (send = start the clock), don't overwrite
        if (s.turnItemStart == null) {
          s.turnStartAt = s.turnStartAt ?? Date.now();
          s.turnItemStart = s.items.length;
        }
      },
      false,
    );
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
        const last = [...s.items].reverse().find((it): it is ThinkingItem => it.role === "thinking");
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
      const last = [...s.items].reverse().find((it): it is ThinkingItem => it.role === "thinking" && !!it.streaming);
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
      const last =
        [...s.items].reverse().find((it): it is ToolItem => it.role === "tool" && !!it.toolCallId && it.toolCallId === msg.toolCallId) ||
        [...s.items].reverse().find((it): it is ToolItem => it.role === "tool" && (it.name || it.text) === msg.name);
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
  } else if (msg.kind === "turn_end") {
    // In-run frames (runEnd:false, each model turn of a tool loop): only settle the draft, no
    // sealing, no clock stop — the whole run's process belongs to one loop group, intermediate
    // assistants stay inside the group (matching the reloaded view)
    if (!msg.runEnd) {
      updateSession(msg.sessionId, (s) => {
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
        s.assistantDraft = "";
      });
      return;
    }
    // Run teardown frame (mapped from the host's agent_end; usage is already the whole-run total,
    // duration counts from turnStartAt): seal once + backfill entryIds. Reset running tools before
    // sealing — interrupted/error paths may never see a tool_update; without the reset the rows
    // keep an eternal spinner
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
        const u = [...s.items].reverse().find((it): it is UserItem => it.role === "user" && !it.entryId);
        if (u) u.entryId = msg.userEntryId;
      }
      // entryId of the assistant at the end of this run's output (addressing key of the
      // .turn-acts fork button): after sealing, intermediate assistants are inside the loop group,
      // only this turn-final output remains at top level
      if (msg.assistantEntryId) {
        const a = [...s.items].reverse().find((it): it is AssistantItem => it.role === "assistant" && !it.entryId);
        if (a) a.entryId = msg.assistantEntryId;
      }
      // End timestamp of this run (shown at the output tail): the live path takes the runEnd
      // arrival time, the reload path is backfilled by the host from the on-disk entry timestamp;
      // both agree
      const tailA = [...s.items].reverse().find((it): it is AssistantItem => it.role === "assistant");
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
    // Background session finished → system notification: the title comes from the session title in
    // the on-disk list (notify.bgSessionTitle when not listed), the body is the last assistant text
    // truncated to 80 chars as the summary (notify.finished when absent)
    const lastA = [...s.items].reverse().find((it) => it.role === "assistant" && !isJunkPlaceholder(it.text));
    const summary = (lastA?.text || "").trim();
    notifyDesktop(
      "turn_end",
      s,
      st2.diskProjects.flatMap((pr) => pr.sessions).find((x) => x.id === s.sessionId)?.title || t("notify.bgSessionTitle"),
      summary ? (summary.length > 80 ? summary.slice(0, 80) + "…" : summary) : t("notify.finished"),
    );
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
  } else if (msg.kind === "error") {
    // Provider/request failure (quota, auth, transport): one row of its own.
    // Settle the in-flight draft first so text produced before the failure stays above it.
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
          const hit = [...(x.items ?? [])]
            .reverse()
            .find((k): k is UserItem => k.role === "user" && !!k.pending && k.text === t);
          if (hit) return { bubble: hit, loop: x };
        } else if (x.role === "user" && x.pending && x.text === t) {
          return { bubble: x };
        }
      }
      return null;
    };
    for (const t of msg.texts ?? []) {
      const found = findBubble(t);
      // Duplicate consumption frame (RPC double-push): skip if the text already has a promoted bubble; don't repaint it
      if (!found && [...s.items].reverse().some((x) => x.role === "user" && x.steerDone && x.text === t)) continue;
      bubbles.push(found ?? { bubble: { role: "user", text: t } });
      const q = s.queued ?? [];
      const i = q.findIndex((m) => (m.text || "") === t);
      if (i >= 0) q.splice(i, 1);
      const st2 = s.steering ?? [];
      const j = st2.findIndex((m) => (m.text || "") === t);
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
