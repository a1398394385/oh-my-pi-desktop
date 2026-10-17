// Throwaway smoke: narrow single-page navigation (ZCode remote model) + REMOTE settings
// hiding (remote-control spec §4.2/§4.3, acceptance matrix #8). Renders the real App against
// a controllable matchMedia stub: ≤768px shows the session list first, the chat and the
// right panel replace it as full pages (header back/panel buttons), and widening restores
// the three-column shell.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-remote-layout.ts
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");

const win = new Window({ url: "http://192.168.1.10:16800/" });

// Controllable matchMedia: the (max-width: 768px) query starts narrow; other queries
// (shell.ts prefers-color-scheme) inert. Listeners are captured so the smoke can flip
// the breakpoint the way a real viewport resize would.
const mqlListeners = new Map<string, Array<() => void>>();
const mqlMatches = new Map<string, boolean>([["(max-width: 768px)", true]]);
const matchMedia = (query: string): MediaQueryList => {
  const listeners = mqlListeners.get(query) ?? [];
  mqlListeners.set(query, listeners);
  return {
    get matches() { return mqlMatches.get(query) ?? false; },
    media: query,
    onchange: null,
    addListener() {}, removeListener() {},
    addEventListener(_t: string, cb: () => void) { listeners.push(cb); },
    removeEventListener() {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
};
Object.assign(globalThis, {
  window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator,
  location: win.location, Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
  DocumentFragment: win.DocumentFragment, Text: win.Text, Selection: win.Selection, Range: win.Range,
  CustomEvent: win.CustomEvent, Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  // chat parts.tsx observes ellipsis containers at module load
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  matchMedia,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
});
(win as unknown as Record<string, unknown>).matchMedia = matchMedia;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: App } = await import("../ui-src/App");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => { root.render(createElement(App)); });

const $ = (id: string) => document.getElementById(id);
const headerBtn = (title: string) => document.querySelector(`.chat-head button[title="${title}"]`);
const click = async (el: Element | null) => {
  assert.ok(el, "click target must exist");
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};

try {
  // ── 1. narrow default (remote client): the session list owns the viewport ──
  assert.equal(useAppStore.getState().narrow, true, "narrow should be true at ≤768px");
  assert.ok($("sidebar"), "session list renders first in narrow mode");
  assert.ok(!$("main"), "chat must not render while the list is shown");
  assert.ok(!$("right"), "right panel must not render outside its drawer");
  assert.ok(!$("mobile-tabs"), "no persistent bottom tab bar (ZCode remote model)");
  assert.ok(!$("left-resizer"), "left resizer does not render in narrow mode");
  assert.ok(!$("right-resizer"), "right resizer does not render in narrow mode");

  // ── 2. REMOTE: no settings surface mounted (spec §4.2) ──
  assert.ok(!$("settings"), "remote client must not mount <Settings/>");

  // ── 3. chat page: only the chat renders; the header back button returns to the list ──
  await act(async () => useAppStore.getState().setMobileCol("main"));
  assert.ok($("main"), "chat renders after leaving the list");
  assert.ok(!$("sidebar"), "list gives way to the chat page");
  await click(headerBtn("会话列表"));
  assert.ok($("sidebar"), "back button returns to the session list");
  assert.ok(!$("main"), "chat unmounts after going back");

  // ── 4. right panel is a full page (no floating drawer): panel button swaps the page ──
  await act(async () => useAppStore.getState().setMobileCol("main"));
  await click($("panelToggle"));
  assert.ok($("right"), "panel button shows the right panel page");
  assert.ok(!$("main"), "chat gives way to the panel page");
  assert.ok(!$("mobile-drawer"), "no floating drawer wrapper exists");
  await click(document.querySelector('#right .sp-head button[title="会话"]'));
  assert.ok($("main"), "panel back button returns to the chat page");
  assert.ok(!$("right"), "panel page unmounts after going back");

  // ── 5. no horizontal-scroll signal (happy-dom has no layout engine: structural check) ──
  assert.ok(document.documentElement.scrollWidth <= win.innerWidth, "no horizontal overflow signal");

  // ── 6. widen past the breakpoint: three-column shell restored ──
  mqlMatches.set("(max-width: 768px)", false);
  await act(async () => {
    for (const cb of mqlListeners.get("(max-width: 768px)") ?? []) cb();
  });
  assert.equal(useAppStore.getState().narrow, false, "narrow clears when the viewport widens");
  assert.ok($("sidebar") && $("main") && $("right"), "wide mode renders all three columns");
  assert.equal(($("left-resizer") as HTMLElement | null)?.hidden, false, "left resizer visible in wide mode");
  // right panel defaults to collapsed (ui slice) — the resizer follows that, as on desktop
  assert.equal(($("right-resizer") as HTMLElement | null)?.hidden, useAppStore.getState().rightCollapsed,
    "right resizer hidden state matches rightCollapsed, same as desktop");

  console.log("smoke-remote-layout: all assertions passed");
} finally {
  await act(async () => root.unmount());
  await win.happyDOM.abort();
}
// happy-dom leaves residual handles in this full-App smoke: exit explicitly (precedent: smoke-ask-approval.ts)
process.exit(0);
