// Voice conversation bridge: assistant vocalization (TTS) + dictation (STT).
//
// TTS runs UI-side on the system speechSynthesis (the bundled Kokoro has no
// Chinese G2P, while OS voices cover both languages with zero download), so
// the desktop host forwards speech events as tts_* frames instead of driving
// the SDK's vocalizer. handleVoiceEvent keeps the base event-controller
// semantics — mode-filtered deltas (assistant = text only, all = text +
// thinking, yield = nothing live), flush at message/turn end, silence on
// abort — and the last-prompted-session filter: pool sessions streaming in
// the background stay silent, otherwise parallel turns would read over each
// other through one speaker.
//
// STT: exactly one STTController exists (one microphone). The composer's
// push-to-talk sends stt_start with the draft text at press time (anchor);
// the controller's SttTarget callbacks are normalized into a single stt_draft
// frame carrying the full target text (anchor + committed + volatile), so the
// frontend never re-implements the volatile-text state machine. stt_submit
// fires when the configured submit trigger is met. Test mode (settings page)
// suppresses draft/submit frames and reports the final text via
// stt_test_result instead.
//
// Model management: the settings page resolves the dictation role to a
// concrete model, probes the local cache (voice_status), and downloads with
// live progress (stt_download_progress); the stt.enabled switch is gated on a
// cached model (rpc/settings.ts).
import type { SttState, SttTarget } from "@oh-my-pi/pi-coding-agent/stt";
import { STTController, isSttModelCached, downloadSttModel, resolveSttModelSpec, roleCandidatePool, resolveRoleChain } from "./bootstrap.ts";
import { H, stampEvent } from "./state.ts";
import { settingsGet } from "./settings-compat.ts";

type Ws = { send(data: string): unknown };

/** The session the user last prompted — the only session that gets vocalized. */
let lastVoiceSessionId: string | null = null;

/** Dictation runtime: one controller (one microphone) + the anchor/committed join state. */
let stt: InstanceType<typeof STTController> | null = null;
let sttSessionId = "";
let sttAnchor = "";
let sttCommitted = "";
let sttWs: Ws | null = null;
let sttTest = false;
/** Final text accumulator for test-mode captures. */
let sttTestText = "";

/**
 * (Re)wire the dictation runtime to the current profile's base objects. Called
 * from applyProfile after H.settings/H.modelRegistry are rebuilt — the
 * controller latches its constructor dependencies, so it is rebuilt too.
 */
export function initVoiceMode(): void {
  lastVoiceSessionId = null;
  if (stt) stt.dispose();
  stt = new STTController({
    settings: H.settings,
    registry: H.modelRegistry,
    getSessionId: () => sttSessionId,
  });
}

/** Text content of an assistant message (text blocks joined by newline), for yield-mode speak. */
function extractTextContent(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((c): c is { type?: string; text?: unknown } => typeof c === "object" && c !== null)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function pushTts(ws: Ws, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(stampEvent(payload)));
}

/**
 * Session-event side of the TTS bridge. Called from attachEntry's subscription
 * for every event of every pooled session; cheap no-ops when vocalization is
 * off or the session is not the voice session.
 */
export function handleVoiceEvent(
  ws: Ws,
  ev: { type?: string; message?: { role?: string; stopReason?: string; content?: unknown }; assistantMessageEvent?: { type?: string; delta?: string } },
  sessionId: string,
): void {
  if (ev.type === "message_start" && ev.message?.role === "user") {
    // A sent message anchors the voice session here and silences whatever is
    // still playing from the previous turn (same wiring as the TUI).
    lastVoiceSessionId = sessionId;
    pushTts(ws, { type: "tts_stop" });
    return;
  }
  if (sessionId !== lastVoiceSessionId) return;
  if (settingsGet(H.settings, "speech.enabled") !== true) return;
  const mode = settingsGet(H.settings, "speech.mode");
  if (ev.type === "message_update") {
    const delta = ev.assistantMessageEvent;
    if (delta?.type === "text_delta" && (mode === "assistant" || mode === "all")) {
      pushTts(ws, { type: "tts_delta", sessionId, text: delta.delta ?? "" });
    } else if (delta?.type === "thinking_delta" && mode === "all") {
      pushTts(ws, { type: "tts_delta", sessionId, text: delta.delta ?? "" });
    }
  } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
    if (ev.message.stopReason === "aborted") pushTts(ws, { type: "tts_stop" });
    else if (mode !== "yield") pushTts(ws, { type: "tts_flush" });
  } else if (ev.type === "turn_end" && ev.message?.role === "assistant") {
    if (ev.message.stopReason === "aborted") return; // never speak an aborted partial
    if (mode === "yield") {
      const text = extractTextContent(ev.message);
      if (text) {
        pushTts(ws, { type: "tts_delta", sessionId, text });
        pushTts(ws, { type: "tts_flush" });
      }
    } else {
      pushTts(ws, { type: "tts_flush" });
    }
  }
}

function pushSttFrame(payload: Record<string, unknown>): void {
  if (sttWs) sttWs.send(JSON.stringify(stampEvent(payload)));
}

function pushDraft(): void {
  pushSttFrame({ type: "stt_draft", sessionId: sttSessionId, text: sttAnchor + sttCommitted });
}

/** The UI-side SttTarget: draft text joins land as one normalized frame each. */
const bridgeTarget: SttTarget = {
  setVolatileText(text) {
    if (sttTest) return;
    pushSttFrame({ type: "stt_draft", sessionId: sttSessionId, text: sttAnchor + sttCommitted + text });
  },
  clearVolatileText() {
    if (sttTest) return;
    pushDraft();
  },
  commitVolatileText(text) {
    if (sttTest) {
      sttTestText += text;
      return;
    }
    sttCommitted += text;
    pushDraft();
  },
  submit() {
    if (sttTest) return;
    pushSttFrame({ type: "stt_submit", sessionId: sttSessionId });
  },
  deleteBeforeCursor(count) {
    if (sttTest) return;
    // Dictation always appends at the end, so "before cursor" is the tail of
    // anchor+committed; the cut may eat into the anchor.
    const whole = sttAnchor + sttCommitted;
    const cut = whole.slice(0, Math.max(0, whole.length - count));
    sttCommitted = cut.length > sttAnchor.length ? cut.slice(sttAnchor.length) : "";
    sttAnchor = cut.length > sttAnchor.length ? sttAnchor : cut;
    pushDraft();
  },
};

function pushState(state: SttState, message?: string) {
  pushSttFrame({ type: "stt_state", sessionId: sttSessionId, state, ...(message !== undefined ? { message } : {}) });
}

/**
 * Begin push-to-talk dictation. `anchor` is the draft text at press time; the
 * frontend receives the full target text (anchor + recognized) on every
 * partial/commit, so it only ever calls setComposerValue. Test mode (settings
 * page) reports the final text via stt_test_result after the capture ends.
 */
export async function startDictation(ws: Ws, sessionId: string, anchor: string, test = false): Promise<void> {
  if (!stt) return;
  sttWs = ws;
  sttSessionId = sessionId;
  sttAnchor = test ? "" : anchor;
  sttCommitted = "";
  sttTest = test;
  sttTestText = "";
  await stt.start(bridgeTarget, {
    showWarning: (msg) => pushState("idle", msg),
    showStatus: (msg) => pushState(stt?.state === "recording" ? "recording" : "transcribing", msg),
    onStateChange: (state) => {
      pushState(state);
      // A test capture reports its final text once the controller settles
      if (sttTest && state === "idle" && sttTestText) {
        pushSttFrame({ type: "stt_test_result", sessionId: sttSessionId, text: sttTestText });
      }
    },
  });
}

/** End push-to-talk: stop the capture and let buffered audio transcribe. */
export async function stopDictation(): Promise<void> {
  await stt?.stop();
}

/** Resolve the dictation role to the concrete model the settings page shows. */
function resolveDictationModel(): { modelId: string; key: string } | null {
  const pool = roleCandidatePool("dictation", H.settings, H.modelRegistry);
  const model = resolveRoleChain("dictation", H.settings, pool)[0]?.model;
  if (!model) return null;
  return { modelId: `${model.provider}/${model.id}`, key: resolveSttModelSpec(model.id).key };
}

/** Whether the resolved dictation model is fully present in the local cache. */
export async function isDictationModelReady(): Promise<boolean> {
  const resolved = resolveDictationModel();
  if (!resolved) return false;
  try {
    return await isSttModelCached(resolved.key);
  } catch {
    return false;
  }
}

/**
 * Voice settings snapshot (voice_status frame): the dictation role's concrete
 * model + cache readiness, plus whether a download is in flight.
 */
export async function pushVoiceStatus(ws: Ws): Promise<void> {
  const resolved = resolveDictationModel();
  let ready = false;
  if (resolved) {
    try {
      ready = await isSttModelCached(resolved.key);
    } catch {}
  }
  ws.send(
    JSON.stringify(
      stampEvent({
        type: "voice_status",
        modelId: resolved?.modelId ?? null,
        modelKey: resolved?.key ?? null,
        ready,
        downloading: sttDownloadInFlight,
      }),
    ),
  );
}

let sttDownloadInFlight = false;

/**
 * Download (or warm) the resolved dictation model, streaming progress as
 * stt_download_progress frames and a final voice_status refresh.
 */
export async function downloadDictationModel(ws: Ws): Promise<void> {
  if (sttDownloadInFlight) return;
  const resolved = resolveDictationModel();
  if (!resolved) return;
  sttDownloadInFlight = true;
  try {
    await downloadSttModel(resolved.key, (p) => {
      ws.send(JSON.stringify(stampEvent({ type: "stt_download_progress", percent: p.percent, status: p.status, label: resolved.modelId })));
    });
  } finally {
    sttDownloadInFlight = false;
  }
  await pushVoiceStatus(ws);
}
