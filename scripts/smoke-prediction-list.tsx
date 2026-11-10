// Composer prediction alternatives list (ui-src/components/composer/PredictionList.tsx): renders
// every candidate, ↑↓ moves the highlight, Enter replaces the draft through onPick and closes the
// list. The real host path (ghost + first Tab) is exercised against a live model elsewhere; this
// smoke pins the list's own state machine, which no model run can force to have 4 candidates.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-prediction-list.tsx
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");

const win = new Window({ url: "http://localhost/?preview=1" });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  localStorage: win.localStorage,
  navigator: win.navigator,
  location: win.location,
  Node: win.Node,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  DocumentFragment: win.DocumentFragment,
  Text: win.Text,
  Event: win.Event,
  KeyboardEvent: win.KeyboardEvent,
  MouseEvent: win.MouseEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: clearTimeout,
});
(win as unknown as Record<string, unknown>).matchMedia = (globalThis as Record<string, unknown>).matchMedia;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { default: PredictionList } = await import("../ui-src/components/composer/PredictionList");

const path = "/tmp/prediction-smoke.jsonl";
useAppStore.setState((st) => ({
  openSessions: new Map(st.openSessions).set(path, {
    sessionId: "pred-smoke",
    items: [],
    prediction: ["run the tests", "ship it", "ask for review"],
    predictionOpen: true,
  } as never),
  activePath: path,
}));

const picked: string[] = [];
const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => {
  root.render(
    createElement(PredictionList, {
      composerRef: { current: null },
      draftKey: "prediction-smoke",
      onPick: (text: string) => picked.push(text),
    }),
  );
});

const rows = () => Array.from(document.querySelectorAll(".palette-list .mi-tx")).map((e) => e.textContent);
assert.deepEqual(rows(), ["run the tests", "ship it", "ask for review"], "every candidate renders");

const key = (k: string) => document.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));
await act(async () => {
  key("ArrowDown");
});
assert.equal((document.querySelector(".mi.on .mi-tx") as HTMLElement | null)?.textContent, "ship it", "ArrowDown moves the highlight");

await act(async () => {
  key("Enter");
});
assert.deepEqual(picked, ["ship it"], "Enter picks the highlighted candidate");
assert.equal(useAppStore.getState().openSessions.get(path)?.predictionOpen, false, "picking closes the list");

await act(async () => {
  useAppStore.setState((st) => {
    const s = st.openSessions.get(path)!;
    return { openSessions: new Map(st.openSessions).set(path, { ...s, predictionOpen: true }) };
  });
});
await act(async () => {
  key("Escape");
});
assert.equal(useAppStore.getState().openSessions.get(path)?.predictionOpen, false, "Escape closes the list");

await act(async () => root.unmount());
console.log("✓ prediction list smoke: 3 rows, ↑↓ move, Enter picks, Esc closes");
