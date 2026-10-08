// Session runtime-domain frames: approval cards, event-stream rebuilding, local bash, slash command
// output, subagent streams, todos/goal/queued, context usage and stats, error landing. Moved over
// from store/ws.ts onMessage.
import { useAppStore } from "../index";
import { t } from "../../i18n";
import {
  applyDelta,
  applyEvent,
  applySteerConsumed,
  findBySessionId,
  notifyDesktop,
  rebuildMessages,
  updateSession,
} from "../session";
import { landBrowserTabs } from "../right";
import { landCacheWarming } from "../ui";
import { emitBrowserFrame } from "../browserMirror";
import { feedTtsDelta, flushTts, stopTts } from "../../lib/speechOut";
import type { HandlerSlice } from "./types";

// Deduplicate tool-row file lists (used by the tool_update branch of subagent_event)
function uniqueFiles(files: string[] | null | undefined): string[] {
  return [...new Set(files ?? [])];
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
    updateSession(
      msg.sessionId,
      (s) => {
        s.computerMode = !!msg.enabled;
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
        answer: null,
      });
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
    if (!s) return;
    const it = [...s.items].reverse().find((x): x is Extract<(typeof s.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
    if (it) {
      // Coalesced streaming output rendering (same 100ms throttle as text_delta: mutate in place, swap the reference at window flush)
      applyDelta(msg.sessionId, (next) => {
        const target = [...next.items].reverse().find((x): x is Extract<(typeof next.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
        if (target) target.output = (target.output || "") + msg.chunk;
      });
    }
  },
  bash_done(msg) {
    updateSession(msg.sessionId, (s) => {
      const it = [...s.items].reverse().find((x): x is Extract<(typeof s.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
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
  // Text output of slash commands (e.g. the /computer status echo): lands as a meta row, or as
  // an expandable command card when the frame carries the typed command line (slash dispatch)
  command_output(msg) {
    updateSession(msg.sessionId, (s) => {
      s.items.push({
        role: "meta",
        text: String(msg.text ?? ""),
        ...(msg.command ? { command: msg.command, cmdExpanded: true } : {}),
      });
    });
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
  // Background job snapshot (18.5 get_bg_jobs/cancel_bg_job replies): replace
  // the per-session slice wholesale (the frame is a full snapshot)
  bg_jobs(msg) {
    useAppStore.setState((st) => ({ bgJobs: new Map(st.bgJobs).set(msg.sessionId, msg.jobs) }));
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
        // usage fields accumulated from progress frames (kept when lifecycle re-sends)
        usage: prev?.usage,
      });
    });
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
      },
      false,
    );
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
    updateSession(
      msg.sessionId,
      (s) => {
        const sub = s.subagents.get(msg.subagentId);
        if (!sub) return;
        if (msg.kind === "turn_start") sub.streaming = true;
        else if (msg.kind === "tool") sub.tools.push({ name: msg.name, args: msg.args, files: msg.files, toolCallId: msg.toolCallId, running: true, at: Date.now() });
        else if (msg.kind === "tool_update") {
          const last =
            [...sub.tools].reverse().find((t) => t.toolCallId && t.toolCallId === msg.toolCallId) ||
            [...sub.tools].reverse().find((t) => t.name === msg.name);
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
      false,
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
          cacheHitRate: msg.cacheHitRate,
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
      rightState: { ...s.rightState, sessionTreePending: false, fileTreePending: new Set() }, // branch-tree/file-tree request failed: clear pending so collapse-reexpand retries
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
