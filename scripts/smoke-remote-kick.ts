// Throwaway smoke: remote-control takeover gating (Spec §4.1 / §7 contract). Drives the real
// store with a stub WebSocket: a kicked frame or close code 4001 must set kickedByOther and
// suppress the auto-reconnect ladder — any auto retry here revives the kick-fight loop — and
// only the banner's reclaim click may reconnect.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-remote-kick.ts
// Dynamic imports: UI modules read DOM globals at import time, so the smoke window and the mock
// WebSocket must be installed before they load (same shape as smoke-computer-permission.tsx).
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";
import type { Root } from "react-dom/client";

// No __TAURI__, no ?preview → the store must evaluate to REMOTE mode against this origin
const win = new Window({ url: "http://remote-host/" });
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

// ---- mock WebSocket: every dial lands here, close() replays the store's onclose ----
const sockets: MockWebSocket[] = [];
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  onclose: null | ((ev: CloseEvent) => void) = null;
  send() {}
  constructor(public url: string) { sockets.push(this); }
  // smoke stand-in for the browser CloseEvent: the store's handler only reads ev.code
  close(code: number) { this.readyState = 3; this.onclose?.({ code } as unknown as CloseEvent); }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { REMOTE, getRemoteKey } = await import("../ui-src/store/ws");
const { default: ConnBanner } = await import("../ui-src/components/main/ConnBanner");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

assert.equal(REMOTE, true, "no __TAURI__ and no ?preview must evaluate to REMOTE mode");

// Fresh root per mount: react-dom forbids re-rendering an unmounted root, and the smoke
// unmounts before each real-time wait (the banner's per-second refresh timer would fire act()
// warnings while the store-side reconnect ladder is being observed)
let root: Root | null = null;
const renderBanner = async () => {
  await act(async () => {
    root?.unmount();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(createElement(ConnBanner));
  });
};
const unmountBanner = async () => { await act(async () => { root?.unmount(); root = null; }); };
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};

try {
  // 0. no key: no socket is dialed and the connText says why
  assert.equal(getRemoteKey(), null);
  await act(async () => { await useAppStore.getState().connect(); });
  assert.equal(sockets.length, 0, "missing key must not open a socket");
  assert.equal(useAppStore.getState().connText, "缺少访问密钥");
  await renderBanner();
  assert.ok(
    [...document.querySelectorAll("input")].length > 0,
    "key-less REMOTE must render the key-entry placeholder",
  );

  // happy path: the remote dial targets this origin's /ws with the persisted key
  win.localStorage.setItem("omp-remote-key", "testkey");
  await act(async () => { await useAppStore.getState().connect(); });
  assert.equal(sockets.length, 1, "key present: exactly one dial");
  assert.equal(sockets[0].url, "ws://remote-host/ws?t=testkey");
  const first = sockets[0];

  // 1. kicked frame sets the takeover gate
  await act(async () => { first.onmessage?.({ data: JSON.stringify({ type: "kicked" }) }); });
  assert.equal(useAppStore.getState().kickedByOther, true, "kicked frame sets kickedByOther");

  // 2. even a follow-up close with an ordinary code must NOT arm the reconnect ladder
  await act(async () => { first.close(1006); });
  await renderBanner();
  const reclaim = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("重新接管"));
  assert.ok(reclaim, "takeover banner renders the reclaim button");
  // unmount before the real-time wait: the banner's per-second refresh timer would otherwise
  // fire outside act() (the reconnect ladder is store-side and needs no mounted component)
  await unmountBanner();
  const afterKick = sockets.length;
  await sleep(3100); // first ladder rung is 100ms; 3s covers the whole spec acceptance window
  assert.equal(sockets.length, afterKick, "kicked gate must suppress reconnects for >3s (no kick-fight)");

  // 3. reclaim is the only reconnect path: click clears the gate and dials again
  await renderBanner();
  const reclaimBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("重新接管"));
  await click(reclaimBtn!);
  assert.equal(useAppStore.getState().kickedByOther, false, "reclaim clears the gate");
  assert.equal(sockets.length, afterKick + 1, "reclaim click must call connect()");
  assert.equal(sockets[afterKick].url, "ws://remote-host/ws?t=testkey");
  const second = sockets[afterKick];

  // 4. close code 4001 alone (kicked frame lost in the race, Spec §7) gates the same way
  await act(async () => { second.close(4001); });
  assert.equal(useAppStore.getState().kickedByOther, true, "close code 4001 alone sets kickedByOther");
  await unmountBanner();
  const afterCode = sockets.length;
  await sleep(400); // first ladder rung is 100ms; a scheduled retry would already have fired
  assert.equal(sockets.length, afterCode, "4001 close must suppress the first reconnect rung");

  console.log("✓ 远程接管门控：kicked 帧 / close 4001 抑制自动重连 >3s，重新接管按钮是唯一重连路径");
} finally {
  await unmountBanner();
  win.happyDOM.close();
}
