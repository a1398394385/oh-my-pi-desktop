// Throwaway smoke: terminal font picker + size selector on the general settings
// page (GeneralPage.tsx). Mocks the Tauri `list_font_families` command, renders
// the real page, then walks the open / filter / preview / pick paths and asserts
// the outbound set_ui_prefs frames carry terminalFont / terminalFontSize.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-general-terminal-font.tsx
// Dynamic imports: UI modules read DOM globals at import time, so the smoke
// window and the mock WebSocket must be installed before they load (same shape
// as smoke-shell-page.tsx).
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

const win = new Window({ url: "http://localhost/?preview=1" });
if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
Object.assign(globalThis, {
  window: win, document: win.document, Node: win.Node, Element: win.Element,
  HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLFormElement: win.HTMLFormElement, FormData: win.FormData,
  MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
  navigator: win.navigator, location: win.location, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, Event: win.Event, CustomEvent: win.CustomEvent,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---- mock WebSocket: capture every frame the UI sends ----
const sent: Array<Record<string, any>> = [];
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send(data: string) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

// ---- mock Tauri invoke: list_font_families returns a fixed trio ----
(win as unknown as Record<string, unknown>).__TAURI__ = {
  core: {
    invoke: async (cmd: string) => {
      if (cmd === "ws_url") return "ws://mock-host";
      if (cmd === "list_font_families") return ["Cascadia Code", "Consolas", "SimSun"];
      return null;
    },
  },
};

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: GeneralPage } = await import("../ui-src/components/settings/pages/GeneralPage");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

await useAppStore.getState().connect();

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
// Controlled-input typing: the prototype value setter + tracker reset (see
// scripts/smoke-shell-page.tsx for the rationale; plain .value assignment never
// fires React's onChange in happy-dom).
const type = async (el: HTMLInputElement, text: string) => {
  const proto = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")!;
  await act(async () => {
    (el as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue("");
    proto.set!.call(el, text);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const prefsFrames = () => sent.filter((m) => m.type === "set_ui_prefs");
const rowByTitle = (title: string) =>
  [...document.querySelectorAll(".srow")].find((r) => (r.textContent || "").includes(title))!;

try {
  await act(async () => { root.render(createElement(GeneralPage)); });
  const fontRow = rowByTitle("终端字体");
  assert.ok(fontRow, "终端字体行渲染");

  // 1. open the picker: default entry + three mocked families, each previewing itself
  await click(fontRow.querySelector(".sel")!);
  let items = [...document.querySelectorAll(".fm-list .mi")] as HTMLElement[];
  assert.equal(items.length, 4, "默认项 + 3 个字体项，实际 " + items.length);
  const cas = items.find((mi) => mi.textContent === "Cascadia Code")!;
  assert.ok(cas.style.fontFamily.includes('"Cascadia Code"'), "字体项用自身家族预览");

  // 2. filter narrows to substring matches (default entry hides while filtering)
  await type(document.querySelector(".fm-filter") as HTMLInputElement, "cons");
  items = [...document.querySelectorAll(".fm-list .mi")] as HTMLElement[];
  assert.equal(items.length, 1, "过滤后仅 Consolas，实际 " + items.length);
  assert.equal(items[0].textContent, "Consolas");

  // 3. pick saves terminalFont through set_ui_prefs
  await click(items[0]);
  assert.equal(useAppStore.getState().uiPrefs.terminalFont, "Consolas");
  assert.equal(prefsFrames().at(-1)?.prefs?.terminalFont, "Consolas", "set_ui_prefs 帧携带 terminalFont");

  // 4. size selector: 10-20 px, pick 15 persists terminalFontSize
  const sizeRow = rowByTitle("终端字号");
  assert.ok(sizeRow, "终端字号行渲染");
  await click(sizeRow.querySelector(".sel")!);
  const sizeItems = [...sizeRow.querySelectorAll(".menu .mi")] as HTMLElement[];
  assert.equal(sizeItems.length, 11, "11 档字号，实际 " + sizeItems.length);
  await click(sizeItems.find((mi) => mi.textContent === "15 px")!);
  assert.equal(useAppStore.getState().uiPrefs.terminalFontSize, 15);
  assert.equal(prefsFrames().at(-1)?.prefs?.terminalFontSize, 15, "set_ui_prefs 帧携带 terminalFontSize");

  // 5. reset to the default stack via the picker's default entry
  await click(rowByTitle("终端字体").querySelector(".sel")!);
  await click([...document.querySelectorAll(".fm-list .mi")][0]);
  assert.equal(useAppStore.getState().uiPrefs.terminalFont, "");
  assert.equal(prefsFrames().at(-1)?.prefs?.terminalFont, "");

  console.log("✓ 常规页终端字体下拉/字号选择全链路正确（invoke mock）");
} finally {
  await act(async () => { root.unmount(); });
  win.happyDOM.close();
}
