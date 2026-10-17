// Throwaway smoke: the composer bottom-bar graded collapse (Composer.tsx fit()).
// Spec §4.4 / acceptance matrix 9: BAR_STAGES 5 -> 7, so narrowing the cbar must
// walk bar-1..bar-7 in order, and widening again must clear every bar-N class
// (the classList.remove list must cover bar-6/bar-7 or stale tiers survive).
// happy-dom has no layout engine (all widths are 0), so the widths fit() reads
// are scripted here: a fixed per-element width table models the pill widths at
// each collapse tier, and the cbar clientWidth is the variable under test.
// shortcut: the tier->width table mirrors composer.css by hand (happy-dom does
// not cascade descendant selectors into getComputedStyle); it validates the JS
// ladder (BAR_STAGES + remove/add coherence), not the CSS rules themselves.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-composer-bars.ts
// Static imports cannot work here: the UI modules read DOM globals (window,
// document, WebSocket, __TAURI__) at import time, so the happy-dom window and
// the mocks below must be installed before any of them loads (same shape as
// smoke-computer-permission.tsx; test-case module-loading-boundary exception).
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

// Tauri bridge present -> invoke defined -> REMOTE false (mic button renders)
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send(_data: string) {}
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(win as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: async (cmd: string) => (cmd === "ws_url" ? "ws://mock-host" : null) } };

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: Composer } = await import("../ui-src/components/Composer");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

// ---- scripted layout model (mirrors the cbar children rendered below) ----
// cbar children with ids; .sp reports 0 and is excluded by fit() itself.
const GAP = 6;
// per-tier widths: [at rest, bar-1, bar-2, bar-3, bar-6] — bar-4/5 hide buttons
// this render does not mount; bar-7 hides the element outright
const W: Record<string, number[]> = {
  plusBtn: [32],
  modeBtn: [96, 28, 28, 28, 22],
  planSep: [8],
  planBtn: [72],
  computerBtn: [32],
  ctxRing: [24],
  modelBtn: [96, 96, 96, 28, 22],
  thinkBtn: [96, 96, 28, 28, 22],
  voiceBtn: [32],
  sendBtn: [32],
};
const BAR7_HIDDEN: Record<string, true> = { planSep: true, planBtn: true, computerBtn: true, voiceBtn: true };
let cbarClientWidth = 10000;

function tierOf(el: Element): number {
  const comp = el.closest("#composer");
  if (!comp) return 0;
  for (let n = 7; n >= 1; n--) if (comp.classList.contains("bar-" + n)) return n;
  return 0;
}

Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains("sp")) return 0;
    const id = this.id;
    if (!id || !(id in W)) return 0; // unscripted elements stay 0 (excluded from fit's visible set)
    if (tierOf(this) >= 7 && BAR7_HIDDEN[id]) return 0;
    const tier = tierOf(this);
    const table = W[id];
    // table slots are [rest, bar-1, bar-2, bar-3, bar-6]: tiers 4/5 hide buttons
    // (no width change) and tier >= 6 takes the last slot; clamp short tables
    const idx = Math.min(tier >= 6 ? 4 : Math.min(tier, 3), table.length - 1);
    return table[idx];
  },
});
Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("cbar") ? cbarClientWidth : 0;
  },
});

// new-session page (s == undefined): mounts plan pill + computer button without
// needing an open session
useAppStore.setState({
  isCreatingNew: true,
  newSessionPlanMode: true,
  hostSettings: { computerEnabled: true, values: {} },
} as never);

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

const stage = () => {
  const comp = document.getElementById("composer")!;
  let max = 0;
  for (const cls of comp.classList) {
    const m = /^bar-(\d)$/.exec(cls);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
};

try {
  await act(async () => { root.render(createElement(Composer, { inWelcome: true })); });
  const comp = document.getElementById("composer")!;
  assert.ok(document.getElementById("voiceBtn"), "mic button must render for the local client");

  // width table above: need = sum(widths) + GAP * (n - 1) with n = 10 visible children
  // tier 0..7 -> 574, 506, 438, 370, 370, 370, 352, 184 (tiers 4/5 hide absent buttons)
  const cases: Array<[number, number]> = [
    [600, 0],
    [573, 1],
    [505, 2],
    [437, 3],
    [369, 6], // tiers 4/5 are no-ops here (no bg buttons) so the ladder jumps to 6
    [351, 7],
  ];
  for (const [w, expect] of cases) {
    cbarClientWidth = w;
    await act(async () => { root.render(createElement(Composer, { inWelcome: true })); });
    if (process.env.BARS_DEBUG) {
      const cbar = document.querySelector(".cbar")!;
      console.log("w=", w, "stage=", stage(), [...cbar.children].map((k) => `${(k as HTMLElement).id || k.className}:${(k as HTMLElement).offsetWidth}`).join(" "));
    }
    assert.equal(stage(), expect, `cbar clientWidth=${w} -> stage ${expect}`);
  }
  // widening again must clear every tier (remove-list covers bar-1..bar-7)
  cbarClientWidth = 10000;
  await act(async () => { root.render(createElement(Composer, { inWelcome: true })); });
  assert.equal(stage(), 0, "wide again -> all bar-N classes cleared");
  for (let n = 1; n <= 7; n++) assert.ok(!comp.classList.contains("bar-" + n), `bar-${n} cleared`);
  console.log("smoke-composer-bars: OK (matrix 9: bar-1..bar-7 ladder + clear)");
} finally {
  await act(async () => root.unmount());
}
