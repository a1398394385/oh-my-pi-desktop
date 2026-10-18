// Session lifecycle domain: the create/load entry points (pool reuse vs disk
// rebuild), event wiring (attachEntry's approval UI context + extension
// runner injection + realtime queue push + session-file transfer notices),
// the post-created snapshot sequence, and the collapsed session_created
// frame emission. The snapshot push family lives in session-snapshot.ts and
// the subagent roster (live tables + eventBus subscriptions + disk replay)
// in subagent-view.ts (A12 split). Relocated from main.ts (second split cut).
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
  enabledDefaults,
  defaultCwd,
  stampEvent,
  pendingApprovals,
  requestApproval,
  pushCommandOutput,
  pushPoolSnapshot,
  entryBus,
  eachUiWs,
  type PoolEntry,
  type TranscriptItem,
} from "./state.ts";
import { GoalController, type GoalSession } from "./goal.ts";
import { acpParamsFromConfig } from "./acp-plan.ts";
import { createAcpRuntime, createCompressContextTool, createAcpProjectionExtension, ACP_CONTEXT_BUDGET_PROMPT } from "./acp-assembly.ts";
import { createRecallBlockTool } from "./acp-recall-tool.ts";
import { createAcpStatusTool } from "./acp-status-tool.ts";
import { rebuildAcpState } from "./acp-persist.ts";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { createSessionContextTools } from "./session-context.ts";
import { createAutomationTool } from "./automations-tool.ts";
import { translateEvent, entriesToTranscript, sumRunDurationMs } from "./translate.ts";
import {
  buildSessionCreatedFrame,
  maybePushSessionStats,
  pushContext,
  pushGoal,
  pushSessionStats,
  pushTodos,
} from "./session-snapshot.ts";
import { createSubagentView, replaySubagentHistory } from "./subagent-view.ts";
import { readKeepaliveEnabled } from "./keepalive-config.ts";
import { gateKimiAutoThinking } from "./kimi-thinking.ts";
import { snapshotMcp } from "./capabilities.ts";
import { readAcpRaw, readAcpEnabled, readSessionContextEnabled } from "./profile.ts";
import { readPluginsEnabled, readHooksEnabled } from "./assets.ts";
import { createKeepaliveExtension } from "./keepalive.ts";
import { markTurnWrapped, markSeen, reportKeepaliveState } from "./keepalive-host.ts";
import { sendQueued, releaseOneParked } from "./queue.ts";
import { pushPlanMode, reconcilePlanMode, setPlanMode } from "./plan.ts";
import { computerDefaultAppliesFor, pushComputerMode, setComputerMode } from "./computer-mode.ts";
import { dispatchFromToolEnd, installProposalHandler, pushPlanOutput, pushRestoredPlanOutput, setFreshSessionFactory } from "./plan-approve.ts";
import { handleVoiceEvent } from "./voice.ts";
import { bgJobsCorrection, bgJobsPayload } from "./async-jobs.ts";
import { hostI18n } from "./i18n/host.ts";
import { mountMcpForSession } from "./mcp-mount.ts";
import { safeStderr } from "./stderr.ts";

// Thin re-export so existing callers keep one import path; the git process
// layer itself lives in git.ts.
import { isGitWorktree } from "./git.ts";
export { isGitWorktree };

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

// A12 split: the snapshot push family (goal/todos/context/session stats +
// the throttled live stats push) lives in session-snapshot.ts now; these
// re-exports keep the pre-split import surface (rpc/prompt.ts,
// smoke-cache-breaks.ts) unchanged.
export { pushContext, countCacheBreaks } from "./session-snapshot.ts";

// Structural minimum for a socket attachEntry accepts: the primary server and
// the LAN remote server both satisfy it, and so do fan-out adapters (entryBus).
type UiSocket = { send(data: string): unknown };

export async function createSessionCore(
  cwd: string,
  sessionManager: any,
  transcript: TranscriptItem[],
  initialModel?: any,
  opts?: { subagent?: boolean },
) {
  // Master switch on the experimental features page (omp-desktop.json's
  // acp.enabled, default off for new users): only decides whether this session injects the
  // ACP tool surface and the context view rewrite; it cannot hot-toggle
  // after session creation, so switch changes take effect on new sessions
  const acpEnabled = readAcpEnabled();
  // ACP dual-zone compaction assembly (spec §10): with the master switch on the
  // session gets the compress_context tool, the dual-zone request projection
  // (T1 projectContext behind the context event), and the base auto-compaction
  // pinned OFF per session — the base shouldCompact judges the stored journal,
  // which the ACP projection never influences, so leaving it on would let base
  // compaction fold the journal out from under ACP. The settings child stays a
  // live object (hoisted here): the §5.3 degrade path writes compaction.enabled
  // back to true on it (the session's compaction getter resolves the settings
  // every turn).
  const sessionSettings = H.settings.overlay({ "computer.enabled": false, ...(acpEnabled ? { "compaction.enabled": false } : {}) });
  // Session holder for the T7 force channel: setForcedToolChoice needs the
  // live session, which only exists after createAgentSession below.
  const acpSession: { session?: { setForcedToolChoice(toolName: string): void } } = {};
  // Same model object feeds the runtime's zone axis and the param conversion
  // below (percent tier lines derive from this window).
  const acpModel = initialModel ?? H.modelOverride;
  const acpRuntime = acpEnabled
    ? createAcpRuntime({
        model: acpModel,
        sink: sessionManager,
        getEntries: () => sessionManager.getEntries(),
        params: acpParamsFromConfig(readAcpRaw().acp, (acpModel as { contextWindow?: number } | null | undefined)?.contextWindow),
        // Level-3 force channel (spec §5.2/§10): the named form where the face
        // supports it (openai-completions faces narrow tools internally = form
        // ②); a throw (neither form) degrades via form ③.
        forceCompressTool: () => {
          const s = acpSession.session;
          if (!s) throw new Error("session not created yet");
          s.setForcedToolChoice("compress_context");
        },
        // §5.3 degrade: restore the base compaction chain on the live settings
        // child — the OMP methodOrder takes over from the next turn on.
        onDegrade: () => cfgCompactionEnabled.override(sessionSettings, true),
      })
    : null;
  // Restart rebuild (spec §9/T2+T7): adopt the persisted zone/compressed set;
  // a journal containing a base compaction entry degrades immediately (the
  // overlay write-back above re-enables the base chain for this session).
  if (acpRuntime) {
    const rebuilt = rebuildAcpState(sessionManager.getEntries());
    if (rebuilt.degraded) acpRuntime.degrade("restart rebuild found a base compaction entry (spec §5.3/§9.1)");
    else {
      acpRuntime.zone = rebuilt.zone;
      for (const id of rebuilt.compressedBlockIds) acpRuntime.compressed.add(id);
    }
  }
  // ACP manifest + ephemeral supply (T4): the projection extension re-derives
  // the round status (tier + candidate manifest) on every request and appends
  // the [compress-hint] ephemeral when a tier is active (host/acp-runtime.ts).
  // Past session retrieval switch (omp-desktop.json's sessionContext.enabled, default off for new users)
  const sessionContextEnabled = readSessionContextEnabled();
  // Cache keepalive switch (omp-desktop.json's keepalive.enabled, experimental
  // features page, default off). Governed solely by the settings-page switch:
  // no double-load guard against a separately installed upstream
  // pi-kimi-keepalive plugin — per product decision the embedded keepalive
  // runs whenever the switch is on, and a plugin-enabled upstream instance
  // would probe alongside it (double spend is the user's call: disable the
  // plugin on the plugins page to keep only the embedded one).
  const keepaliveOn = readKeepaliveEnabled();
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
    // value never auto-enables a desktop session. ACP sessions additionally
    // pin compaction.enabled OFF here (see the assembly comment above); other
    // runtime overrides (/extended-context, /browser headless, model-role pins)
    // stay in this child instead of leaking host-wide; config-layer reads still
    // fall through to H.settings live (Settings.overlay forwards parent changes
    // to children).
    settings: sessionSettings, // hoisted so the ACP §5.3 degrade path can write compaction.enabled back on it
    // The advisor's compaction gate is the same `compaction.enabled` + non-empty
    // `methodOrder` pair the primary's is, read off the same settings object — so the
    // ACP pin above (which exists only to keep the base chain out of ACP's way) silently
    // kills the advisor's compaction and promotion too. Its stale-tool-result eviction
    // is ungated and survives; everything after it does not. Opt the advisor back in.
    advisorCompactionEnabled: true,
    model: initialModel ?? H.modelOverride,
    // Proactive-compression guidance (verbatim append via the SDK's
    // appendSystemPrompt channel) — same condition as the ACP tools below: the
    // text names context_status/compress_context, which only ACP sessions
    // carry (wording + rationale in host/acp-assembly.ts).
    appendSystemPrompt: acpRuntime ? ACP_CONTEXT_BUDGET_PROMPT : undefined,
    // Auto session title: the desktop host is an interactive surface, so it
    // arms the base's own titling (AgentSession notes the operator message on
    // message_end and asks the title model / a reply fork once the answer
    // starts; sdk.ts passes this through as autoTitle, false for subagents).
    // Reachable only through this flag — the host-side trigger the SDK used to
    // expose (maybeStartTitleGeneration) is gone from 18.10.x.
    autoTitle: true,
    agentRegistry: new AgentRegistry(), // The default global registry allows only one Main per generation; multiple sessions must pass a private instance
    sessionManager, // The host-side manager must be injected into the SDK: otherwise rename/compact/branch would go through entry.manager (an orphan instance) operating on a different session file
    // read_session_context (past session retrieval): reads only its own profile's sessions, see host/session-context.ts
    // create_automation: agent-created scheduled tasks, same domain entry as the UI's create RPC.
    // Subagents get no scheduled tasks (a delegated step must not schedule follow-up work on
    // the user's behalf), so the tool is withheld from their surface entirely.
    customTools: [
      ...(acpRuntime ? [createCompressContextTool(acpRuntime), createRecallBlockTool(acpRuntime), createAcpStatusTool(acpRuntime)] : []),
      ...(sessionContextEnabled ? createSessionContextTools() : []),
      ...(opts?.subagent ? [] : [createAutomationTool(cwd)]),
    ] as never, // ACP compress_context + recall_block + context_status (host/acp-runtime.ts · acp-recall-tool.ts · acp-status-tool.ts) + read_session_context + create_automation; omptype/ArkType schemas are brand-incompatible with the package's TSchema type, identical at runtime
    extensions: [
      ...(acpRuntime ? [createAcpProjectionExtension(acpRuntime, () => sessionManager.getSessionId())] : []), // context event view projection: compression zone + filtered active zone, see host/acp-runtime.ts
      ...(keepaliveOn ? [createKeepaliveExtension({
        // Same kaHolder entry as isWanted: reports that fire before the entry
        // exists (extension injection happens inside createAgentSession) are
        // dropped; the entry ships a zeroed initial snapshot instead
        isWanted: () => kaHolder.entry?.keepaliveWanted === true,
        // Turn-park census for this session: user dialogs (feeding the
        // probeDuringApproval / probeDuringAsk toggles) plus pending tool
        // executions — a subagent task/agent call parks the turn for minutes
        // with no model request in flight, and that wait never reaches
        // agent_end, so the ticks during it must probe
        blockState: () => {
          let approval = false;
          let ask = false;
          for (const p of pendingApprovals.values()) {
            if (p.sessionId !== sessionId) continue;
            if (p.blockKind === "ask") ask = true;
            else approval = true;
          }
          // A permission-card wait reports both this and the dialog kind above
          // (the approval gate runs inside the tool execution); the extension
          // gives the dialog precedence — see keepalive.ts's toolWait.
          const entry = kaHolder.entry;
          const tool = !!entry && entry.session.agent.state.pendingToolCalls.size > 0;
          return { approval, ask, tool };
        },
        reportState: (s) => {
          // Same gate as isWanted above: reports that fire before the entry
          // exists are dropped
          const entry = kaHolder.entry;
          if (!entry) return;
          reportKeepaliveState(entry, s);
        },
        // Disk session file (short name) tagging the extension's warn lines in
        // the app-wide log, so a probe failure traces back to its session
        sessionFile: () => kaHolder.entry?.session.sessionManager.getSessionFile() ?? null,
      })] : []), // prefix cache keepalive: idle sessions that are unread replay the last request, see host/keepalive.ts
    ] as never, // The inline extension's structural narrow type is brand-incompatible with the package's type signature, identical at runtime (same precedent as customTools)
    disableExtensionDiscovery: !(readPluginsEnabled() || readHooksEnabled()),
    enableMCP: false,
    hasUI: true, // The approval gate's fail-cold check goes through runner.hasUI(): without it, every approval-requiring tool errors out outright in non-yolo mode
  });
  const { session } = result;
  // ACP runtime seams (spec §8 + T7): model_changed rebinds the tokenizer and
  // the window-derived lines; turn_end drives the §5.2/§5.3 failure-exit
  // judgment (ultimatum counting, forced-turn resolution — API-error turns
  // emit turn_end too, so the forced terminal state is reached on every path).
  // The holder feeds the force channel above.
  if (acpRuntime) {
    acpSession.session = session;
    session.subscribe((ev: { type: string }) => {
      if (ev.type === "model_changed") acpRuntime.rebindModel(session.model);
      else if (ev.type === "turn_end") acpRuntime.onTurnEnd();
    });
  }
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
    acpRuntime: acpRuntime ?? undefined, // get_context_detail reads the dual-zone split off it
    unsubscribe: () => {},
    uiSockets: new Set(),
    uiSubViews: new Map(),
    coreAttached: false,
    extStatuses: new Map(), // Extension status badges (uiCtx.setStatus); surfaced on the capabilities card
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
    awaitDiskList: !fs.existsSync(session.sessionFile), // brand-new only: a loaded/branched session's file already exists
    externalWrite: false,
    previousPaths: [], // Persistence-move history: old file locations keep resolving to this entry (see state.ts)
    cwd,
    isGit: await isGitWorktree(cwd),
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

/** Attach a UI socket to a pooled session. Idempotent per socket: the
 * once-per-entry core subscribes on first attach; every further socket (the
 * other channel of a remote-control session, a frontend reload) only joins
 * the fan-out set. */
export function attachEntry(ws: UiSocket, sessionId: string, entry: PoolEntry, eventBus: unknown) {
  if (!entry.coreAttached) {
    entry.coreAttached = true;
    subscribeEntryCore(sessionId, entry, eventBus);
  }
  attachEntryUi(ws, sessionId, entry, eventBus);
}

/** Per-socket attach: join the fan-out set, start this socket's subagent
 * roster (A12 split), push the pool snapshot, and re-show dialogs already
 * open on another UI so a late joiner (e.g. remote control joining mid-
 * approval) can answer them too. */
function attachEntryUi(ws: UiSocket, sessionId: string, entry: PoolEntry, eventBus: unknown) {
  if (entry.uiSockets.has(ws)) return;
  entry.uiSockets.add(ws);
  entry.uiSubViews.set(ws, createSubagentView(ws, sessionId, entry, eventBus));
  pushPoolSnapshot(ws);
  for (const pending of pendingApprovals.values()) {
    if (pending.sessionId === sessionId && pending.frame) {
      ws.send(JSON.stringify(stampEvent(pending.frame)));
    }
  }
}

/** Once-per-entry core: the session event subscription, the approval UI
 * context, the extension runner injection, and the queue / dequeue /
 * persistence / mcp / title listeners. Every frame the core pushes fans out
 * over entry.uiSockets — local desktop and remote control watch the same
 * session concurrently. Torn down (entry.unsubscribe) when the last attached
 * socket leaves. */
function subscribeEntryCore(sessionId: string, entry: PoolEntry, eventBus: unknown) {
  const bus = entryBus(entry);
  // The ask tool's `i` intent: agent-loop extracts it from the tool args and
  // carries it on the tool_execution_start event; askDialog takes and clears
  // it when the card is pushed (same-session tools are serial, a single
  // value slot cannot cross-contaminate)
  let askIntent: string | undefined;
  // bg_jobs latch (see bgJobsCorrection): keeps the "all finished" correction frame flowing
  let bgJobsHadRunning = false;
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
      for (const w of entry.uiSockets) sendQueued(w, sessionId, entry);
    });
  };
  const unsubSession = entry.session.subscribe((ev) => {
    // Stash the ask tool's `i` intent; attached to the askDialog frame on push
    if (ev.type === "tool_execution_start" && ev.toolName === "ask" && typeof ev.intent === "string" && ev.intent.trim()) {
      askIntent = ev.intent.trim();
    }
    const ui = translateEvent(ev, entry);
    if (ui) bus.send(JSON.stringify(stampEvent({ type: "event", sessionId, ...ui })));
    // TTS vocalization bridge (speech.enabled): forwards this session's
    // deltas as tts_* frames (spoken UI-side) when it is the session the user
    // last prompted
    handleVoiceEvent(bus, ev, sessionId);
    // After the todo tool persists, push the latest task list (TodoTracker updates after the tool result)
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      bus.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases: entry.session.getTodoPhases() })));
    }
    // Background jobs (18.5): a finished job's async-result delivery resumes the loop as
    // a fresh turn, so turn_start corrects the composer badge (auto-backgrounded bash
    // goes silent after "Backgrounded as job"; subagent tabs pull their own scope)
    if (ev.type === "turn_start") {
      const correction = bgJobsCorrection(entry.session, bgJobsHadRunning);
      if (correction) {
        bgJobsHadRunning = correction.hadRunning;
        bus.send(JSON.stringify(stampEvent({ type: "bg_jobs", sessionId, jobs: correction.jobs })));
      }
    }
    // Plan approval rides a `write` to xd://propose, dispatched OUT of band
    // exactly like the base TUI's event-controller (issue #7684): awaiting it
    // here would hold the subscription for the whole execution turn, and
    // awaiting the operator inside the tool handler would deadlock abort()'s
    // waitForIdle. Never awaited — see host/plan-approve.ts.
    if (ev.type === "tool_execution_end" && !ev.isError) {
      // The plan-approval flow spawns fresh sessions and pushes plan state to
      // one concrete socket, so it follows the primary (first-attached) UI;
      // its approval card itself still reaches every attached UI (entryBus in
      // plan-approve's requestApproval calls)
      const primary = entry.uiSockets.values().next().value;
      if (primary) dispatchFromToolEnd(primary, sessionId, entry, ev.toolName, ev.result);
    }
    // Push context usage live on key execution events, updating the frontend's context-size ring
    if (ev.type === "message_end" || ev.type === "tool_execution_end") {
      for (const w of entry.uiSockets) pushContext(w, sessionId, entry);
    }
    // The stats row refreshes live too: it used to be pushed only on agent_end
    // (turn end), which froze the token / cache-read / duration numbers under
    // the composer for the whole generation. These two events are the ones that
    // actually advance the index-level usage counter (each model turn end and
    // each tool completion), which is enough to keep the row moving with the
    // session. Throttling: see maybePushSessionStats.
    if (ev.type === "message_end" || ev.type === "tool_execution_end") {
      for (const w of entry.uiSockets) maybePushSessionStats(w, sessionId, entry);
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
      bus.send(JSON.stringify(stampEvent({ type: "cache_warming", sessionId, phase: "start" })));
    } else if (ev.type === "cache_warming_end") {
      bus.send(JSON.stringify(stampEvent({ type: "cache_warming", sessionId, phase: "end", outcome: ev.outcome })));
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
      markTurnWrapped(entry);
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
          bus.send(JSON.stringify({ type: "event", sessionId, kind: "mention", files }));
        }
      }
      entry.mentionScanIndex = entries.length;
      for (const w of entry.uiSockets) {
        pushContext(w, sessionId, entry);
        pushSessionStats(w, sessionId, entry);
      }
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
              safeStderr(hostI18n.t("errors.lifecycle.queuedFollowUpFailed", { detail: String(err) }));
            });
        });
      }
      for (const w of entry.uiSockets) sendQueued(w, sessionId, entry);
    }
  });
  // Approvals/dialogs: in non-yolo mode the approval gate suspends via ExtensionUIContext.select awaiting the user's choice
  const uiCtx = {
    // UI timeout for tools like ask counts from dialog presentation, not from when the tool invoked
    timeoutStartsOnPresentation: true,
    // Extensions style their status text through ui.theme (e.g. ponytail bails out of
    // setStatus unless theme.fg exists). There is no terminal here, so hand out a plain
    // theme: fg returns the text unstyled — the capabilities card renders it verbatim.
    theme: {
      fg: (_color: string, text: string) => text,
    },
    // Extension status badges (the TUI's status-line hooks, e.g. ponytail's setStatus):
    // the desktop has no status line, so the badge lands on the capabilities card.
    // Recorded on the entry (survives re-attach) and pushed as an incremental frame;
    // get_capabilities replays the full table for fresh mounts.
    setStatus(key: string, text: string | undefined) {
      const statuses = entry.extStatuses ?? (entry.extStatuses = new Map());
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      bus.send(JSON.stringify(stampEvent({ type: "extension_status", sessionId, statuses: [...statuses] })));
    },
    select(title: string, options: any[], dialogOptions?: any): Promise<string | undefined> {
      return requestApproval(
        bus,
        sessionId,
        title,
        options.map((o) => (typeof o === "string" ? o : o.label)),
        dialogOptions?.signal,
      );
    },
    confirm(title: string, message: string, dialogOptions?: any): Promise<boolean> {
      // The third arg is part of the base interface (usage-fallback and
      // computer-control confirmers pass { signal }); without the listener the
      // card would outlive the abort that cancelled the wait.
      return requestApproval(
        bus,
        sessionId,
        `${title}\n${message}`,
        ["OK", "Cancel"],
        dialogOptions?.signal,
      ).then((v) => v === "OK");
    },
    editor(title: string, prefill?: string, dialogOptions?: any): Promise<string | undefined> {
      // ask's "Other" free-text input goes through here; a missing implementation kills the tool outright with undefined is not a function
      // Stable option ids + editableIndex protocol field: the UI renders
      // localized labels from the ids and locates the inline input row by
      // index — the contract never depends on display text.
      return requestApproval(
        bus,
        sessionId,
        title,
        ["submit", "cancel"],
        dialogOptions?.signal,
        { editable: true, editableIndex: 0, prefill: prefill ?? "" },
        undefined,
        undefined,
        // Ask-family dialog even though no questions ride the frame.
        "ask",
      );
    },
    // (18.5) Rich ask dialog: the ask tool with a questions array surfaces
    // here instead of per-question select() rounds. The frame reuses the
    // approval channel (options are the submit/cancel actions; the questions
    // ride the questions field); approval_response answers with
    // answer = JSON.stringify(ExtensionAskDialogSubmitResult). Aborts and
    // unknown answers resolve undefined (the base treats that as cancelled).
    askDialog(questions: unknown[], dialogOptions?: any): Promise<unknown> {
      const parseAskAnswer = (answer: string) => {
        try {
          const parsed = JSON.parse(answer) as { kind?: unknown };
          if (parsed && parsed.kind === "submit") return parsed;
        } catch {
          // Malformed submissions count as cancelled, not as an error frame
        }
        return undefined;
      };
      const intent = askIntent;
      askIntent = undefined;
      const first = (questions[0] ?? {}) as { header?: string; question?: string };
      return requestApproval(
        bus,
        sessionId,
        first.header ?? first.question ?? "ask",
        ["submit", "cancel"],
        dialogOptions?.signal,
        { intent },
        undefined,
        questions,
      ).then((v) => (v === undefined ? undefined : parseAskAnswer(v)));
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
          safeStderr(hostI18n.t("errors.lifecycle.extensionSendFailed", { detail: String(err) }));
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

  // Subagent roster (A12 split): the live registration/ownership tables and
  // the three eventBus subscriptions (lifecycle/progress/event frames, with
  // the IRC wake-turn run folding) live in subagent-view.ts; the roster is
  // per-socket and joins in attachEntryUi (one view per attached UI), with
  // each socket's teardown folded into entry.unsubscribe via entry.uiSubViews.
  // Pre-consumption notice: queued/steer user messages about to be injected
  // are pushed to the UI (bubbles finalized). The texts also enter
  // consumedPending so sendQueued keeps suppressing them from the queue view
  // until the injection confirms (see PoolEntry.consumedPending): the base's
  // preparation claim keeps a dequeued message visible in the peek views, and
  // the claim's release fires no onQueueChange, so without the suppression
  // the realtime queued frame would re-add the consumed message to the queue
  // card for the whole turn (until the agent_end calibration).
  const detachDequeueHook = entry.session.agent.addBeforeQueuedMessageDequeueHook(() => {
    // The hook fires before EACH queue's dequeue with no queue argument. The
    // base always attempts the steering dequeue first (only when that queue is
    // non-empty) and the followUp dequeue second, so the non-empty queue at
    // hook time is exactly the one about to be drained. Broadcasting the other
    // queue's texts as well would promote still-queued messages to consumed
    // bubbles immediately — and ahead of the steer bubble, since the snapshot
    // lists followUp first (live transcript order then diverges from the
    // persisted one until reload).
    const agent = entry.session.agent;
    const draining = agent.peekSteeringQueue().length > 0 ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
    const texts = draining.filter((m) => isUserQueuedMessage(m)).map((m) => toRestoredQueuedMessage(m).text);
    if (texts.length > 0) {
      for (const t of texts) entry.consumedPending.add(t);
      bus.send(JSON.stringify(stampEvent({ type: "steer_consumed", sessionId, texts })));
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
    safeStderr(hostI18n.t("errors.lifecycle.sessionFileMoved", { from: notice.from, to: notice.to }));
  });
  // MCP connection status → capabilities_mcp incremental frames. The manager
  // is process-global while attach is per-session: with several sessions
  // attached the same state is pushed once per attach — idempotent on the
  // frontend (identical content overwrites), so no cross-entry dedup here.
  // Re-reading the full manager state per event beats replaying event payloads
  // (out-of-order/coalesced events cannot desync the view).
  const unsubMcp = entry.sessionResult?.mcpManager?.addConnectionStatusListener?.(() => {
    bus.send(
      JSON.stringify(
        stampEvent({ type: "capabilities_mcp", mcp: snapshotMcp(entry.sessionResult.mcpManager) }),
      ),
    );
  });
  // Listen for base session title changes (auto-generated model titles, /rename, etc.)
  const unsubTitle = entry.session.sessionManager.onSessionNameChanged?.(() => {
    const title = entry.session.sessionManager.getSessionName() ?? "";
    entry.title = title || null;
    bus.send(JSON.stringify({ type: "session_title_changed", sessionId, title }));
  });
  entry.unsubscribe = () => {
    entry.coreAttached = false;
    unsubSession();
    unsubTitle?.();
    detachDequeueHook();
    unsubQueueChange();
    unsubPersistenceNotice?.();
    unsubMcp?.();
    for (const sub of entry.uiSubViews.values()) sub.unsubscribe();
    entry.uiSubViews.clear();
    entry.uiSockets.clear();
  };
  sessions.set(sessionId, entry);
}

/** Create a session on `cwd` with `model`, attach it, and push session_created. */
export async function spawnSession(ws: any, workDir: string, targetModel: any, thinkingLevel?: string, opts?: { automation?: { id: string; title: string; computer?: boolean } }) {
  const { sessionId, entry, eventBus } = await createSessionCore(
    workDir,
    SessionManager.create(workDir),
    [],
    targetModel,
  );
  // Scheduler-spawned session: stamps the pool entry (session_list marker) and
  // flags session_created as background so the UI registers the slot without
  // stealing focus / closing the automations view
  if (opts?.automation) entry.automation = opts.automation;
  // Explicit level from the UI wins; otherwise the model's own default (the
  // enabledModels "provider/id:level" suffix, same precedence as set_model) —
  // scheduler/ACP spawns pass no level and would otherwise sit on the SDK default.
  const level = thinkingLevel ?? (entry.session.model ? enabledDefaults.get(`${entry.session.model.provider}/${entry.session.model.id}`) : null);
  if (level) {
    try {
      entry.session.setThinkingLevel(level);
    } catch (err) {
      safeStderr(`[host] setThinkingLevel(${level}) failed on new session ${sessionId.slice(0, 8)}: ${err}\n`);
    }
  }
  // Kimi auto gate: the SDK default (defaultThinkingLevel: auto) or the UI
  // override can leave a fresh kimi-code session on `auto` while the
  // providers-page switch is off — pin it to `high` before the first turn
  try {
    const configured = entry.session.configuredThinkingLevel?.();
    const gated = gateKimiAutoThinking(entry.session.model?.provider, configured);
    if (gated && gated !== configured) entry.session.setThinkingLevel(gated);
  } catch (err) {
    safeStderr(`[host] kimi auto-thinking gate failed on new session ${sessionId.slice(0, 8)}: ${err}\n`);
  }
  // Computer-use opt-in at spawn: user sessions follow the desktop "default on" switch;
  // automation runs follow the automation's own flag (never the desktop default). Applied
  // here only — loading a session from disk keeps whatever state it was left in.
  if (computerDefaultAppliesFor(opts?.automation)) {
    void setComputerMode(ws, sessionId, entry, true).catch((err) => {
      safeStderr(`[host] computer mode default-enable failed on new session ${sessionId.slice(0, 8)}: ${err}\n`);
    });
  }
  if (opts?.automation) {
    // The scheduler passes a broadcast adapter as ws (its send fans out over
    // every connected UI). Attaching it would double-send once a real UI also
    // subscribes to this session, and it never detaches on close — attach the
    // real sockets instead.
    eachUiWs((w) => attachEntryUi(w, sessionId, entry, eventBus));
  } else {
    attachEntry(ws, sessionId, entry, eventBus);
  }
  ws.send(JSON.stringify(buildSessionCreatedFrame(sessionId, entry, { automation: opts?.automation })));
  pushComputerMode(ws, sessionId, entry); // fresh overlay is always off; the explicit frame keeps the button honest after plan-approve session swaps
  return { sessionId, entry };
}

// Plan approval needs a fresh session (approve-and-execute / save-and-quit) but
// cannot import this module back — it is the caller. Inject the factory instead.
setFreshSessionFactory((ws, entry) => spawnSession(ws, entry.cwd, entry.session.model));

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
  if (computerMode) {
    void setComputerMode(ws, sessionId, entry, true).catch((err) => {
      safeStderr(`[host] computer mode enable failed on new session ${sessionId.slice(0, 8)}: ${err}\n`);
    });
  }
  safeStderr(hostI18n.t("errors.lifecycle.sessionCreated", { sessionId: sessionId.slice(0, 8), cwd: workDir, model: modelStr ?? "default", thinking: thinkingLevel ?? "default", active: sessions.size }));
}

// Post-session_created snapshot sequence, one function for both load
// branches (A12 collapsed the two hand-written step lists). Step ORDER is
// identical across the branches; the difference is the step SET, and every
// difference is semantic, not incidental (checked against the pre-split
// code):
//   - plan state: reuse re-pushes the live plan mode; rebuild must first
//     reconcile it from the persisted mode_change entries (reconcile pushes
//     the resulting state itself).
//   - plan output: reuse re-pushes the remembered deliverable; rebuild falls
//     back to the newest local:// plan file on disk (async read).
//   - goal: rebuild awaits goal.restore() BEFORE pushGoal so the frame reads
//     the restored state; reuse has nothing persisted to restore.
//   - subagent history replay: rebuild always replays (the store is
//     guaranteed empty); reuse only after a frontend reload (store wiped).
async function pushSessionSnapshot(
  ws: any,
  sessionId: string,
  entry: PoolEntry,
  req:
    | { mode: "reuse"; sessionPath: string; replaySubagents: boolean }
    | { mode: "rebuild"; sessionPath: string; entries: any[] },
): Promise<void> {
  if (req.mode === "rebuild") {
    reconcilePlanMode(ws, sessionId, entry, req.entries); // Restore plan mode from persisted mode_change (frames must be pushed after session_created)
  } else {
    pushPlanMode(ws, sessionId, entry); // The reuse snapshot also pushes plan state (the frontend relies on it to show the "plan" button after reload)
  }
  // Per-session computer opt-in state (reuse: the composer button relies on it;
  // rebuild: resets any stale lit button from the pinned-off overlay)
  pushComputerMode(ws, sessionId, entry);
  if (req.mode === "rebuild") await entry.goal.restore(); // Goal mode restore (persisted mode_change goal/goal_paused; aligned with the TUI, no proactive re-run)
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
  // Todos backlog (TodoTracker synced from the transcript branch at construction; without
  // the frame history TODOs vanish after the frontend rebuilds its objects)
  pushTodos(ws, sessionId, entry);
  if (req.mode === "rebuild") {
    await pushRestoredPlanOutput(ws, sessionId, entry); // Disk-restore fallback: newest local:// plan file becomes the todo card's output row
  } else {
    pushPlanOutput(ws, sessionId, entry); // Reuse snapshot: remembered plan deliverable (todo card's output row survives a frontend reload)
  }
  pushGoal(sessionId); // Goal state backlog (session state card goal area; rebuild pushes after restore)
  pushContext(ws, sessionId, entry); // rebuild: initial context usage (system prompt + history)
  pushSessionStats(ws, sessionId, entry); // Whole-session stats (otherwise stats stay empty after the frontend rebuilds objects; reload restarts the in-memory duration from 0)
  ws.send(JSON.stringify(stampEvent({ type: "bg_jobs", sessionId, jobs: bgJobsPayload(entry.session) }))); // bg jobs backlog (async-jobs.ts: badge would go stale after reload)
  // Subagent history replay (child run files live in the sibling artifacts dir; the
  // frontend store is empty on both replaying paths, so the full tool stream is safe)
  const replaySubagents = req.mode === "rebuild" ? true : req.replaySubagents;
  if (replaySubagents) replaySubagentHistory(ws, req.sessionPath, sessionId, true);
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
    // The user opening/switching back to this session = seen (stop probing)
    markSeen(entry);
    // Attach only when this socket is not subscribed yet: local desktop and
    // remote control watch the same entry concurrently (the core fans out
    // over entry.uiSockets), so unlike the old single-attachedWs model there
    // is nothing to detach — the other channel's subscription keeps living.
    const frontendReloaded = !entry.uiSockets.has(ws);
    if (frontendReloaded) attachEntry(ws, sessionId, entry, entry.sessionResult.eventBus);
    ws.send(JSON.stringify(buildSessionCreatedFrame(sessionId, entry, { subagentLineage: true })));
    await pushSessionSnapshot(ws, sessionId, entry, {
      mode: "reuse",
      sessionPath,
      // Frontend reload: its store was wiped, so replay the subagent history (the full tool
      // stream — the store is guaranteed empty, no duplicates can stack up). Same-ws
      // switch-backs skip: the live entries are still in the store.
      replaySubagents: frontendReloaded,
    });
    if (entry.externalWrite) ws.send(JSON.stringify({ type: "session_external_write", sessionId })); // Detected during LRU eviction; re-sent on switch-back
    // Switch-back after frontend eviction: re-mount if the previous detach
    // released the session's MCP holds (idempotent — mounted sessions return)
    void mountMcpForSession(sessionId, entry);
    safeStderr(hostI18n.t("errors.lifecycle.sessionReused", { sessionId: sessionId.slice(0, 8), active: sessions.size }));
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
  // Subagent session detection: child transcript lives inside <parentSessionFile minus .jsonl>/
  // Read before creation so the subagent tool surface (create_automation) can be withheld.
  const parentSessionFile = `${path.dirname(sessionPath)}.jsonl`;
  const isSubagent = fs.existsSync(parentSessionFile);
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript, undefined, { subagent: isSubagent });
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
  ws.send(JSON.stringify(buildSessionCreatedFrame(sessionId, entry, { subagentLineage: true })));
  await pushSessionSnapshot(ws, sessionId, entry, { mode: "rebuild", sessionPath, entries });
  safeStderr(hostI18n.t("errors.lifecycle.sessionLoaded", { sessionId: sessionId.slice(0, 8), cwd: entry.cwd, entries: transcript.length }));
}
