// Session snapshot assembly: the frame family pushed right after a
// session_created (goal / todos / context usage / whole-session stats), the
// throttled live stats push, and the single constructor for the
// session_created frame body itself (previously hand-copied at the spawn /
// pool-reuse / disk-rebuild emit sites). Split out of session-lifecycle.ts
// (A12, pure relocation).
import { sessions, stampEvent, type PoolEntry } from "./state.ts";
import { ACP_SUMMARY_CUSTOM_TYPE } from "./acp-persist.ts";

/** Goal state frame: shown in the session state card's goal area (pushes null when there is no goal; the frontend hides the separator too). */
export function pushGoal(sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.uiSockets.size === 0) return;
  const state = entry.session.getGoalModeState();
  const data = JSON.stringify({
    type: "goal",
    sessionId,
    goal: state?.goal
      ? {
          objective: state.goal.objective,
          status: state.goal.status,
          enabled: state.enabled === true,
          tokenBudget: state.goal.tokenBudget ?? null,
          tokensUsed: state.goal.tokensUsed,
          timeUsedSeconds: state.goal.timeUsedSeconds,
          costUsed: entry.goal.costUsed,
        }
      : null,
  });
  for (const w of entry.uiSockets) w.send(data);
}

/** Todos frame: pushed on both cold load and pool reuse (TodoTracker already synced from the transcript branch at construction).
    The frontend relies on it to backfill history after rebuilding objects on session_created; empty lists are not pushed (no card). */
export function pushTodos(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const phases = entry.session.getTodoPhases();
  if (phases.length > 0) {
    ws.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases })));
  }
}

export function pushContext(ws: any, sessionId: string, entry: PoolEntry) {
  const u = entry.session.getContextUsage();
  if (u) {
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "context",
          sessionId,
          tokens: u.tokens,
          window: u.contextWindow,
          percent: u.percent,
        }),
      ),
    );
  }
}

// Session cumulative stats (the token/cache/cost/time segments of the TUI
// status line, summed): displayed permanently on the status row below the
// composer. Unlike the context detail card (get_context_detail's
// breakdown/stats), this is whole-session scope: tokens include the
// accumulated history, duration includes the in-flight window
//
// Token figures come from sessionManager.getUsageStatistics() (the index-level
// cumulative counter the TUI status line itself reads in
// #buildSegmentContext), NOT from session.getSessionStats(): the latter filters
// model_usage entries down to the *active window* (session-stats.ts
// activeModelUsageEntries — after a compaction/reset it only counts entries from
// firstKeptEntryId onward). That windowed view is right for "current context
// window" but wrong for a whole-session cumulative row: every compaction would
// chop off the pre-compaction history and the numbers would jump backwards. The
// index-level #usage accumulates per entry on insert and is never windowed,
// so it is monotonic.
//
// Prompt-cache invalidation count for the session stats bar: a session's cached
// prefix normally grows monotonically (each turn appends to the cached prefix),
// so a cacheRead drop to under half of the session peak means the prefix was
// lost — model switch, cache TTL expiry, keepalive break — and the whole
// context was re-billed as uncached input. Count one break per event: re-arm
// only after cacheRead climbs back to the peak, and while broken let the peak
// follow a shrinking baseline so a later break still registers.
//
// A context compaction (base compaction entry or ACP compaction block) rewrites
// the request prefix on purpose, so the low cacheRead of the next billed turn
// is an expected consequence, not a lost prefix: the drop is folded into the
// compaction counter instead of the break count.
const CACHE_BREAK_MIN_PEAK = 1000;

/** Journal entry shape the stats bar scans (assistant usage plus compaction markers). */
interface StatsScanEntry {
  type?: string;
  customType?: string;
  message?: { role?: string; usage?: { cacheRead?: number; totalTokens?: number } };
}

/** Base compaction entry (manual /compact, /handoff, plan approval, auto-compaction) or an ACP compaction block. */
function isCompactionEntry(item: { type?: string; customType?: string }): boolean {
  return item.type === "compaction" || (item.type === "custom" && item.customType === ACP_SUMMARY_CUSTOM_TYPE);
}

/** Context compactions this session ran (both chains), counted separately from cache breaks. */
export function countCompactions(entries: ReadonlyArray<{ type?: string; customType?: string }>): number {
  let compactions = 0;
  for (const item of entries) if (isCompactionEntry(item)) compactions++;
  return compactions;
}

export function countCacheBreaks(entries: ReadonlyArray<StatsScanEntry>): number {
  let peak = 0;
  let last = 0;
  let broken = false;
  let breaks = 0;
  let compacted = false;
  for (const item of entries) {
    if (isCompactionEntry(item)) {
      // Re-baseline on the next billed request instead of counting the break
      compacted = true;
      continue;
    }
    if (item?.type !== "message" || item.message?.role !== "assistant") continue;
    const usage = item.message.usage;
    // A turn aborted before it billed anything (empty content, stopReason
    // "aborted") never reached the provider, so its zero cacheRead is not a
    // lost prefix — counting it registers a break that never happened. Every
    // real request folds cacheRead into totalTokens, so that is the test.
    if (typeof usage?.totalTokens !== "number" || usage.totalTokens <= 0) continue;
    const read = usage.cacheRead;
    const cacheRead = typeof read === "number" && Number.isFinite(read) ? read : 0;
    if (compacted) {
      compacted = false;
      peak = cacheRead;
      broken = false;
      last = cacheRead;
      continue;
    }
    if (cacheRead >= peak) {
      peak = cacheRead;
      broken = false;
    } else if (broken) {
      if (cacheRead > last) peak = cacheRead;
    } else if (peak >= CACHE_BREAK_MIN_PEAK && cacheRead < peak * 0.5) {
      breaks++;
      broken = true;
    }
    last = cacheRead;
  }
  return breaks;
}

export function buildSessionStats(entry: PoolEntry) {
  const now = Date.now();
  const usage = entry.manager.getUsageStatistics();
  // Cache hit rate (same formula as the TUI's cache_hit segment):
  // cacheRead/(cacheRead+cacheWrite+input). The denominator includes missed
  // input, so both Anthropic/OpenRouter (misses recorded as input) and
  // DeepSeek (misses recorded as input with cacheWrite at 0) reduce to
  // hit/(hit+miss)
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;

  let totalAssistantDuration = 0;
  let totalAssistantOutput = 0;
  let totalTtft = 0;
  let ttftCount = 0;

  const entries: any[] = typeof entry.manager?.getEntries === "function" ? entry.manager.getEntries() : [];
  const cacheBreaks = countCacheBreaks(entries);
  const compactions = countCompactions(entries);
  for (const item of entries) {
    if (item?.type === "message" && item.message?.role === "assistant") {
      const msg = item.message;
      if (typeof msg.ttft === "number" && Number.isFinite(msg.ttft) && msg.ttft > 0) {
        totalTtft += msg.ttft;
        ttftCount++;
      }
      const dur = typeof msg.duration === "number" && Number.isFinite(msg.duration) ? msg.duration : 0;
      const out = typeof msg.usage?.output === "number" && Number.isFinite(msg.usage.output) ? msg.usage.output : 0;
      if (dur > 0 && out > 0) {
        totalAssistantDuration += dur;
        totalAssistantOutput += out;
      }
    }
  }

  const tokenSpeed =
    totalAssistantDuration > 0
      ? (totalAssistantOutput * 1000) / totalAssistantDuration
      : typeof (entry.session as any)?.tokenRate?.rate === "function"
        ? (entry.session as any).tokenRate.rate()
        : null;
  const avgTtft = ttftCount > 0 ? totalTtft / ttftCount : null;

  return {
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    cost: usage.cost,
    // Portion of `cost` the base already folded in from completed `task` results (blocking
    // spawns' spend only). The stats bar subtracts its overlap with the live children it
    // shows, so a blocking child is not billed twice.
    subagentCost: usage.subagentCost ?? 0,
    cacheHitRate: promptTokens > 0 ? usage.cacheRead / promptTokens : 0,
    cacheBreaks,
    compactions,
    // Same as the TUI's cost segment: session total cost = main session cost + advisor cost (0 when no advisor)
    advisorCost: entry.session.getAdvisorCost(),
    // Same-clock stamp as activeMs (sampled in the same call): the frontend extrapolates
    // the duration from this instant, so the frame's transport/queueing delay cannot
    // rewind the displayed figure
    statsAt: now,
    // Active duration includes the in-flight window (matching TUI getActiveMs: idle wall time excluded)
    activeMs: entry.activeMs + (entry.activeStartedAt === null ? 0 : now - entry.activeStartedAt),
    tokenSpeed,
    avgTtft,
  };
}

export function pushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  ws.send(JSON.stringify({ type: "session_stats", sessionId, ...buildSessionStats(entry) }));
}

// Min interval between live stats pushes: a tool-heavy turn can emit dozens of
// tool_execution_end events; pushing each one would flood the wire with stats
// frames (and recompute the usage snapshot every time). The first event of a
// turn pushes immediately so the numbers start moving right away; later events
// in the same turn are coalesced by this interval.
const STATS_PUSH_MIN_INTERVAL_MS = 1500;

export function maybePushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  const now = Date.now();
  if (entry.statsPushedAt !== null && now - entry.statsPushedAt < STATS_PUSH_MIN_INTERVAL_MS) return;
  entry.statsPushedAt = now;
  pushSessionStats(ws, sessionId, entry);
}

// session_created frame body, single constructor for all three emit sites
// (spawnSession / pool reuse / disk rebuild in session-lifecycle.ts — A12
// collapsed the three hand copies). Branch differences are explicit opt-ins,
// mirroring the exact per-site field sets:
//   - automation: scheduler-spawned session — stamps the automation slot and
//     flags the frame background so the UI registers it without stealing
//     focus (spawn path only).
//   - subagentLineage: appends the isSubagent/parentPath pair derived from
//     the parent session file on disk (both load paths; the spawn path never
//     carries it — a fresh session has no parent).
// cwd reads entry.cwd: createSessionCore stamps it with the spawn workDir, so
// this is the same value the spawn site used to inline.
export function buildSessionCreatedFrame(
  sessionId: string,
  entry: PoolEntry,
  extras: { automation?: { id: string; title: string; computer?: boolean }; subagentLineage?: boolean } = {},
) {
  return {
    type: "session_created",
    sessionId,
    path: entry.path,
    cwd: entry.cwd,
    model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
    thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
    isGit: entry.isGit,
    title: entry.title ?? null,
    // Automation-spawned: the UI registers the slot but must not activate it
    // (no focus steal, automations view stays open)
    ...(extras.automation ? { automation: extras.automation, background: true } : {}),
    ...(extras.subagentLineage ? { isSubagent: entry.isSubagent, parentPath: entry.parentPath } : {}),
  };
}
