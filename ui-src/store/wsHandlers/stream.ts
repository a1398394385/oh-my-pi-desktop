// Session runtime-domain frames: approval cards, event-stream rebuilding, local bash, slash command
// output, subagent streams, todos/goal/queued, context usage and stats, error landing. Moved over
// from store/ws.ts onMessage.
import { useAppStore } from "../index";
import { t } from "../../i18n";
import {
  applyDelta,
  applyEvent,
  applySteerConsumed,
  bgJobsKey,
  findBySessionId,
  rebuildMessages,
  updateSession,
} from "../session";
import { notifyDesktop } from "../notify";
import type { SessionItem } from "../../types/session";
import { landBrowserTabs } from "../right";
import { landCacheWarming } from "../ui";
import { emitBrowserFrame } from "../browserMirror";
import { feedTtsDelta, flushTts, playTtsClip, speakNow, stopTts } from "../../lib/speechOut";
import type { HandlerSlice } from "./types";

// Deduplicate tool-row file lists (used by the tool_update branch of subagent_event)
function uniqueFiles(files: string[] | null | undefined): string[] {
  return [...new Set(files ?? [])];
}

// Last in-flight local-bash row (reverse scan, zero allocation — bash_chunk runs per chunk)
function lastRunningBash(items: SessionItem[]): Extract<SessionItem, { role: "bash" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === "bash" && it.running) return it;
  }
  return undefined;
}

// Mirror a running subagent's stream state onto its opened transcript view (the
// openSessions entry keyed by sessionFile): MessagePage's spinner + "Working Ns" row read
// entry.streaming / entry.turnStartAt, which only main-session frames would otherwise set —
// subagent streaming arrives on the parent session's subagent_* frames, so the child view
// stayed spinner-less. Idempotent: skips when the view already matches.
function syncSubViewStream(parentSessionId: string, subagentId: string, streaming: boolean): void {
  const parent = findBySessionId(parentSessionId);
  const sub = parent?.subagents.get(subagentId);
  if (!parent || !sub?.sessionFile) return;
  const view = useAppStore.getState().openSessions.get(sub.sessionFile);
  if (!view?.isSubagent || (view.streaming === streaming && !streaming)) return;
  updateSession(view.sessionId, (s) => {
    s.streaming = streaming;
    s.turnStartAt = streaming ? (sub.registeredAt ?? Date.now() - (sub.usage?.durationMs ?? 0)) : null;
    if (!streaming) s.workingText = null;
  });
}

export const streamHandlers = {
  plan_mode(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.planMode = !!msg.enabled;
      },
      false,
    );
  },
  computer_mode(msg) {
    // The host attaches `error` when a computer-use toggle failed (kimi-cu
    // not installed / connect failed, gate closed, prelude unavailable) —
    // surface it as a red toast on top of the in-session command_output line.
    if (msg.error) useAppStore.getState().toast(msg.error, true);
    updateSession(
      msg.sessionId,
      (s) => {
        s.computerMode = !!msg.enabled;
      },
      false,
    );
  },
  advisor_mode(msg) {
    // Header eye toggle state (host/advisor-mode.ts). `error` rides along when
    // the overlay went on but no model resolved for the 'advisor' role — the
    // eye lights (the setting IS on) while the toast explains the missing half.
    if (msg.error) useAppStore.getState().toast(msg.error, true);
    updateSession(
      msg.sessionId,
      (s) => {
        s.advisorMode = !!msg.enabled;
      },
      false,
    );
  },
  approval_request(msg) {
    updateSession(msg.sessionId, (s) => {
      s.pendingApprovals ??= [];
      s.pendingApprovals.push({
        requestId: msg.requestId,
        title: msg.title,
        options: msg.options,
        keepContextTokens: msg.keepContextTokens,
        disabledIndices: msg.disabledIndices,
        slider: msg.slider,
        sliderIndex: msg.slider?.index,
        editable: !!msg.editable,
        editableIndex: msg.editableIndex,
        prefill: msg.prefill ?? "",
        // Ask-dialog variant (18.5 uiCtx.askDialog): the multi-question form;
        // ApprovalCard renders it as one merged submit
        questions: msg.questions,
        // The ask tool's `i` intent (host-captured), shown above the questions
        intent: msg.intent,
        // Plan variant: raw plan text + title + path (the card body + the todo
        // card's output row render from it)
        plan: msg.plan,
        answer: null,
      });
      // Remember the latest plan deliverable at session level: unlike the
      // approval entry (removed once resolved), the todo card's output row
      // stays clickable after the plan is approved.
      if (msg.plan) s.planResult = msg.plan;
    });
    const s = findBySessionId(msg.sessionId);
    if (s) notifyDesktop("approval", s, t("notify.approvalTitle"), msg.title);
  },
  approval_resolved(msg) {
    useAppStore.setState((st2) => {
      const openSessions = new Map(st2.openSessions);
      for (const [p, s] of openSessions) {
        if (s.pendingApprovals) {
          openSessions.set(p, { ...s, pendingApprovals: s.pendingApprovals.filter((request) => request.requestId !== msg.requestId) });
        }
      }
      return { openSessions };
    });
  },
  event(msg) {
    applyEvent(msg);
  },
  messages(msg) {
    rebuildMessages(msg);
  },
  // ---- Composer sigil: local bash execution frames (! prefix, driven by the host's bash_exec) ----
  bash_start(msg) {
    updateSession(msg.sessionId, (s) => {
      s.items.push({ role: "bash", text: msg.command, output: "", running: true, excludeFromContext: !!msg.excludeFromContext });
    });
  },
  bash_chunk(msg) {
    const s = findBySessionId(msg.sessionId);
    if (!s || !lastRunningBash(s.items)) return;
    // Coalesced streaming output rendering (same 100ms throttle as text_delta: mutate in place, swap the reference at window flush)
    applyDelta(msg.sessionId, (next) => {
      const target = lastRunningBash(next.items);
      if (target) target.output = (target.output || "") + msg.chunk;
    });
  },
  bash_done(msg) {
    updateSession(msg.sessionId, (s) => {
      const it = lastRunningBash(s.items);
      // bash_abort first receives a done frame with cancelled:true, possibly duplicated by the
      // official done — last one wins; when no running item is found the second time, ignore silently
      if (!it) return;
      it.running = false;
      if (msg.error != null) {
        it.error = String(msg.error);
      } else {
        it.output = msg.output ?? it.output;
        it.exitCode = msg.exitCode ?? null;
        it.cancelled = !!msg.cancelled;
        it.timedOut = !!msg.timedOut;
        it.truncated = !!msg.truncated;
      }
    });
  },
  // ! bash-mode completion reply: transient like mentionResult (reqId-stamped;
  // the plugin ignores results whose reqId lags its latest request)
  bash_complete_result(msg) {
    useAppStore.setState({ bashCompleteResult: { reqId: msg.reqId, items: msg.items } });
  },
  // Text output of slash commands (e.g. the /computer status echo): echoed in the
  // composer as a one-second flip card, NOT as a transcript row — a consumed command
  // is an input-level event, and leaving a command card in the message flow pushed the
  // turn's action bar below it (see items.tsx grouping, since removed).
  command_output(msg) {
    useAppStore.getState().showCommandFlash(String(msg.sessionId ?? ""), String(msg.text ?? ""), String(msg.command ?? ""));
  },
  // Background command phase rows: start inserts an in-flight row; fail withdraws that command's
  // in-flight row. The done state does not travel on transient frames: phase rows converted from
  // on-disk traces arrive with the messages rebuild (single source of truth)
  command_phase(msg) {
    updateSession(msg.sessionId, (s) => {
      if (msg.phase === "start") {
        s.items.push({ role: "phase", phase: "start", command: msg.command, text: String(msg.text ?? "") });
      } else {
        const pending = s.items.findIndex(
          (it) => it.role === "phase" && it.phase === "start" && it.command === msg.command,
        );
        if (pending >= 0) s.items.splice(pending, 1);
      }
    });
  },
  // Word-completion reply (18.5 complete_text RPC): overwrite-per-frame store
  // landing; GhostTextPlugin matches it against its pending request (session +
  // draft text) and silently drops stale hits
  completion(msg) {
    useAppStore.setState({ completionResult: { sessionId: msg.sessionId, suggestion: msg.suggestion ?? "" } });
  },
  // Background job snapshot (18.5 get_bg_jobs/cancel_bg_job replies): replace the
  // slice for this frame's scope wholesale (the frame is a full snapshot)
  bg_jobs(msg) {
    const key = bgJobsKey(msg.sessionId, msg.subagentId);
    useAppStore.setState((st) => ({ bgJobs: new Map(st.bgJobs).set(key, msg.jobs) }));
  },
  // Slash command consumed locally by the host: withdraw the optimistically inserted user bubble (the last same-text one without an entryId)
  command_result(msg) {
    updateSession(msg.sessionId, (s) => {
      if (msg.consumed) {
        for (let i = s.items.length - 1; i >= 0; i--) {
          const it = s.items[i];
          if (it.role === "user" && it.text === msg.text && !it.entryId) {
            s.items.splice(i, 1);
            break;
          }
        }
        // A consumed command never opens a model run, but the composer's optimistic
        // send already flipped streaming on at submit time. No turn_start will ever
        // arrive to confirm a run, and stop is a no-op against an idle session (no
        // turn_end either), so the spinner would wedge forever (ghost "unstoppable
        // agent loop" after e.g. /computer on). turnItemStart is only set by a
        // host-confirmed turn_start (or a steer injection), so null + streaming
        // means the running state is still local-only and safe to retract here.
        if (s.streaming && s.turnItemStart == null) {
          s.streaming = false;
          s.workingText = null;
          s.turnStartAt = null;
        }
      }
    });
  },
  subagent_lifecycle(msg) {
    updateSession(msg.sessionId, (s) => {
      // At completion (completed/failed/aborted) the base re-sends lifecycle with the same
      // subagentId — only update status and keep accumulated content, otherwise the detail view
      // would be wiped after completion
      const prev = s.subagents.get(msg.subagentId);
      s.subagents.set(msg.subagentId, {
        agent: msg.agent,
        description: msg.description ?? "",
        status: msg.status,
        // host-filled derived fields: display name / parent agent / registration time / transcript file
        name: msg.name ?? prev?.name,
        parent: msg.parent ?? prev?.parent,
        registeredAt: msg.registeredAt ?? prev?.registeredAt,
        sessionFile: msg.sessionFile ?? prev?.sessionFile,
        readOnly: msg.readOnly ?? prev?.readOnly,
        advisor: msg.advisor ?? prev?.advisor,
        text: prev?.text ?? "",
        tools: prev?.tools ?? [],
        streaming: msg.status === "started",
        // Terminal statuses carry the submitted report; a wake re-run (started over
        // the same id) invalidates the previous run's result
        result: msg.status === "started" ? undefined : (msg.result ?? prev?.result),
      });
    });
    // Terminal/started status also drives the subagent transcript view's spinner + elapsed row
    syncSubViewStream(msg.sessionId, msg.subagentId, msg.status === "started");
  },
  subagent_progress(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        // Aggregated usage frame (already throttled to 500ms by the host): cost/duration/requests/tool count/tokens/context/current step
        const prev = s.subagents.get(msg.subagentId);
        if (!prev) return;
        prev.usage = {
          cost: msg.cost,
          durationMs: msg.durationMs,
          requests: msg.requests,
          toolCount: msg.toolCount,
          tokens: msg.tokens,
          contextTokens: msg.contextTokens,
          contextWindow: msg.contextWindow,
          currentTool: msg.currentTool,
          currentToolArgs: msg.currentToolArgs,
          currentToolStartMs: msg.currentToolStartMs,
          lastIntent: msg.lastIntent,
          resolvedModel: msg.resolvedModel,
          resolvedThinkingLevel: msg.resolvedThinkingLevel,
          recentTools: msg.recentTools,
        };
        if (msg.status) prev.status = msg.status;
        if (msg.task) prev.task = msg.task;
        if (msg.name && !prev.name) prev.name = msg.name;
        if (msg.parent && !prev.parent) prev.parent = msg.parent;
        if (msg.registeredAt && !prev.registeredAt) prev.registeredAt = msg.registeredAt;
        if (msg.sessionFile && !prev.sessionFile) prev.sessionFile = msg.sessionFile; // late-arriving child transcript path (started may predate persistence)
      },
      false,
    );
    // Running heartbeat: keeps the transcript view's spinner + elapsed row alive even if the
    // view was opened after the run's turn_start (and re-arms it on a wake re-run). Terminal
    // statuses must NOT re-light it — the host re-sends the last progress alongside the
    // terminal lifecycle, which would otherwise undo the lifecycle's clear.
    const live = msg.status !== "completed" && msg.status !== "failed" && msg.status !== "aborted";
    syncSubViewStream(msg.sessionId, msg.subagentId, live);
  },
  subagent_event(msg) {
    // Text deltas are high-frequency: mutate in place + 100ms window flush (same as the main-chat text_delta)
    if (msg.kind === "text_delta") {
      applyDelta(msg.sessionId, (s) => {
        const sub = s.subagents.get(msg.subagentId);
        if (sub) sub.text += msg.text;
      });
      return;
    }
    // History replay (handleLoadSession's replaySubagentHistory) pushes the whole tool stream of
    // every past subagent in one burst — thousands of frames on a heavy session. updateSession
    // swaps the openSessions Map + a fresh session copy per frame, so each frame re-rendered the
    // tree: one 4-5s main-thread block, and the sidebar looked dead until it drained. applyDelta
    // mutates in place and notifies once per 100ms window (the text_delta path), so a burst costs
    // ~10 renders instead of ~3000 with identical end state.
    applyDelta(
      msg.sessionId,
      (s) => {
        const sub = s.subagents.get(msg.subagentId);
        if (!sub) return;
        if (msg.kind === "turn_start") sub.streaming = true;
        else if (msg.kind === "tool") sub.tools.push({ name: msg.name, args: msg.args, files: msg.files, toolCallId: msg.toolCallId, running: true, at: Date.now() });
        else if (msg.kind === "tool_update") {
          // Reverse scans (zero allocation): toolCallId match first, name fallback
          let last: (typeof sub.tools)[number] | undefined;
          for (let k = sub.tools.length - 1; k >= 0; k--) {
            const t = sub.tools[k];
            if (t.toolCallId && t.toolCallId === msg.toolCallId) {
              last = t;
              break;
            }
          }
          if (!last) {
            for (let k = sub.tools.length - 1; k >= 0; k--) {
              const t = sub.tools[k];
              if (t.name === msg.name) {
                last = t;
                break;
              }
            }
          }
          if (last)
            Object.assign(last, {
              files: uniqueFiles(msg.files ?? last.files),
              added: msg.added,
              removed: msg.removed,
              todo: msg.todo,
              output: msg.output ?? last.output,
              details: msg.details ?? last.details,
              diffContent: msg.diffContent ?? last.diffContent,
              running: false,
            });
        } else if (msg.kind === "turn_end") sub.streaming = false;
      },
    );
  },
  // Subagent control receipt (18.5 cancel/steer control_subagent): pure wire
  // acknowledgement — the next lifecycle/progress frame carries the effect; no
  // UI consumer yet (registered for the exhaustive HandlerMap gate)
  subagent_controlled(msg) {
    if (!msg.ok && msg.error) useAppStore.getState().toast(msg.error);
  },
  // Prompt-cache warming lifecycle (18.5 cache_warming start/end): drives the hub detail's
  // transient "cache warming" line (ui slice hubWarming, with a lost-end self-clear guard)
  cache_warming(msg) {
    landCacheWarming(msg.sessionId, msg.phase);
  },
  // Dictation lifecycle: recording/transcribing drive the mic button look,
  // idle with a message surfaces the host-side warning/progress once
  stt_state(msg) {
    if (msg.state === "idle") {
      useAppStore.setState({ voiceStt: null });
      if (msg.message) useAppStore.getState().toast(msg.message);
    } else {
      useAppStore.setState({ voiceStt: { state: msg.state, ...(msg.message ? { message: msg.message } : {}) } });
    }
  },
  // Dictation target text: the host already joined anchor + committed +
  // volatile, so landing is one external composer fill
  stt_draft(msg) {
    useAppStore.getState().setComposerValue(msg.text);
  },
  // Dictation auto-submit (stt.submitTrigger met): bump the signal the
  // Composer effect watches to send the prompt
  stt_submit() {
    useAppStore.setState((s) => ({ sttSubmitSignal: s.sttSubmitSignal + 1 }));
  },
  // Speech-out frames: the host forwards mode-filtered assistant deltas; the
  // system speechSynthesis (lib/speechOut) speaks them UI-side
  tts_delta(msg) {
    feedTtsDelta(msg.text);
  },
  tts_flush() {
    flushTts();
  },
  tts_stop() {
    stopTts();
  },
  // One-shot reading (turn-end speaker button): a configured speech model arrives
  // as a synthesized clip, the unconfigured default as system-voice text
  tts_audio(msg) {
    if (msg.backend === "system") {
      void speakNow(msg.text ?? "");
      return;
    }
    playTtsClip(msg.data ?? "", msg.mime ?? "audio/mpeg");
  },
  tts_failed(msg) {
    useAppStore.getState().toast(msg.message);
  },
  // Settings-page voice sections: model status snapshot / download progress /
  // test-mode dictation result
  voice_status(msg) {
    useAppStore.setState({ voiceStatus: { modelId: msg.modelId, modelKey: msg.modelKey, ready: msg.ready, downloading: msg.downloading } });
  },
  stt_download_progress(msg) {
    useAppStore.setState({ voiceDownload: { percent: msg.percent, status: msg.status, label: msg.label, at: Date.now() } });
  },
  stt_test_result(msg) {
    useAppStore.setState({ sttTestResult: { text: msg.text, at: Date.now() } });
  },
  todos(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.todos = msg.phases ?? [];
      },
      false,
    );
  },

  // Plan deliverable snapshot (reuse/fork restore): repopulates the todo card's
  // output row the same way the approval frame's `plan` field does.
  plan_output(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.planResult = msg.plan;
      },
      false,
    );
  },
  goal(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.goal = msg.goal ?? null;
      },
      false,
    );
  },
  queued(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.queued = msg.followUp ?? [];
        s.steering = msg.steering ?? [];
      },
      false,
    );
  },
  steer_consumed(msg) {
    applySteerConsumed(msg);
  },
  context(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.ctx = { tokens: msg.tokens, window: msg.window, percent: msg.percent };
      },
      false,
    );
  },
  session_stats(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        // Whole-session stats (pushed by the host mid-turn and at teardown): permanently shown on the status row below the composer
        s.stats = {
          tokens: msg.tokens,
          cost: msg.cost,
          subagentCost: msg.subagentCost,
          cacheHitRate: msg.cacheHitRate,
          cacheBreaks: msg.cacheBreaks,
          cacheMissTokens: msg.cacheMissTokens,
          cacheMissUsd: msg.cacheMissUsd,
          compactions: msg.compactions,
          advisorCost: msg.advisorCost,
          activeMs: msg.activeMs,
          statsAt: msg.statsAt,
          receivedAt: msg.statsAt, // host stamp sampled with activeMs: extrapolation stays monotonic across frames (local landing time would rewind it by the transport delay)
          tokenSpeed: msg.tokenSpeed,
          avgTtft: msg.avgTtft,
        };
      },
      false,
    );
  },
  context_detail(msg) {
    // ringpop popover transient data; CtxCard subscribes and repaints (updates while collapsed don't rebuild; discard-on-leave)
    useAppStore.setState((s) => ({ ctxDetail: msg }));
  },
  browser_tabs(msg) {
    landBrowserTabs(msg.tabs ?? []);
  },
  browser_frame(msg) {
    emitBrowserFrame(msg);
  },
  error(msg) {
    useAppStore.setState((s) => ({
      gitDiffCache: { ...s.gitDiffCache, loading: false },
      rightState: { ...s.rightState, fileTreePending: new Set() }, // file-tree request failed: clear pending so collapse-reexpand retries
      manualSaving: false, // wizard save failed: release the in-flight button (probe self-clears via its reply frame)
    }));
    // Error landing for settings-center asset/memory read failures (the old version wrote aeStatus / memory inline state)
    if (msg.kind) useAppStore.setState((s) => ({ assetErr: { kind: msg.kind!, message: msg.message, at: Date.now() } }));
    const md = useAppStore.getState().memoryDetail;
    if (md.status === "loading") {
      useAppStore.setState((s) => ({
        memoryDetail: { ...s.memoryDetail, status: "error", error: msg.message },
      }));
    }
    const sid = msg.sessionId;
    if (sid && findBySessionId(sid)) {
      updateSession(sid, (next) => {
        next.items.push({ role: "error", text: msg.message });
      });
    } else {
      useAppStore.getState().toast(msg.message);
    }
  },
} satisfies HandlerSlice;

// Domain key set (for the exhaustive-assertion cross-check in index)
export type StreamFrames = keyof typeof streamHandlers;
