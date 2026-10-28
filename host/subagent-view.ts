// Subagent roster view. The live side holds the registration/ownership
// tables (task toolCallId -> owner, subagentId -> spawn call / first task /
// wake-turn run totals) and the three eventBus subscriptions that assemble
// the subagent_lifecycle / subagent_progress / subagent_event frames; the
// disk side replays child transcript files into the same frames for sessions
// rebuilt from disk (whose event subscriptions never saw the live frames).
// Split out of session-lifecycle.ts (A12, pure relocation).
import path from "node:path";
import fs from "node:fs";
import { H, stampEvent, type PoolEntry } from "./state.ts";
import { translateSubagentEvent } from "./translate.ts";
import { entriesToTranscript, sumRunDurationMs } from "./translate-history.ts";
import { SessionManager } from "./bootstrap.ts";

// The whole spawn tree shares the root session's eventBus (sdk.ts:1341):
// subagent lifecycle/event/progress frames all travel on it. Derived data
// the host fills in (absent from AgentProgress itself):
//   registeredAt — when the lifecycle started frame arrived (the detail
//                  card's Registered timestamp)
//   name / parent — the task tool call's args carry the subagent name,
//                   toolCallId records the owner (root session = Main,
//                   inside a subagent stream = that subagent), and
//                   parentToolCallId reverse-looks-up "Spawned by X"
export function createSubagentView(ws: any, sessionId: string, entry: PoolEntry, eventBus: any): { unsubscribe(): void } {
  const subRegistered = new Map<string, number>(); // subagentId -> first started timestamp
  const subSpawnCall = new Map<string, string>(); // subagentId -> parent task toolCallId
  // A kept-alive subagent is re-run by IRC wake turns (base: attachIrcWakeTurnMonitor
  // creates a FRESH run monitor per wake), so its raw progress counters restart at
  // zero. Fold every finished run's totals and add them back onto the live run, or the
  // roster shows only the last (short) wake turn while subagent_event keeps accumulating.
  const subRunTotals = new Map<
    string,
    { requests: number; toolCount: number; cost: number; durationMs: number; tokens: Record<string, number> }
  >();
  const subFirstTask = new Map<string, string>(); // original assignment, kept across wake turns
  const callOwner = new Map<string, { owner: string; names: string[] }>(); // task toolCallId -> owner + spawned subagent names
  const spawnTools: Record<string, true> = { task: true, agent: true };
  const spawnNames = (args: Record<string, unknown>): string[] => {
    const items = Array.isArray(args.tasks) ? args.tasks : [args];
    return items.map((t) => (t && typeof t === "object" && "name" in t && typeof t.name === "string" ? t.name : undefined)).filter((n): n is string => !!n);
  };
  // Batch spawns (one task call, N tasks) carry every name; the run's `index` picks this
  // one, otherwise every roster row would read names[0].
  const subName = (id: string, agent: string, index?: number): string => {
    const call = callOwner.get(subSpawnCall.get(id) ?? "");
    return call?.names[index ?? 0] ?? call?.names[0] ?? agent;
  };
  const subParent = (id: string): string => {
    const spawnCall = subSpawnCall.get(id);
    if (!spawnCall) return "Main";
    const owner = callOwner.get(spawnCall);
    return owner?.owner ?? "Main";
  };
  // Task calls in the root session: owned by Main
  const unsubSpawnRoot = entry.session.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start" && spawnTools[ev.toolName]) {
      callOwner.set(ev.toolCallId, { owner: "Main", names: spawnNames(ev.args) });
    }
  });
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    if (p.parentToolCallId) subSpawnCall.set(p.id, p.parentToolCallId);
    // started fires once per run: the first one registers the subagent, later ones are
    // IRC wake turns reusing the id — archive the finished run instead of resetting
    // the roster's "Registered"/counters to the wake turn's zeroed progress.
    if (p.status === "started") {
      if (subRegistered.has(p.id)) archiveFinishedRun(p.id);
      else subRegistered.set(p.id, Date.now());
    }
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "subagent_lifecycle",
          sessionId,
          subagentId: p.id,
          agent: p.agent,
          description: p.description,
          status: p.status,
          name: subName(p.id, p.agent, p.index),
          parent: subParent(p.id),
          // Child transcript file (agent hub Enter/double-click opens it; the base
          // payload carries it on every lifecycle emit — dropping it here left live
          // roster rows without a sessionFile until a host reload replayed history)
          sessionFile: p.sessionFile,
          detached: p.detached ?? false,
          // Terminal statuses carry the submitted report, read from the settled child
          // transcript (the lifecycle frame fires after the executor finalized it)
          result: p.status !== "started" && p.sessionFile ? readSubagentResult(p.sessionFile) : undefined,
        }),
      ),
    );
    // After a terminal-status frame, re-send the last progress frame (throttling may have swallowed it) so cost/tokens settle at final values
    if (p.status !== "started") {
      const last = subLastProgress.get(p.id);
      if (last) ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, ...last, status: p.status }));
    }
  });
  // Aggregate progress frames: cost/duration/requests/tools/tokens/context (high-frequency and cumulative, throttled at 500ms; status changes send immediately)
  const subLastProgress = new Map<string, Record<string, unknown>>();
  const subSentAt = new Map<string, number>();
  const subSentStatus = new Map<string, string>();
  // Fold the finished run's last progress into the subagent's running totals (called
  // when a wake turn starts a new run over the same id).
  const archiveFinishedRun = (id: string): void => {
    const last = subLastProgress.get(id) as
      | { requests?: number; toolCount?: number; cost?: number; durationMs?: number; tokens?: Record<string, number> }
      | undefined;
    if (!last) return;
    const totals = subRunTotals.get(id) ?? { requests: 0, toolCount: 0, cost: 0, durationMs: 0, tokens: {} };
    totals.requests += last.requests ?? 0;
    totals.toolCount += last.toolCount ?? 0;
    totals.cost += last.cost ?? 0;
    totals.durationMs += last.durationMs ?? 0;
    for (const [key, value] of Object.entries(last.tokens ?? {})) {
      if (typeof value === "number") totals.tokens[key] = (totals.tokens[key] ?? 0) + value;
    }
    subRunTotals.set(id, totals);
  };
  const mergeTokens = (
    totals: Record<string, number>,
    current: Record<string, number> | undefined,
  ): Record<string, number> => {
    const merged: Record<string, number> = { ...totals };
    for (const [key, value] of Object.entries(current ?? {})) {
      if (typeof value === "number") merged[key] = (merged[key] ?? 0) + value;
    }
    return merged;
  };
  const unsubProgress = eventBus.on("task:subagent:progress", (p: any) => {
    const pr = p.progress ?? {};
    // Subagent identity lives inside the progress object (AgentProgress.id) — the
    // channel payload's top level carries no id field (base contract; the TUI's
    // session-observer reads progress.id the same way)
    const subagentId: string | undefined = pr.id;
    if (!subagentId) return;
    const totals = subRunTotals.get(subagentId);
    const tokens = typeof pr.tokens === "number" ? { total: pr.tokens } : pr.tokens;
    const task = subFirstTask.get(subagentId) ?? pr.task;
    if (task && !subFirstTask.has(subagentId)) subFirstTask.set(subagentId, task);
    const payload = {
      agent: p.agent,
      // Child transcript file: the base emits it on the progress channel too (the
      // TUI registry collects it from either channel); the started lifecycle may
      // fire before the child session persists — this is where the path first appears
      sessionFile: p.sessionFile,
      status: pr.status,
      task,
      cost: totals ? totals.cost + (pr.cost ?? 0) : pr.cost,
      durationMs: totals ? totals.durationMs + (pr.durationMs ?? 0) : pr.durationMs,
      requests: totals ? totals.requests + (pr.requests ?? 0) : pr.requests,
      toolCount: totals ? totals.toolCount + (pr.toolCount ?? 0) : pr.toolCount,
      // Base progress.tokens is a plain cumulative number; the frontend contract
      // (and the history-replay path below) expects the bucketed shape
      tokens: totals ? mergeTokens(totals.tokens, tokens) : tokens,
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
    subLastProgress.set(subagentId, payload);
    const now = Date.now();
    const statusChanged = subSentStatus.get(subagentId) !== pr.status;
    if (!statusChanged && now - (subSentAt.get(subagentId) ?? 0) < 500) return;
    subSentAt.set(subagentId, now);
    subSentStatus.set(subagentId, pr.status);
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId, name: subName(subagentId, p.agent, pr.index), parent: subParent(subagentId), registeredAt: subRegistered.get(subagentId), ...payload }));
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    // Task calls inside a subagent stream: owned by that subagent (nested spawn)
    if (event.type === "tool_execution_start" && spawnTools[event.toolName]) {
      callOwner.set(event.toolCallId, { owner: subName(id, id), names: spawnNames(event.args) });
    }
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "subagent_event", sessionId, subagentId: id, ...ui })));
  });
  return {
    // Same teardown order the inline subscriptions used to have in
    // attachEntry's entry.unsubscribe (spawn root, then the three eventBus
    // channels).
    unsubscribe: () => {
      unsubSpawnRoot();
      unsubLifecycle();
      unsubProgress();
      unsubEvents();
    },
  };
}

// ---- Subagent history replay ----
// Child subagent runs persist as <session file minus .jsonl>/<subagent name>.jsonl (the SDK's
// artifact layout; each child header carries a parentSession backlink). Live sessions learn
// about them through the event subscriptions, but a session rebuilt from disk never sees those
// frames — scan the artifacts dir and re-emit lifecycle/progress (+ the tool stream for cold
// loads) so the right sidebar's subagent page reconstructs past runs. Synthesized ids take a
// hist- prefix: they can never collide with a live SDK subagentId.
const HIST_SUBAGENT_RECENT_MS = 60_000; // a file still being written belongs to a live subagent — skip, its frames arrive live

// Agent Hub "Result" section: the subagent's submitted report — the last
// assistant message carrying text (the same source the executor's salvage and
// lastReportTurnText draw from). Capped so the frame stays small; the UI
// section scrolls. Purely tool-call assistant messages keep the earlier text.
const SUBAGENT_RESULT_MAX_CHARS = 16000;
function readSubagentResult(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let result: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let e: HistEntry;
    try {
      e = JSON.parse(line) as HistEntry;
    } catch {
      continue;
    }
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const c = e.message.content;
    const t = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").filter(Boolean).join("\n") : "").trim();
    if (t) result = t;
  }
  if (!result) return undefined;
  return result.length > SUBAGENT_RESULT_MAX_CHARS ? result.slice(0, SUBAGENT_RESULT_MAX_CHARS) + "\n…" : result;
}

interface HistAggregation {
  title: string;
  registeredAt: number;
  readOnly?: boolean;
  status: string;
  result?: string;
  progress: Record<string, unknown>;
  toolEvents: Record<string, unknown>[];
}

// Minimal structural view of a persisted session entry; the file is our own SDK's JSONL, the
// try/catch-per-line scan plus optional chaining below keep a bad line from aborting the pass
interface HistEntry {
  type?: string;
  timestamp?: string;
  parentSession?: string;
  model?: string;
  readOnly?: boolean;
  message?: {
    role?: string;
    content?: string | { type?: string; text?: string }[];
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
    stopReason?: string;
    errorMessage?: string;
    isError?: boolean;
  };
  data?: { toolCallId?: string; toolName?: string; args?: unknown };
}

// The SDK wraps the subagent assignment in this fixed prefix (subagent-user-prompt.md) before
// it becomes the child's first user message; strip it so the replayed task matches live frames
const SUBAGENT_PROMPT_PREFIX = "Complete assignment thoroughly:\n\n";

// Parse one child session file into the aggregated progress payload + tool event stream;
// returns null when the file is not a child of parentSessionPath (foreign/corrupt)
function aggregateSubagentHistory(file: string, parentSessionPath: string): HistAggregation | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let isChild = false;
  const tombstoned = fs.existsSync(`${file}.tombstone`);
  let aborted = tombstoned;
  let lastStopReason: string | undefined;
  let lastIsError: boolean | undefined;
  const seenToolCalls = new Set<string>();
  const toolEvents: Record<string, unknown>[] = [];
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, total = 0, cost = 0, requests = 0;
  let lastContextTokens = 0; // final assistant turn's totalTokens — terminal context size (same semantics as the executor's progress.contextTokens)
  let model: string | null = null;
  let result: string | undefined;
  let task: string | undefined;
  let readOnly: boolean | undefined;
  let registeredAt = 0;
  let lastTs = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: HistEntry;
    try {
      e = JSON.parse(line) as HistEntry; // own SDK's persisted JSONL; fields read defensively below
    } catch {
      continue;
    }
    if (e.type === "session") {
      // Only true child session files carry the parentSession backlink; a stray top-level
      // session file (or a same-named foreign child) must not be replayed
      if (!e.parentSession || path.resolve(e.parentSession) !== path.resolve(parentSessionPath)) return null;
      isChild = true;
      registeredAt = Date.parse(e.timestamp ?? "") || 0;
      continue;
    }
    if (e.type === "session_init") {
      readOnly = e.readOnly === true;
      continue;
    }
    if (e.type === "model_change" && !model) model = e.model ?? null;
    if (e.type === "message" && e.message) {
      const ts = Date.parse(e.timestamp ?? "") || 0;
      if (ts > lastTs) lastTs = ts;
      if (e.message.role === "assistant") {
        lastStopReason = e.message.stopReason;
        if (e.message.stopReason === "aborted" || e.message.errorMessage === "Request was aborted") {
          aborted = true;
        }
        // Submitted report for the hub detail's Result section (same rule as
        // readSubagentResult: the last assistant message that carries text)
        const c = e.message.content;
        const t = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").filter(Boolean).join("\n") : "").trim();
        if (t) result = t;
      }
      if (e.message.role === "toolResult") {
        lastIsError = e.message.isError === true;
      }
      // The child's first user message is the (wrapped) assignment — recover the task text for
      // the roster/detail fallback chain (live runs get it from progress frames instead)
      if (task === undefined && e.message.role === "user") {
        const c = e.message.content;
        const text = Array.isArray(c)
          ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n")
          : (c ?? "");
        task = text.startsWith(SUBAGENT_PROMPT_PREFIX) ? text.slice(SUBAGENT_PROMPT_PREFIX.length) : text;
      }
      const u = e.message.usage;
      if (e.message.role === "assistant" && u) {
        requests++;
        input += u.input || 0;
        output += u.output || 0;
        cacheRead += u.cacheRead || 0;
        cacheWrite += u.cacheWrite || 0;
        total += u.totalTokens || 0;
        cost += u.cost?.total || 0;
        if (u.totalTokens && u.totalTokens > 0) lastContextTokens = u.totalTokens;
      }
      continue;
    }
    if (e.type === "custom" && e.data?.toolCallId && e.data?.toolName) {
      if (seenToolCalls.has(e.data.toolCallId)) continue; // duplicate record of the same call
      seenToolCalls.add(e.data.toolCallId);
      toolEvents.push({ kind: "tool", name: e.data.toolName, toolCallId: e.data.toolCallId, args: e.data.args });
      toolEvents.push({ kind: "tool_update", name: e.data.toolName, toolCallId: e.data.toolCallId, running: false });
    }
  }
  if (!isChild) return null;
  const status: "completed" | "aborted" | "failed" =
    aborted
      ? "aborted"
      : lastStopReason === "error" || lastIsError
        ? "failed"
        : "completed";

  return {
    title: path.basename(file, ".jsonl"),
    registeredAt,
    readOnly,
    status,
    result: result && result.length > SUBAGENT_RESULT_MAX_CHARS ? result.slice(0, SUBAGENT_RESULT_MAX_CHARS) + "\n…" : result,
    progress: {
      status,
      task,
      cost,
      durationMs: Math.max(0, lastTs - registeredAt),
      requests,
      toolCount: seenToolCalls.size,
      tokens: { input, output, cacheRead, cacheWrite, total },
      contextTokens: lastContextTokens || undefined,
      contextWindow: modelRegistryContextWindow(model),
      resolvedModel: model,
    },
    toolEvents,
  };
}

// Context window for a replayed subagent's model: live registry lookup (the
// same fields host/models.ts reads off the base model objects)
function modelRegistryContextWindow(model: string | null): number | undefined {
  if (!model) return undefined;
  const entry = H.availableModels.find((m) => `${m.provider}/${m.id}` === model) as
    | { contextWindow?: number; contextLength?: number }
    | undefined;
  const w = entry?.contextWindow ?? entry?.contextLength;
  return typeof w === "number" && w > 0 ? w : undefined;
}

// includeTools: also replay the per-tool event stream (cold loads where the frontend store is
// guaranteed empty). Same-store switch-backs must pass false — replaying tool events would
// append duplicates next to the live entries.
export function replaySubagentHistory(ws: any, sessionPath: string, sessionId: string, includeTools: boolean) {
  if (!sessionPath.endsWith(".jsonl")) return;
  let names: string[];
  try {
    names = fs.readdirSync(sessionPath.slice(0, -".jsonl".length));
  } catch {
    return; // no artifacts dir: the session never spawned subagents (or pre-artifact base)
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionPath.slice(0, -".jsonl".length), name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      // Still being written = a live subagent of a pooled session; its real frames arrive through subscriptions
      if (Date.now() - fs.statSync(file).mtimeMs < HIST_SUBAGENT_RECENT_MS) continue;
    } catch {
      continue;
    }
    const agg = aggregateSubagentHistory(file, sessionPath);
    if (!agg) continue;
    const subagentId = "hist-" + name.slice(0, -".jsonl".length);
    ws.send(
      JSON.stringify({
        type: "subagent_lifecycle",
        sessionId,
        subagentId,
        agent: agg.title,
        description: "",
        status: agg.status,
        name: agg.title,
        parent: "Main",
        registeredAt: agg.registeredAt,
        sessionFile: file,
        readOnly: agg.readOnly,
        result: agg.result,
        advisor: path.basename(file).startsWith("__advisor"),
      }),
    );
    if (includeTools) {
      for (const ev of agg.toolEvents) ws.send(JSON.stringify({ type: "subagent_event", sessionId, subagentId, ...ev }));
    }
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId, registeredAt: agg.registeredAt, ...agg.progress }));
  }
}

// A child transcript is also appended to by the SDK's own subagent session (and by a CLI on
// the same file), while this pool only accumulates events while a socket is attached: the
// entry's transcript freezes at the last detach, and reopening it pushed a snapshot cut off
// mid-run — neither the wake-turn prompt nor the child's final report (BUG-111). Re-read the
// file when its tail moved past the in-memory index; a still-streaming entry owns the newer
// state itself.
export async function resyncSubagentTranscript(entry: PoolEntry): Promise<void> {
  if (!entry.isSubagent || entry.session.isStreaming) return;
  const disk = await SessionManager.open(entry.path);
  const diskEntries = disk.getEntries();
  if (diskEntries.at(-1)?.id !== entry.manager.getEntries().at(-1)?.id) {
    entry.transcript = entriesToTranscript(diskEntries);
    entry.activeMs = sumRunDurationMs(diskEntries);
  }
  await disk.close();
}
