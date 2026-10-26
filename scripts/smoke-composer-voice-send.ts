// Smoke: the send button's push-to-talk split (voice input = dictation switch on +
// cached STT model). Everything here depends on a state the browser channel cannot
// reach without downloading the whisper model, so the store is primed directly:
//   - voice ready + empty draft + hover -> the icon swaps to the mic
//   - a long press starts dictation and the release stops it WITHOUT sending/stopping
//   - a short press keeps the plain send / abort form
//   - text in the draft keeps the arrow icon on hover but still allows the long press
// Frames are asserted through a mock socket on the store (Composer alone never connects).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-composer-voice-send.ts
// Static imports cannot work here: the UI modules read DOM globals at import time
// (same shape as smoke-composer-bars.ts).
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

const win = new Window({ url: "http://localhost/" });
if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
Object.assign(globalThis, {
  window: win, document: win.document, Node: win.Node, Element: win.Element,
  HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement,
  HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLFormElement: win.HTMLFormElement, FormData: win.FormData,
  MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
  navigator: win.navigator, location: win.location, localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, Event: win.Event, CustomEvent: win.CustomEvent,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Tauri bridge present -> invoke defined -> REMOTE false (the local desktop channel)
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send(_data: string) {}
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
const win2 = win as unknown as Record<string, unknown>;
win2.__TAURI__ = { core: { invoke: async (cmd: string) => (cmd === "ws_url" ? "ws://mock-host" : null) } };

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: Composer } = await import("../ui-src/components/Composer");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const frames: Array<Record<string, unknown>> = [];
const PTT_WAIT = 260; // > PTT_DELAY_MS (180)

// Voice input available: dictation switch on + the local STT model cached
useAppStore.setState({
  ws: { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)) } as never,
  hostSettings: { values: { "stt.enabled": true } } as never,
  voiceStatus: { modelId: "test/model", modelKey: "test", ready: true, downloading: false } as never,
});

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);

const sendBtn = () => document.getElementById("sendBtn") as HTMLButtonElement;
const iconOf = () => (sendBtn().querySelector("svg")?.innerHTML.includes("M12 19v3") ? "mic" : "arrow");
// MouseEvent (not Event): React's pointer handlers read `button`, which a bare Event lacks
const fire = async (type: string, target: Element = sendBtn()) => {
  await act(async () => {
    target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, button: 0, cancelable: true }) as never);
  });
};
const waitFor = async (pred: () => boolean, ms = 1500) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
};
const press = async (holdMs: number, duringHold?: () => Promise<void>) => {
  await fire("pointerover"); // React synthesizes onPointerEnter from pointerover
  await fire("pointerdown");
  await new Promise((r) => setTimeout(r, holdMs));
  if (duringHold) await duringHold();
  await fire("pointerup");
  await fire("click"); // a real button fires click after pointerup; a long press must swallow it
};
const types = (from: number) => frames.slice(from).map((f) => f.type);

try {
  await act(async () => { root.render(createElement(Composer, { inWelcome: true })); });
  // No session in welcome: stop-form cases prime one below
  await act(async () => { useAppStore.setState({ ws: useAppStore.getState().ws }); });

  // 1. empty draft + hover -> mic icon and the hold hint
  await fire("pointerover");
  assert.equal(iconOf(), "mic", "hover on an empty draft swaps the icon to the mic");
  assert.ok(sendBtn().title.includes("按住说话"), `hold hint while the mic is shown, got "${sendBtn().title}"`);

  // 2. long press -> dictation only (no send, no stop)
  let mark = frames.length;
  await press(PTT_WAIT);
  assert.deepEqual(types(mark), ["stt_start", "stt_stop"], "long press = stt_start then stt_stop, nothing else");
  assert.equal(frames[mark].sessionId, "", "welcome press anchors on an empty session id");

  // 3. short press -> the plain send form (no prompt without a session, but never dictation)
  mark = frames.length;
  await press(20);
  assert.ok(!types(mark).includes("stt_start"), "short press must not start dictation");

  // 4. draft text: hover keeps the arrow, the long press still dictates
  await act(async () => { useAppStore.getState().setComposerValue("hello there"); });
  await fire("pointerover");
  assert.equal(iconOf(), "arrow", "text in the draft keeps the send arrow on hover");
  mark = frames.length;
  await press(PTT_WAIT);
  assert.deepEqual(types(mark), ["stt_start", "stt_stop"], "long press dictates with a draft too");

  // 5. stop form (streaming, empty draft): short press aborts, long press only dictates
  await act(async () => {
    useAppStore.getState().setComposerValue("");
    useAppStore.setState({
      activePath: "/tmp/session",
      openSessions: new Map([["/tmp/session", { sessionId: "s1", streaming: true, items: [], isSubagent: false }]]) as never,
    });
  });
  // the draft clear lands through Lexical; the stop form only exists once it is empty
  assert.ok(await waitFor(() => sendBtn().classList.contains("stop")), "stop form after the draft clear");
  mark = frames.length;
  await press(PTT_WAIT, async () => {
    // the mock socket never answers stt_start; stand in for the host's stt_state
    await act(async () => { useAppStore.setState({ voiceStt: { state: "recording" } }); });
    assert.equal(iconOf(), "mic", "the stop form shows the mic while dictating");
    assert.ok(sendBtn().classList.contains("rec"), "the capture marks the button .rec (pulse)");
    await act(async () => { useAppStore.setState({ voiceStt: null }); });
  });
  assert.deepEqual(types(mark), ["stt_start", "stt_stop"], "long press in the stop form must not abort");
  mark = frames.length;
  await press(20);
  assert.deepEqual(types(mark), ["abort_session"], "short press in the stop form aborts generation");

  console.log("smoke-composer-voice-send: OK (mic swap + short/long press in send and stop forms)");
} finally {
  await act(async () => root.unmount());
}
