// Session entry-core domain: the attach wiring closure — attachEntry /
// attachEntryUi / subscribeEntryCore. Split out of session-lifecycle.ts
// (entry-core cut): the once-per-entry core subscribes the session event
// stream (delta coalescing, todos, bg_jobs, plan dispatch, context/stats,
// goal, cache warming, lifecycle timing, terminal agent_end wrap-up), builds
// the approval UI context (select/confirm/editor/askDialog + extension
// status), injects the extension runner actions/context and emits
// session_start, and hooks dequeue / queue-change / persistence-move / MCP /
// title listeners, torn down via entry.unsubscribe. The create/load entry
// points stay in session-lifecycle.ts.
import {
  H,
  sessions,
  stampEvent,
  pendingApprovals,
  requestApproval,
  pushPoolSnapshot,
  entryBus,
  eachUiWs,
  handleRunLifecycleEvent,
  type PoolEntry,
} from "./state.ts";
import { USER_INTERRUPT_LABEL, isUserQueuedMessage, toRestoredQueuedMessage } from "./bootstrap.ts";
import { translateEvent } from "./translate.ts";
import { createDeltaCoalescer } from "./delta-coalesce.ts";
import { pushContext, maybePushSessionStats, pushSessionStats } from "./session-snapshot.ts";
import { createSubagentView } from "./subagent-view.ts";
import { sendQueued, releaseOneParked } from "./queue.ts";
import { dispatchFromToolEnd } from "./plan-approve.ts";
import { autoReviewThenApprove, rememberToolCall } from "./auto-review.ts";
import { approvalDeadlineMs, timedOutAskAnswer } from "./dialog-deadline.ts";
import { markTurnWrapped } from "./keepalive-host.ts";
import { snapshotMcp } from "./capabilities.ts";
import { handleVoiceEvent } from "./voice.ts";
import { bgJobsCorrection } from "./async-jobs.ts";
import { maybeRefreshSessionTitle, syncBranchTitle } from "./session-titles.ts";
import { hostI18n } from "./i18n/host.ts";
import { safeStderr } from "./stderr.ts";
import { getExtensionUISelectOptionLabel, type ExtensionUIDialogOptions, type ExtensionUISelectItem } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

// Structural minimum for a socket attachEntry accepts: the primary server and
// the LAN remote server both satisfy it, and so do fan-out adapters (entryBus).
type UiSocket = { send(data: string): unknown };

/** Subscribe the once-per-entry core without a socket: headless loads (automation
 *  delivery into an evicted session) must run the session's event fan-out before
 *  any UI socket exists; sockets join later through attachEntryUi. */
export function attachEntryCore(sessionId: string, entry: PoolEntry, eventBus: unknown) {
  if (entry.coreAttached) return;
  entry.coreAttached = true;
  subscribeEntryCore(sessionId, entry, eventBus);
}

/** Attach a UI socket to a pooled session. Idempotent per socket: the
 * once-per-entry core subscribes on first attach; every further socket (the
 * other channel of a remote-control session, a frontend reload) only joins
 * the fan-out set. */
export function attachEntry(ws: UiSocket, sessionId: string, entry: PoolEntry, eventBus: unknown) {
  attachEntryCore(sessionId, entry, eventBus);
  attachEntryUi(ws, sessionId, entry, eventBus);
}

/** Per-socket attach: join the fan-out set, start this socket's subagent
 * roster (A12 split), push the pool snapshot, and re-show dialogs already
 * open on another UI so a late joiner (e.g. remote control joining mid-
 * approval) can answer them too. */
export function attachEntryUi(ws: UiSocket, sessionId: string, entry: PoolEntry, eventBus: unknown) {
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

/** Leave a socket's fan-out set (socket close, or the frontend dropping its slot on
 *  LRU eviction). The last watcher leaving tears the core subscriptions down and
 *  restarts the idle-eviction clock: sweepIdlePoolSessions skips entries with any
 *  attached socket, so a stale attachment would pin the session in the pool forever. */
export function detachEntryUi(ws: UiSocket, entry: PoolEntry) {
  if (!entry.uiSockets.has(ws)) return;
  entry.uiSockets.delete(ws);
  entry.uiSubViews.get(ws)?.unsubscribe();
  entry.uiSubViews.delete(ws);
  if (entry.uiSockets.size === 0) entry.unsubscribe();
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
  const deltas = createDeltaCoalescer((p) => bus.send(JSON.stringify(stampEvent({ type: "event", sessionId, ...p }))));
  const unsubSession = entry.session.subscribe((ev) => {
    if (ev.type === "tool_execution_start") rememberToolCall(sessionId, { toolName: ev.toolName, params: ev.args });
    // Stash the ask tool's `i` intent; attached to the askDialog frame on push
    if (ev.type === "tool_execution_start" && ev.toolName === "ask" && typeof ev.intent === "string" && ev.intent.trim()) {
      askIntent = ev.intent.trim();
    }
    deltas.push(translateEvent(ev, entry));
    // TTS vocalization bridge: forward this session's deltas as tts_* frames (speech.enabled)
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
    // time_spent) + cross-channel pool busy broadcast (state.ts)
    if (ev.type === "agent_start" || ev.type === "agent_end") handleRunLifecycleEvent(entry, ev);
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
      maybeRefreshSessionTitle(entry);
      // Our own title write (title_change + branchTitle) lands in the file outside
      // the poll cursor: re-anchor from 0 so the next pass rescans instead of
      // reading a stale offset (see session-poll.ts).
      entry.pollKnownSize = 0;
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
    select(title: string, options: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
      const labels = options.map(getExtensionUISelectOptionLabel);
      // Ask rounds arrive with the base's per-session ask.timeout in
      // dialogOptions; the permission gate calls select with no dialogOptions at
      // all, so it takes this session's approval deadline instead. Either way
      // an expired deadline resolves undefined: the base picks the recommended
      // ask option, and anything but an explicit approval denies.
      const deadlineMs = dialogOptions ? dialogOptions.timeout : approvalDeadlineMs(entry);
      return autoReviewThenApprove(H, entry.session.messages, sessionId, title, labels, (t) =>
        requestApproval(
          bus,
          sessionId,
          t,
          labels,
          dialogOptions?.signal,
          undefined,
          undefined,
          undefined,
          undefined,
          deadlineMs !== undefined && deadlineMs > 0 ? { ms: deadlineMs } : undefined,
        ),
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
      const deadlineMs = dialogOptions?.timeout;
      return requestApproval(
        bus,
        sessionId,
        first.header ?? first.question ?? "ask",
        ["submit", "cancel"],
        dialogOptions?.signal,
        { intent },
        undefined,
        questions,
        undefined,
        // An expired ask dialog answers itself: the base only treats a missing
        // result as a cancel, so the deadline carries the recommended options.
        deadlineMs !== undefined && deadlineMs > 0 ? { ms: deadlineMs, answer: timedOutAskAnswer(questions) } : undefined,
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
    // Base-side naming writes the header only; journal it or a branch switch keeps a sibling's title.
    syncBranchTitle(entry.session.sessionManager);
    entry.pollKnownSize = 0; // Our own write: rescan instead of trusting the old offset (session-poll.ts)
    // everyUiWs, not only this entry's bus: an auto-generated title lands after the
    // run ended, i.e. after the other channel's session_finished list refresh — its
    // sidebar row would keep the old title forever without this push. path lets a
    // channel that never attached the session match its disk row.
    const data = JSON.stringify({ type: "session_title_changed", sessionId, title, path: entry.path });
    eachUiWs((w) => w.send(data));
  });
  entry.unsubscribe = () => {
    // Flush the coalesced delta tail while sockets are attached; restart the N2 idle clock at detach
    deltas.flush();
    entry.lastActiveAt = Date.now();
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
