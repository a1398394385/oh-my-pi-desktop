// Session lifecycle domain: the create/load entry points (pool reuse vs disk
// rebuild), event wiring (attachEntry's approval UI context + extension
// runner injection + subagent eventBus forwarding + realtime queue push +
// session-file transfer notices), and the snapshot push family
// (goal/todos/context/stats). Relocated from main.ts (second split cut).
import path from "node:path";
import fs from "node:fs";
import {
  createAgentSession,
  AgentRegistry,
  SessionManager,
  USER_INTERRUPT_LABEL,
  isUserQueuedMessage,
  toRestoredQueuedMessage,
} from "./bootstrap.ts";
import {
  H,
  sessions,
  defaultCwd,
  stampEvent,
  pendingApprovals,
  requestApproval,
  pushCommandOutput,
  type PoolEntry,
  type TranscriptItem,
} from "./state.ts";
import { GoalController, type GoalSession } from "./goal.ts";
import { AcpSessionState, parseAcpContextWindow } from "./acp-state.ts";
import { createAcpContextExtension, ACP_SYSTEM_PROMPT } from "./acp-context.ts";
import { createAcpCompressTools } from "./acp-tools.ts";
import { createSessionContextTools } from "./session-context.ts";
import { translateEvent, translateSubagentEvent, entriesToTranscript, sumRunDurationMs } from "./translate.ts";
import { readKeepaliveEnabled } from "./keepalive-config.ts";
import type { KeepaliveState } from "./keepalive.ts";
import { snapshotMcp } from "./capabilities.ts";
import { readAcpRaw, readAcpEnabled, readAcpNudgeConfig, readSessionContextEnabled } from "./profile.ts";
import { readPluginsEnabled, readHooksEnabled } from "./assets.ts";
import { createKeepaliveExtension } from "./keepalive.ts";
import { sendQueued, releaseOneParked } from "./queue.ts";
import { pushPlanMode, reconcilePlanMode, setPlanMode } from "./plan.ts";
import { pushComputerMode, setComputerMode } from "./computer-mode.ts";
import { dispatchFromToolEnd, installProposalHandler, setFreshSessionFactory } from "./plan-approve.ts";
import { hostI18n } from "../ui-src/i18n/host.ts";
import { mountMcpForSession } from "./mcp-mount.ts";
import { safeStderr } from "./stderr.ts";

/** keepalive_status frame body (shared by the RPC reply and the reportState push). */
export function keepaliveStatusPayload(sessionId: string, state: KeepaliveState | undefined) {
  return {
    type: "keepalive_status" as const,
    sessionId,
    enabled: state !== undefined && readKeepaliveEnabled(),
    active: state?.active ?? false,
    probes: state?.probes ?? 0,
    hits: state?.hits ?? 0,
    misses: state?.misses ?? 0,
    errors: state?.errors ?? 0,
    savedUsd: state?.savedUsd ?? 0,
    spendUsd: state?.spendUsd ?? 0,
    nextProbeAt: state?.nextProbeAt ?? null,
  };
}
export function isGitWorktree(cwd: string): boolean {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

// Disk resolution for sessions outside the pool: scans all session files
// (same source as list_sessions) and matches the file path by the base's
// session id. Used for rename/archive and similar operations on unopened
// history sessions.
export async function sessionPathFromDisk(sessionId: string): Promise<string> {
  const hit = (await SessionManager.listAll()).find((s: any) => s.id === sessionId);
  if (!hit) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  return hit.path;
}

// Copy a session's artifacts dir (generated code snippets, charts, etc.): the extension-less directory named after the session file
export async function copySessionArtifactsIfAny(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
  if (!sourceSessionFile.endsWith(".jsonl") || !destinationSessionFile.endsWith(".jsonl")) return;
  const srcDir = sourceSessionFile.slice(0, -6);
  const dstDir = destinationSessionFile.slice(0, -6);
  if (path.resolve(srcDir) === path.resolve(dstDir)) return;
  try {
    const st = await fs.promises.stat(srcDir);
    if (st.isDirectory()) {
      await fs.promises.cp(srcDir, dstDir, { recursive: true });
    }
  } catch {}
}

/** Goal state frame: shown in the session state card's goal area (pushes null when there is no goal; the frontend hides the separator too). */
function pushGoal(sessionId: string) {
  const entry = sessions.get(sessionId);
  const w = entry?.attachedWs as { send(data: string): unknown } | null;
  if (!entry || !w) return;
  const state = entry.session.getGoalModeState();
  w.send(
    JSON.stringify({
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
    }),
  );
}

/** Todos frame: pushed on both cold load and pool reuse (TodoTracker already synced from the transcript branch at construction).
    The frontend relies on it to backfill history after rebuilding objects on session_created; empty lists are not pushed (no card). */
function pushTodos(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
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
function buildSessionStats(entry: PoolEntry) {
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
    cacheHitRate: promptTokens > 0 ? usage.cacheRead / promptTokens : 0,
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

function pushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  ws.send(JSON.stringify({ type: "session_stats", sessionId, ...buildSessionStats(entry) }));
}

// Min interval between live stats pushes: a tool-heavy turn can emit dozens of
// tool_execution_end events; pushing each one would flood the wire with stats
// frames (and recompute the usage snapshot every time). The first event of a
// turn pushes immediately so the numbers start moving right away; later events
// in the same turn are coalesced by this interval.
const STATS_PUSH_MIN_INTERVAL_MS = 1500;

function maybePushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  const now = Date.now();
  if (entry.statsPushedAt !== null && now - entry.statsPushedAt < STATS_PUSH_MIN_INTERVAL_MS) return;
  entry.statsPushedAt = now;
  pushSessionStats(ws, sessionId, entry);
}

export async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[], initialModel?: any) {
  const acpState = new AcpSessionState();
  // Master switch on the experimental features page (omp-desktop.json's
  // acp.enabled, default off for new users): only decides whether this session injects the
  // ACP tool surface and the context view rewrite; it cannot hot-toggle
  // after session creation, so switch changes take effect on new sessions
  const acpEnabled = readAcpEnabled();
  // Past session retrieval switch (omp-desktop.json's sessionContext.enabled, default off for new users)
  const sessionContextEnabled = readSessionContextEnabled();
  // Cache keepalive switch (omp-desktop.json's keepalive.enabled, experimental
  // features page, default off). Double-load guard: when either the plugin
  // hub / hooks master switch is on, extension discovery loads the upstream
  // original keepalive from ~/.omp/plugins, so skip the embedded injection
  // to avoid two instances probing twice in one process
  const keepaliveOn = readKeepaliveEnabled() && !(readPluginsEnabled() || readHooksEnabled());
  // nudge denominator: omp-desktop.json's acp.contextWindow (a fixed value
  // like 2000000 / "1M") wins over the model registry window; if both are
  // unknown, nudge is disabled entirely
  const sessionModel = (initialModel ?? H.modelOverride) as { contextWindow?: number; contextLength?: number } | undefined;
  acpState.modelContextWindow =
    parseAcpContextWindow((readAcpRaw()?.acp as Record<string, unknown> | undefined)?.contextWindow) ||
    Number(sessionModel?.contextWindow ?? sessionModel?.contextLength ?? 0) ||
    0;
  acpState.nudge = readAcpNudgeConfig();
  // system prompt anti-replay section (acp.systemPrompt, can be enabled on
  // the experimental features page, default off): only appended when ACP is
  // enabled; opencode-acp injects it by default — here it is an explicit
  // switch left to the user
  const acpSystemPrompt = acpEnabled && (readAcpRaw().acp as { systemPrompt?: unknown } | undefined)?.systemPrompt === true;
  // Closure source for the keepalive extension's isWanted: the entry is
  // built only after createAgentSession, so reference it lazily via a
  // holder; a load hitting the pool reuses the same entry, and the unread
  // state lives with the entry
  const kaHolder: { entry?: PoolEntry } = {};
  const result = await createAgentSession({
    cwd,
    authStorage: H.authStorage,
    modelRegistry: H.modelRegistry,
    // Per-session settings child with computer use pinned OFF: the settings-page
    // computer.enabled switch is the master gate (checked at /computer dispatch
    // in rpc/prompt.ts) and a session opts in via /computer on — the config
    // value never auto-enables a desktop session. Other runtime overrides
    // (/extended-context, /browser headless, model-role pins) stay in this child
    // instead of leaking host-wide; config-layer reads still fall through to
    // H.settings live (Settings.overlay forwards parent changes to children).
    settings: H.settings.overlay({ "computer.enabled": false }),
    model: initialModel ?? H.modelOverride,
    systemPrompt: acpSystemPrompt ? (defaultPrompt: string[]) => [...defaultPrompt, ACP_SYSTEM_PROMPT] : undefined,
    agentRegistry: new AgentRegistry(), // The default global registry allows only one Main per generation; multiple sessions must pass a private instance
    sessionManager, // The host-side manager must be injected into the SDK: otherwise rename/compact/branch would go through entry.manager (an orphan instance) operating on a different session file
    // read_session_context (past session retrieval): reads only its own profile's sessions, see host/session-context.ts
    customTools: [
      ...(acpEnabled ? createAcpCompressTools(acpState) : []),
      ...(sessionContextEnabled ? createSessionContextTools() : []),
    ] as never, // ACP compress tools (compress/decompress/search_context/acp_status/acp_context_recap), see host/acp-tools.ts; omptype/ArkType schemas are brand-incompatible with the package's TSchema type, identical at runtime
    extensions: [
      ...(acpEnabled ? [createAcpContextExtension(acpState)] : []), // context event view transforms: ref injection + compress-block replacement, see host/acp-context.ts
      ...(keepaliveOn ? [createKeepaliveExtension({
        // Same kaHolder entry as isWanted: reports that fire before the entry
        // exists (extension injection happens inside createAgentSession) are
        // dropped; the entry ships a zeroed initial snapshot instead
        isWanted: () => kaHolder.entry?.keepaliveWanted === true,
        reportState: (s) => {
          const entry = kaHolder.entry;
          if (!entry) return;
          entry.keepaliveState = s;
          // Push the fresh snapshot so the context ring's center counter and
          // the detail card stay live without polling (report cadence is
          // per-probe/per-schedule, low frequency)
          const ws = entry.attachedWs as { readyState?: number; send?: (d: string) => void } | null;
          if (ws && ws.readyState === 1 && entry.keepaliveSid) {
            ws.send(JSON.stringify(stampEvent(keepaliveStatusPayload(entry.keepaliveSid, s))));
          }
        },
      })] : []), // prefix cache keepalive: idle sessions that are unread replay the last request, see host/keepalive.ts
    ] as never, // The inline extension's structural narrow type is brand-incompatible with the package's type signature, identical at runtime (same precedent as customTools)
    disableExtensionDiscovery: !(readPluginsEnabled() || readHooksEnabled()),
    enableMCP: false,
    hasUI: true, // The approval gate's fail-cold check goes through runner.hasUI(): without it, every approval-requiring tool errors out outright in non-yolo mode
  });
  const { session } = result;
  // Host-side runtime identity: a fresh pool UUID, deliberately NOT the disk
  // SessionInfo.id. Two reasons (base session-manager.ts): (1) persistence is lazy — a
  // brand-new session has no file/SessionInfo until its first assistant message, while
  // this key must route WS frames the moment the pool entry exists; (2) the disk id is
  // re-minted over the session's life (maintenance paths rename the file and rewrite the
  // header id), which would orphan a disk-id-keyed pool entry. Consequence for consumers:
  // matching a pool session against anything disk-derived (session_list rows, the
  // frontend's openSessions map, branch/fork results) must go by `path`, never by id —
  // the pool UUID and disk ids never coincide.
  const sessionId = crypto.randomUUID();
  const entry: PoolEntry = {
    session,
    sessionResult: result, // Host injection points such as setToolUIContext
    unsubscribe: () => {},
    attachedWs: null,
    providerSessionId: sessionManager.getSessionId?.() ?? sessionId, // Sticky key for the request-side getApiKey
    keepaliveWanted: false, // At creation the user is watching the new session: nothing unread, no keepalive; set true at turn wrap-up
    // Zeroed snapshot until the extension's first report; presence of the
    // field also marks the injection for get_keepalive_status (sessions
    // created while keepalive was off keep it undefined)
    keepaliveState: keepaliveOn
      ? { active: false, probes: 0, hits: 0, misses: 0, errors: 0, savedUsd: 0, spendUsd: 0, nextProbeAt: null }
      : undefined,
    transcript,
    assistantDraft: "", // Streaming text accumulated for the current turn, finalized at turn_end
    thinkingDraft: "",
    thinkingStartedAt: null,
    activeMs: 0,
    activeStartedAt: null,
    statsPushedAt: null,
    path: session.sessionFile,
    pollKnownSize: 0, // External-write detection: 0 = not first-scanned yet
    externalWrite: false,
    previousPaths: [], // Persistence-move history: old file locations keep resolving to this entry (see state.ts)
    cwd,
    isGit: isGitWorktree(cwd),
    parkedFollowUp: [], // follow-up parking lot (see the type comments in state.ts)
    consumedPending: new Set(), // consumed-but-uninjected queue texts (see the type comments in state.ts)
    mcpReleases: [], // pooled MCP mount handles (see mcp-mount.ts)
    mcpMountGen: 0, // fences async mounts completing after detach/eviction
    manager: sessionManager, // For RPCs that need to operate the SessionManager directly, like rename/compact
    title: sessionManager.getSessionName() ?? null,
    mentionScanIndex: 0,
    goal: new GoalController({
      // The SDK's concrete session type and the narrow interface are not fully structurally compatible in their generic signatures; converge to a named narrow interface at the boundary
      session: session as unknown as GoalSession,
      output: (text) => pushCommandOutput(sessionId, text),
      onChange: () => pushGoal(sessionId),
    }),
  };
  kaHolder.entry = entry; // The keepalive isWanted closure takes effect (see the top of createSessionCore)
  entry.keepaliveSid = sessionId; // reportState pushes need the id; the closure predates its generation
  // (18.4.9) Subagent control registry: accumulates subagent snapshots from
  // the session's observability bus (created here, before any subagent can
  // spawn, so control_subagent never misses an id); control_subagent resolves
  // live refs through it. The output sink is a no-op — the host already
  // forwards task:subagent:* channels into its own frames in attachEntry.
  // Dynamic import because a static one would hoist the SDK graph above
  // bootstrap's setProfile (profile red line; same reason every SDK handle
  // in bootstrap.ts is dynamically imported).
  const { RpcSubagentRegistry } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents");
  entry.subagentRegistry = new RpcSubagentRegistry(result.subagentEventBus ?? result.eventBus, () => {});
  // Fire-and-forget MCP mount: pooling boundaries only (create / first load /
  // switch-back after eviction) — never blocks the session's critical path
  void mountMcpForSession(sessionId, entry);
  return { sessionId, entry, eventBus: result.eventBus };
}

export function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  // Realtime queue push coalescing (shared by the onQueueChange subscription
  // below and the user message_start injection confirmation): bursts of queue
  // mutations (park + release + steer in one operation) coalesce into one
  // microtask push.
  let queuePushPending = false;
  const scheduleQueuePush = () => {
    if (queuePushPending) return;
    queuePushPending = true;
    queueMicrotask(() => {
      queuePushPending = false;
      sendQueued(ws, sessionId, entry);
    });
  };
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "event", sessionId, ...ui })));
    // After the todo tool persists, push the latest task list (TodoTracker updates after the tool result)
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      ws.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases: entry.session.getTodoPhases() })));
    }
    // Plan approval rides a `write` to xd://propose, dispatched OUT of band
    // exactly like the base TUI's event-controller (issue #7684): awaiting it
    // here would hold the subscription for the whole execution turn, and
    // awaiting the operator inside the tool handler would deadlock abort()'s
    // waitForIdle. Never awaited — see host/plan-approve.ts.
    if (ev.type === "tool_execution_end" && !ev.isError) {
      dispatchFromToolEnd(ws, sessionId, entry, ev.toolName, ev.result);
    }
    // Push context usage live on key execution events, updating the frontend's context-size ring
    if (ev.type === "message_end" || ev.type === "tool_execution_end") {
      pushContext(ws, sessionId, entry);
    }
    // The stats row refreshes live too: it used to be pushed only on agent_end
    // (turn end), which froze the token / cache-read / duration numbers under
    // the composer for the whole generation. These two events are the ones that
    // actually advance the index-level usage counter (each model turn end and
    // each tool completion), which is enough to keep the row moving with the
    // session. Throttling: see maybePushSessionStats.
    if (ev.type === "message_end" || ev.type === "tool_execution_end") {
      maybePushSessionStats(ws, sessionId, entry);
    }
    if (ev.type === "agent_start") entry.goal.onAgentStart();
    if (ev.type === "message_start" && ev.message?.role === "user" && !ev.message?.synthetic) {
      entry.goal.onUserMessage();
      // Injection confirmation for a consumed queued/steer message: the
      // preparation claim is released by now, so stop suppressing its text
      // and recalibrate the queue view (keeps abort-restored messages
      // visible). Empty set = ordinary direct prompt, no extra frame.
      if (entry.consumedPending.size > 0) {
        entry.consumedPending.clear();
        scheduleQueuePush();
      }
    }
    if (ev.type === "goal_updated") entry.goal.onGoalUpdated(ev.state);
    // (18.5) Prompt-cache warming lifecycle: the cache warmer's refresh
    // windows surface as session events; forward them so the UI can show a
    // "keeping cache warm" indicator on idle unread sessions
    if (ev.type === "cache_warming_start") {
      ws.send(JSON.stringify(stampEvent({ type: "cache_warming", sessionId, phase: "start" })));
    } else if (ev.type === "cache_warming_end") {
      ws.send(JSON.stringify(stampEvent({ type: "cache_warming", sessionId, phase: "end", outcome: ev.outcome })));
    }
    // Session active-duration timing (same as the TUI status-line
    // time_spent): agent_start opens the window (idempotent — re-entry does
    // not double-count), the truly-final agent_end closes it; intermediate
    // agent_end with isTerminal === false keeps running, so no close
    if (ev.type === "agent_start") {
      if (entry.activeStartedAt === null) entry.activeStartedAt = Date.now();
    } else if (ev.type === "agent_end" && ev.isTerminal !== false && entry.activeStartedAt !== null) {
      entry.activeMs += Math.max(0, Date.now() - entry.activeStartedAt);
      entry.activeStartedAt = null;
    }
    // After a turn truly ends, push context usage (messages are final by
    // then); also calibrate the queued rows (steer consumed)
    if (ev.type === "agent_end" && ev.isTerminal !== false) {
      // Cache keepalive: turn wrap-up = unread output exists, worth keeping
      // alive while idle from now on (the user's mark_seen / switching away
      // and back clears it)
      entry.keepaliveWanted = true;
      // Abort-restore visibility: cancelled preparation put its messages
      // back into the agent queues while their texts were still suppressed
      // from the queue view; the terminal-end calibration below must see the
      // unfiltered state
      entry.consumedPending.clear();
      // fileMention read-back: the base appends fileMention messages inside
      // prompt() (request array + persistence) with no matching event; scan
      // the new entries from mentionScanIndex onward here and turn them into
      // mention frames
      const entries = entry.manager.getEntries();
      for (let i = entry.mentionScanIndex; i < entries.length; i++) {
        const e = entries[i];
        if (e?.type === "message" && e.message?.role === "fileMention") {
          const files = (e.message.files ?? []).map((f: { path?: unknown }) => String(f.path ?? ""));
          entry.transcript.push({ role: "mention", text: "", files });
          ws.send(JSON.stringify({ type: "event", sessionId, kind: "mention", files }));
        }
      }
      entry.mentionScanIndex = entries.length;
      pushContext(ws, sessionId, entry);
      pushSessionStats(ws, sessionId, entry);
      // Goal final assessment: completion wind-down / no-progress suppression / scheduling the re-run (aligned with the TUI's #handleGoalSessionEvent)
      void entry.goal.onAgentEnd(ev.messages ?? []);
      // (18.5) The old wrap-up race fallback (queuedTexts/consumedTexts diff
      // + re-send of swallowed messages) is gone: the base now restores
      // undelivered queued messages itself on abort/wind-down
      // (pi-agent-core agent.ts #restoreUndeliveredQueuedMessages runs in the
      // run's finally, #cancelQueuedMessagePreparation restores live claims),
      // and every one of those restores fires onQueueChange, so the realtime
      // queue push below already mirrors the true queue state.
      const a = entry.session.agent as any;
      // Per-turn release: when parked entries remain, put 1 back and trigger
      // consumption (each its own independent turn)
      if (entry.parkedFollowUp.length > 0) {
        for (const m of releaseOneParked(entry)) a.followUp(m);
        // In the window where the agent_end event precedes the isStreaming reset, continue reports busy: retry once after idle
        a.continue().catch(() => {
          a.waitForIdle?.()
            .then(() => a.continue())
            .catch((err: unknown) => {
              safeStderr(`[host] 排队消息续轮触发失败: ${String(err)}\n`);
            });
        });
      }
      sendQueued(ws, sessionId, entry);
    }
  });
  // Approvals/dialogs: in non-yolo mode the approval gate suspends via ExtensionUIContext.select awaiting the user's choice
  const uiCtx = {
    // UI timeout for tools like ask counts from dialog presentation, not from when the tool invoked
    timeoutStartsOnPresentation: true,
    select(title: string, options: any[], dialogOptions?: any): Promise<string | undefined> {
      return requestApproval(
        ws,
        sessionId,
        title,
        options.map((o) => (typeof o === "string" ? o : o.label)),
        dialogOptions?.signal,
      );
    },
    confirm(title: string, message: string): Promise<boolean> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v === "OK");
        };
        pendingApprovals.set(requestId, { resolve: settle });
        ws.send(
          JSON.stringify(
            stampEvent({
              type: "approval_request",
              sessionId,
              requestId,
              title: `${title}\n${message}`,
              options: ["OK", "Cancel"],
            }),
          ),
        );
      });
    },
    editor(title: string, prefill?: string, dialogOptions?: any): Promise<string | undefined> {
      // ask's "Other" free-text input goes through here; a missing implementation kills the tool outright with undefined is not a function
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        // Stable option ids + editableIndex protocol field: the UI renders
        // localized labels from the ids and locates the inline input row by
        // index — the contract never depends on display text.
        ws.send(
          JSON.stringify(
            stampEvent({
              type: "approval_request",
              sessionId,
              requestId,
              title,
              options: ["submit", "cancel"],
              editable: true,
              editableIndex: 0,
              prefill: prefill ?? "",
            }),
          ),
        );
      });
    },
    // (18.5) Rich ask dialog: the ask tool with a questions array surfaces
    // here instead of per-question select() rounds. The frame reuses the
    // approval channel (options are the submit/cancel actions; the questions
    // ride the questions field); approval_response answers with
    // answer = JSON.stringify(ExtensionAskDialogSubmitResult). Aborts and
    // unknown answers resolve undefined (the base treats that as cancelled).
    askDialog(questions: unknown[], dialogOptions?: any): Promise<unknown> {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const requestId = crypto.randomUUID();
      const parseAskAnswer = (answer: string) => {
        try {
          const parsed = JSON.parse(answer) as { kind?: unknown };
          if (parsed && parsed.kind === "submit") return parsed;
        } catch {
          // Malformed submissions count as cancelled, not as an error frame
        }
        return undefined;
      };
      const settle = (v: string | undefined) => {
        pendingApprovals.delete(requestId);
        resolve(v === undefined ? undefined : parseAskAnswer(v));
      };
      pendingApprovals.set(requestId, { resolve: settle, questions });
      dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
      const first = (questions[0] ?? {}) as { header?: string; question?: string };
      ws.send(
        JSON.stringify(
          stampEvent({
            type: "approval_request",
            sessionId,
            requestId,
            title: first.header ?? first.question ?? "ask",
            options: ["submit", "cancel"],
            questions,
          }),
        ),
      );
      return promise;
    },
  };
  entry.sessionResult.setToolUIContext(uiCtx, true);
  // The crucial step (same as ACP, acp-agent.ts:2631): runner.hasUI() checks
  // the uiContext injected via initialize; calling only setToolUIContext is
  // not enough — the approval gate would fail closed with "no interactive
  // UI".
  //
  // actions / contextActions must be complete: runner.initialize assigns
  // contextActions.getModel directly to the internal #getModel (runner.ts:695,
  // no ?? fallback), so passing an empty object makes it undefined; any
  // customTool afterwards that evaluates ctx.model via
  // createCustomToolContext (sdk.ts:987) throws "getModel is not a function"
  // — measured 2026-09-23, read_session_context failed wholesale because of
  // this. The third argument must be undefined rather than an empty object:
  // an empty object would likewise assign undefined into #waitForIdleFn /
  // #newSessionHandler etc.; only undefined preserves the runner's no-op
  // defaults (runner.ts:704 `if (commandContextActions)`).
  entry.session.extensionRunner?.initialize(
    {
      sendMessage: (message, options) => {
        void entry.session.sendCustomMessage(message, options).catch((err: unknown) => {
          safeStderr(`[host] 扩展 sendMessage 失败: ${String(err)}\n`);
        });
      },
      sendUserMessage: (content, options) => {
        void entry.session.sendUserMessage(content, options);
      },
      appendEntry: (customType, data) => {
        entry.session.sessionManager.appendCustomEntry(customType, data);
      },
      setLabel: (targetId, label) => {
        entry.session.sessionManager.appendLabelChange(targetId, label);
      },
      getActiveTools: () => entry.session.getEnabledToolNames(),
      getAllTools: () => entry.session.getAllToolInfos(),
      setActiveTools: async (toolNames) => {
        await entry.session.setActiveToolsByName(toolNames);
      },
      // The desktop has no extension command surface: the UI command list goes through pushCommands' separate buildAvailableSlashCommands path
      getCommands: () => [],
      setModel: async (model) => {
        if (!(await entry.session.modelRegistry.getApiKey(model))) return false;
        await entry.session.setModel(model);
        return true;
      },
      getThinkingLevel: () => entry.session.thinkingLevel,
      setThinkingLevel: (level) => entry.session.setThinkingLevel(level),
      getServiceTiers: () => entry.session.serviceTierByFamily,
      setServiceTier: (family, tier) => entry.session.setServiceTierFamily(family, tier),
      getSessionName: () => entry.session.sessionManager.getSessionName(),
      setSessionName: async (name) => {
        await entry.session.sessionManager.setSessionName(name, "user");
      },
    },
    {
      getModel: () => entry.session.model,
      isIdle: () => !entry.session.isStreaming,
      abort: () => {
        void entry.session.abort({ reason: USER_INTERRUPT_LABEL });
      },
      hasPendingMessages: () => entry.session.queuedMessageCount > 0,
      shutdown: () => {},
      getContextUsage: () => entry.session.getContextUsage(),
      getSystemPrompt: () => entry.session.systemPrompt,
      compact: async () => {
        await entry.session.compact();
      },
    },
    undefined, // Command context actions: the desktop wires no extension command surface; keep the runner's default no-op
    uiCtx,
    "rpc",
  );

  // Session-start dispatch for extension observers: embedded hosts must emit
  // it themselves (TUI: extension-ui-controller / runtime-init.ts:212; ACP:
  // acp-agent.ts:2644). The desktop originally called initialize only — the
  // ACP precedent minus its trailing emit — so extensions keyed on
  // session_start (keepalive's probe-config load) never initialized and kept
  // their default empty-target config forever. Guarded: attachEntry re-runs on
  // pool reuse / frontend reload, and a repeat session_start resets extension
  // state (keepalive drops capture and timers).
  if (!entry.extSessionStarted) {
    entry.extSessionStarted = true;
    void entry.session.extensionRunner?.emit({ type: "session_start" });
  }

  // The whole spawn tree shares the root session's eventBus (sdk.ts:1341):
  // subagent lifecycle/event/progress frames all travel on it. Derived data
  // the host fills in (absent from AgentProgress itself):
  //   registeredAt — when the lifecycle started frame arrived (the detail
  //                  card's Registered timestamp)
  //   name / parent — the task tool call's args carry the subagent name,
  //                   toolCallId records the owner (root session = Main,
  //                   inside a subagent stream = that subagent), and
  //                   parentToolCallId reverse-looks-up "Spawned by X"
  const subRegistered = new Map<string, number>(); // subagentId -> started timestamp
  const subSpawnCall = new Map<string, string>(); // subagentId -> parent task toolCallId
  const callOwner = new Map<string, { owner: string; names: string[] }>(); // task toolCallId -> owner + spawned subagent names
  const spawnTools: Record<string, true> = { task: true, agent: true };
  const spawnNames = (args: Record<string, unknown>): string[] => {
    const items = Array.isArray(args.tasks) ? args.tasks : [args];
    return items.map((t) => (t && typeof t === "object" && "name" in t && typeof t.name === "string" ? t.name : undefined)).filter((n): n is string => !!n);
  };
  const subName = (id: string, agent: string): string => {
    const call = callOwner.get(subSpawnCall.get(id) ?? "");
    return call?.names[0] ?? agent;
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
    if (p.status === "started") subRegistered.set(p.id, Date.now());
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "subagent_lifecycle",
          sessionId,
          subagentId: p.id,
          agent: p.agent,
          description: p.description,
          status: p.status,
          name: subName(p.id, p.agent),
          parent: subParent(p.id),
          registeredAt: subRegistered.get(p.id),
          sessionFile: p.sessionFile ?? null,
          // Agent Hub "Changes" line flags, recovered from the transcript (see readSubagentInitFlags)
          readOnly: p.sessionFile ? readSubagentInitFlags(p.sessionFile) : undefined,
          advisor: p.sessionFile ? path.basename(p.sessionFile).startsWith("__advisor") : undefined,
          detached: p.detached ?? false,
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
  const unsubProgress = eventBus.on("task:subagent:progress", (p: any) => {
    const pr = p.progress ?? {};
    // Subagent identity lives inside the progress object (AgentProgress.id) — the
    // channel payload's top level carries no id field (base contract; the TUI's
    // session-observer reads progress.id the same way)
    const subagentId: string | undefined = pr.id;
    if (!subagentId) return;
    const payload = {
      agent: p.agent,
      status: pr.status,
      task: pr.task,
      cost: pr.cost,
      durationMs: pr.durationMs,
      requests: pr.requests,
      toolCount: pr.toolCount,
      // Base progress.tokens is a plain cumulative number; the frontend contract
      // (and the history-replay path below) expects the bucketed shape
      tokens: typeof pr.tokens === "number" ? { total: pr.tokens } : pr.tokens,
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
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId, name: subName(subagentId, p.agent), parent: subParent(subagentId), registeredAt: subRegistered.get(subagentId), ...payload }));
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    // Task calls inside a subagent stream: owned by that subagent (nested spawn)
    if (event.type === "tool_execution_start" && spawnTools[event.toolName]) {
      callOwner.set(event.toolCallId, { owner: subName(id, id), names: spawnNames(event.args) });
    }
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "subagent_event", sessionId, subagentId: id, ...ui })));
  });
  // Pre-consumption notice: queued/steer user messages about to be injected
  // are pushed to the UI (bubbles finalized). The texts also enter
  // consumedPending so sendQueued keeps suppressing them from the queue view
  // until the injection confirms (see PoolEntry.consumedPending): the base's
  // preparation claim keeps a dequeued message visible in the peek views, and
  // the claim's release fires no onQueueChange, so without the suppression
  // the realtime queued frame would re-add the consumed message to the queue
  // card for the whole turn (until the agent_end calibration).
  const detachDequeueHook = entry.session.agent.addBeforeQueuedMessageDequeueHook(() => {
    const texts = [...entry.session.agent.peekFollowUpQueue(), ...entry.session.agent.peekSteeringQueue()]
      .filter((m) => isUserQueuedMessage(m))
      .map((m) => toRestoredQueuedMessage(m).text);
    if (texts.length > 0) {
      for (const t of texts) entry.consumedPending.add(t);
      ws.send(JSON.stringify(stampEvent({ type: "steer_consumed", sessionId, texts })));
    }
  });
  // (18.4.4) Realtime queue push: the agent notifies after every queue
  // mutator (enqueue, dequeue-on-delivery, clear, restore), so the queued
  // frame follows each mutation instead of the turn_end-only snapshot. Bursts
  // (park + release + steer in one operation) coalesce into one microtask
  // push; turn_end keeps its explicit sendQueued as the final calibration.
  const unsubQueueChange = entry.session.agent.onQueueChange(scheduleQueuePush);
  // (18.4.9) Session-file transfer notice: when the base moves this session
  // to a fresh sibling file (another live process owns the old one / the old
  // file was replaced or is contested), repoint the pool entry and restart
  // external-write detection from byte 0 — the new file is this session's
  // journal from its first line, and every id in it is known to the manager.
  const unsubPersistenceNotice = entry.manager?.onPersistenceNotice?.((notice: { from: string; to: string }) => {
    // Keep the abandoned location resolvable to this entry: the frontend still
    // keys the session by the path it was handed, and a path-only match would
    // otherwise rebuild a second live session over the dead file on the next
    // load/reload through it
    entry.previousPaths.push(notice.from);
    entry.path = notice.to;
    entry.pollKnownSize = 0;
    safeStderr(`[host] 会话文件已转移 ${notice.from} -> ${notice.to}\n`);
  });
  // MCP connection status → capabilities_mcp incremental frames. The manager
  // is process-global while attach is per-session: with several sessions
  // attached the same state is pushed once per attach — idempotent on the
  // frontend (identical content overwrites), so no cross-entry dedup here.
  // Re-reading the full manager state per event beats replaying event payloads
  // (out-of-order/coalesced events cannot desync the view).
  const unsubMcp = entry.sessionResult?.mcpManager?.addConnectionStatusListener?.(() => {
    ws.send(
      JSON.stringify(
        stampEvent({ type: "capabilities_mcp", mcp: snapshotMcp(entry.sessionResult.mcpManager) }),
      ),
    );
  });
  // Listen for base session title changes (auto-generated model titles, /rename, etc.)
  const unsubTitle = entry.session.sessionManager.onSessionNameChanged?.(() => {
    const title = entry.session.sessionManager.getSessionName() ?? "";
    entry.title = title || null;
    ws.send(JSON.stringify({ type: "session_title_changed", sessionId, title }));
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubTitle?.();
    unsubSpawnRoot();
    unsubLifecycle();
    unsubProgress();
    unsubEvents();
    detachDequeueHook();
    unsubQueueChange();
    unsubPersistenceNotice?.();
    unsubMcp?.();
  };
  entry.attachedWs = ws;
  sessions.set(sessionId, entry);
}

/** Create a session on `cwd` with `model`, attach it, and push session_created. */
async function spawnSession(ws: any, workDir: string, targetModel: any, thinkingLevel?: string) {
  const { sessionId, entry, eventBus } = await createSessionCore(
    workDir,
    SessionManager.create(workDir),
    [],
    targetModel,
  );
  if (thinkingLevel) {
    try {
      entry.session.setThinkingLevel(thinkingLevel);
    } catch {}
  }
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: workDir,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
      title: entry.title ?? null,
    }),
  );
  pushComputerMode(ws, sessionId, entry); // fresh overlay is always off; the explicit frame keeps the button honest after plan-approve session swaps
  return { sessionId, entry };
}

// Plan approval needs a fresh session (approve-and-execute / save-and-quit) but
// cannot import this module back — it is the caller. Inject the factory instead.
setFreshSessionFactory((ws, entry) => spawnSession(ws, entry.cwd, entry.session.model).then((r) => r.entry));

export async function handleCreateSession(ws: { send(data: string): unknown }, cwd?: string, modelStr?: string, thinkingLevel?: string, planMode?: boolean, computerMode?: boolean) {
  const workDir = typeof cwd === "string" && cwd ? cwd : defaultCwd;
  const targetModel = modelStr ? H.scopedModels.find((m) => `${m.provider}/${m.id}` === modelStr) : undefined;
  const { sessionId, entry } = await spawnSession(ws, workDir, targetModel, thinkingLevel);
  // Session born with plan mode (intent picked on the new-session page): same
  // entry path as the menu toggle (persist + pushPlanMode inside)
  if (planMode) setPlanMode(ws, sessionId, entry, true);
  else pushPlanMode(ws, sessionId, entry);
  // Session born with computer use (intent picked on the new-session page):
  // same entry path as the composer toggle — the master gate is checked inside
  // (closed gate surfaces a command_output hint and the frame stays off)
  if (computerMode) setComputerMode(ws, sessionId, entry, true);
  safeStderr(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir} model=${modelStr ?? "default"} thinking=${thinkingLevel ?? "default"}（活跃 ${sessions.size}）\n`);
}

// ---- Subagent history replay ----
// Child subagent runs persist as <session file minus .jsonl>/<subagent name>.jsonl (the SDK's
// artifact layout; each child header carries a parentSession backlink). Live sessions learn
// about them through the event subscriptions, but a session rebuilt from disk never sees those
// frames — scan the artifacts dir and re-emit lifecycle/progress (+ the tool stream for cold
// loads) so the right sidebar's subagent page reconstructs past runs. Synthesized ids take a
// hist- prefix: they can never collide with a live SDK subagentId.
const HIST_SUBAGENT_RECENT_MS = 60_000; // a file still being written belongs to a live subagent — skip, its frames arrive live

// Agent Hub "Changes" line: the TUI decides Read-only vs shared from the agent-registry kind
// and the child session's persisted session_init.readOnly (stamped by the SDK at spawn);
// subagent frames carry neither, so the flags are recovered from the transcript file itself.
// session_init is appended at spawn start — the file's first chunk always covers it.
function readSubagentInitFlags(file: string): boolean | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes("session_init")) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === "session_init") return j.readOnly === true;
      } catch {}
    }
  } catch {
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

// Advisor transcripts use the SDK-reserved __advisor stem (the same signal the TUI agent
// registry uses for kind: "advisor")
const isAdvisorTranscript = (file: string) => path.basename(file).startsWith("__advisor");

interface HistAggregation {
  title: string;
  registeredAt: number;
  readOnly?: boolean;
  status: string;
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
        advisor: path.basename(file).startsWith("__advisor"),
      }),
    );
    if (includeTools) {
      for (const ev of agg.toolEvents) ws.send(JSON.stringify({ type: "subagent_event", sessionId, subagentId, ...ev }));
    }
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId, registeredAt: agg.registeredAt, ...agg.progress }));
  }
}

export async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error(hostI18n.t("errors.param.missingPath"));
  // A pooled entry with the same path already exists: reuse it, do not
  // rebuild. Rebuilding would leave the same session file held by two
  // AgentSessions at once (each persisting and overwriting the other), and
  // the old entry would leak in the pool along with its subscriptions.
  // Hit paths: switching back after the frontend's session LRU eviction
  // (same ws, snapshots merely re-pushed); a click after frontend reload
  // (new ws, subscriptions re-attached — old subscriptions would send to a
  // closed connection and events would be lost).
  for (const [sessionId, entry] of sessions.entries()) {
    // previousPaths: a persistence move left the frontend holding the old path —
    // it must reuse this live entry, not fork a second session over the dead file
    if (entry.path !== sessionPath && !(entry.previousPaths?.includes(sessionPath) ?? false)) continue;
    // The user opening/switching back to this session = seen: stop cache
    // keepalive probing (the next turn's wrap-up will set it again)
    entry.keepaliveWanted = false;
    const frontendReloaded = entry.attachedWs !== ws; // capture before attachEntry overwrites it
    if (frontendReloaded) {
      entry.unsubscribe(); // Detach old subscriptions first, or the same event would be sent twice
      attachEntry(ws, sessionId, entry, entry.sessionResult.eventBus);
    }
    ws.send(
      JSON.stringify({
        type: "session_created",
        sessionId,
        path: entry.path,
        cwd: entry.cwd,
        model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
        thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
        isGit: entry.isGit,
        title: entry.title ?? null,
        isSubagent: entry.isSubagent,
        parentPath: entry.parentPath,
      }),
    );
    pushPlanMode(ws, sessionId, entry); // The reuse snapshot also pushes plan state (the frontend relies on it to show the "plan" button after reload)
    pushComputerMode(ws, sessionId, entry); // Reuse snapshot: per-session computer opt-in state (the composer button relies on it)
    ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
    pushTodos(ws, sessionId, entry); // The reuse snapshot also pushes the todos backlog (otherwise history TODOs vanish after the frontend rebuilds objects)
    pushGoal(sessionId); // Goal state backlog (session state card goal area)
    pushContext(ws, sessionId, entry);
    pushSessionStats(ws, sessionId, entry); // The reuse snapshot also pushes whole-session stats (otherwise stats stay empty after the frontend rebuilds objects)
    if (frontendReloaded) {
      // Frontend reload: its store was wiped, so replay the subagent history (the full tool
      // stream — the store is guaranteed empty, no duplicates can stack up). Same-ws
      // switch-backs skip: the live entries are still in the store.
      replaySubagentHistory(ws, sessionPath, sessionId, true);
    }
    if (entry.externalWrite) ws.send(JSON.stringify({ type: "session_external_write", sessionId })); // Detected during LRU eviction; re-sent on switch-back
    // Switch-back after frontend eviction: re-mount if the previous detach
    // released the session's MCP holds (idempotent — mounted sessions return)
    void mountMcpForSession(sessionId, entry);
    safeStderr(`[host] 复用池内会话 ${sessionId.slice(0, 8)}（活跃 ${sessions.size}）\n`);
    return;
  }
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // The session's original cwd: getEntries() excludes the session header, so
  // read it via peekSessionInit (same source as open's internals; it returns
  // null when the directory is unreachable — fall back to HOME)
  const peek = await SessionManager.peekSessionInit(sessionPath);
  const workCwd = peek?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  // Subagent session detection: child transcript lives inside <parentSessionFile minus .jsonl>/
  const parentSessionFile = `${path.dirname(sessionPath)}.jsonl`;
  const isSubagent = fs.existsSync(parentSessionFile);
  entry.isSubagent = isSubagent;
  entry.parentPath = isSubagent ? parentSessionFile : undefined;
  if (isSubagent && !entry.title) {
    entry.title = path.basename(sessionPath, ".jsonl");
  }
  // Historical mentions are already in the transcript: align the fileMention read-back cursor to the tail of all entries, avoiding a re-send on the first read-back
  entry.mentionScanIndex = entries.length;
  // Active-duration seed for a past session: the in-memory timer only covers time since this open; seed the backlog by summing per-turn spans from the disk entries
  entry.activeMs = sumRunDurationMs(entries);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
      title: entry.title ?? null,
      isSubagent: entry.isSubagent,
      parentPath: entry.parentPath,
    }),
  );
  reconcilePlanMode(ws, sessionId, entry, entries); // Restore plan mode from persisted mode_change (frames must be pushed after session_created)
  pushComputerMode(ws, sessionId, entry); // Disk rebuild starts from the pinned-off overlay; the explicit frame resets any stale lit button
  await entry.goal.restore(); // Goal mode restore (persisted mode_change goal/goal_paused; aligned with the TUI, no proactive re-run)
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  // Restored session's todos backlog (TodoTracker synced from the transcript branch at construction)
  pushTodos(ws, sessionId, entry);
  pushGoal(sessionId); // Goal state backlog (pushed after restore; session state card goal area)
  // Restored session's initial context usage (system prompt + history)
  pushContext(ws, sessionId, entry);
  // Restored session's whole-session stats (tokens/cost summed from disk assistant messages' usage; duration is in-memory state, restarting from 0 on reload)
  pushSessionStats(ws, sessionId, entry);
  // Restored session's subagent history: the child run files live in the sibling artifacts
  // dir; the frontend store is empty on this path, so replay the full stream
  replaySubagentHistory(ws, sessionPath, sessionId, true);
  safeStderr(`[host] 加载会话 ${sessionId.slice(0, 8)} cwd=${entry.cwd} 历史 ${transcript.length} 条\n`);
}
