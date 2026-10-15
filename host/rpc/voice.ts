// Voice-conversation RPCs: push-to-talk dictation control (stt_start carries
// the draft text at press time as the anchor; stt_stop ends the capture and
// lets buffered audio transcribe; test=true routes the final text to the
// settings page via stt_test_result instead of the composer draft), the model
// management pair for the settings page (voice_status snapshot + stt_download
// with live progress), all gated on the dictation switch before any model
// download begins. The TTS side has no RPC — it is wired into the
// session-event subscription (host/voice.ts handleVoiceEvent) forwarding
// tts_* frames the UI speaks through the system speechSynthesis.
import { H } from "../state.ts";
import { startDictation, stopDictation, pushVoiceStatus, downloadDictationModel } from "../voice.ts";
import { settingsGet } from "../settings-compat.ts";
import type { RpcHandler } from "./types";

export const voiceHandlers: Record<string, RpcHandler> = {
  stt_start(ws, msg) {
    // Gate on the dictation switch (the UI only sends this while voice mode is
    // lit, but the host rejects stray starts before any model download begins)
    if (settingsGet(H.settings, "stt.enabled") !== true && msg.test !== true) {
      ws.send(JSON.stringify({ type: "stt_state", sessionId: String(msg.sessionId ?? ""), state: "idle", message: "stt.enabled is off" }));
      return;
    }
    void startDictation(ws, String(msg.sessionId ?? ""), String(msg.anchor ?? ""), msg.test === true);
  },
  stt_stop(_ws) {
    void stopDictation();
  },
  voice_status(ws) {
    void pushVoiceStatus(ws);
  },
  stt_download(ws) {
    void downloadDictationModel(ws);
  },
};
