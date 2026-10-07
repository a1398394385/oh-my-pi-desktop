// Throwaway smoke: settings dropdown exclusivity (ui-src/lib/dropdownExclusive).
// Renders the real GeneralPage (language Sel + font FontPicker + size Sel) and
// asserts that opening one dropdown collapses the previously open one.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-dropdown-exclusive.tsx
// Dynamic imports: UI modules read DOM globals at import time, so the smoke
// window and the mock WebSocket must be installed before they load (same shape
// as smoke-general-terminal-font.tsx).
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

const sent: Array<Record<string, any>> = [];
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send(data: string) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(win as unknown as Record<string, unknown>).__TAURI__ = {
  core: {
    invoke: async (cmd: string) => {
      if (cmd === "ws_url") return "ws://mock-host";
      if (cmd === "list_font_families") return ["Cascadia Code", "Consolas"];
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
const rowByTitle = (title: string) =>
  [...document.querySelectorAll(".srow")].find((r) => (r.textContent || "").includes(title))!;
const openMenus = () => [...document.querySelectorAll(".menu.open")];
// The language row's .sel is the first in the app-language card; rows in the
// terminal card are distinguished by their titles below.
const langSel = () => document.querySelector("#pg-general .set-card .sel")!;

try {
  await act(async () => { root.render(createElement(GeneralPage)); });

  // 1. language dropdown opens alone
  await click(langSel());
  assert.equal(openMenus().length, 1, "语言下拉打开");

  // 2. opening the size dropdown collapses the language menu
  await click(rowByTitle("终端字号").querySelector(".sel")!);
  assert.equal(openMenus().length, 1, "仍只有一个展开菜单");
  assert.ok(rowByTitle("终端字号").querySelector(".menu.open"), "展开的是字号菜单");

  // 3. opening the font picker collapses the size menu
  await click(rowByTitle("终端字体").querySelector(".sel")!);
  await act(async () => {}); // let the lazy font-list invoke resolve
  assert.equal(openMenus().length, 1, "字体下拉顶掉字号后仍只有一个");
  assert.ok(document.querySelector(".fm-menu.open"), "展开的是字体菜单");

  // 4. picking an option releases the slot; the next dropdown opens cleanly
  const items = [...document.querySelectorAll(".fm-list .mi")] as HTMLElement[];
  await click(items.find((mi) => mi.textContent === "Consolas")!);
  assert.equal(openMenus().length, 0, "选完后全部收起");
  await click(langSel());
  assert.equal(openMenus().length, 1, "释放后可再次打开");
  console.log("✓ 设置页下拉互斥：展开下一个自动收起上一个，选项/外点正常释放");
} finally {
  await act(async () => { root.unmount(); });
  win.happyDOM.close();
}
