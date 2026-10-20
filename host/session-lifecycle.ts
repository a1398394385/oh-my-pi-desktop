// Session lifecycle domain: the create/load entry points (pool reuse vs disk
// rebuild) and the post-created snapshot sequence with the collapsed
// session_created frame emission. The attach wiring closure (event
// subscription + approval UI context + extension runner injection + queue /
// persistence / mcp / title listeners) lives in session-entry-core.ts
// (entry-core cut after A12); the snapshot push family lives in
// session-snapshot.ts and the subagent roster (live tables + eventBus
// subscriptions + disk replay) in subagent-view.ts (A12 split). Relocated
// from main.ts (second split cut).
import path from "node:path";
import fs from "node:fs";
import {
  createAgentSession,
  AgentRegistry,
  SessionManager,
 } from "./bootstrap.ts";
import {
  H,
  sessions,
  enabledDefaults,
  defaultCwd,
  stampEvent,
  pendingApprovals,
  pushCommandOutput,
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
import { entriesToTranscript, sumRunDurationMs } from "./translate.ts";
import {
  buildSessionCreatedFrame,
  maybePushSessionStats,
  pushContext,
  pushGoal,
  pushSessionStats,
  pushTodos,
} from "./session-snapshot.ts";
import { replaySubagentHistory } from "./subagent-view.ts";
import { readKeepaliveEnabled } from "./keepalive-config.ts";
import { gateKimiAutoThinking } from "./kimi-thinking.ts";
import { readAcpRaw, readAcpEnabled, readSessionContextEnabled } from "./profile.ts";
import { readPluginsEnabled, readHooksEnabled } from "./plugin-assets.ts";
import { createKeepaliveExtension } from "./keepalive.ts";
import { markSeen, reportKeepaliveState } from "./keepalive-host.ts";
import { pushPlanMode, reconcilePlanMode, setPlanMode } from "./plan.ts";
import { computerDefaultAppliesFor, pushComputerMode, setComputerMode } from "./computer-mode.ts";
import { pushPlanOutput, pushRestoredPlanOutput, setFreshSessionFactory } from "./plan-approve.ts";
import { bgJobsPayload } from "./async-jobs.ts";
import { hostI18n } from "./i18n/host.ts";
import { mountMcpForSession } from "./mcp-mount.ts";
import { safeStderr } from "./stderr.ts";
import { settingsGet } from "./settings-compat.ts";

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

// Entry-core cut: attachEntry / attachEntryUi moved to session-entry-core.ts;
// re-exported here only as an import (spawnSession / handleLoadSession use them).
import { attachEntry, attachEntryUi } from "./session-entry-core.ts";
export { attachEntry };

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
      ...(acpRuntime ? [createCompressContextTool(acpRuntime), createRecallBlockTool(acpRuntime), createAcpStatusTool(acpRuntime, () => Number(settingsGet(sessionSettings, "tools.artifactSpillThreshold")) * 1024)] : []),
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
  // The holder feeds the force channel above. The initial rebind matters for
  // sessions created without an explicit model (load/branch pass undefined):
  // no model_changed fires at init, so without it the runtime keeps the
  // fallback byte-estimate counter instead of the resolved model's tokenizer.
  if (acpRuntime) {
    acpSession.session = session;
    acpRuntime.rebindModel(session.model);
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
    lastActiveAt: Date.now(), // N2 idle-eviction clock; see state.ts PoolEntry
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
