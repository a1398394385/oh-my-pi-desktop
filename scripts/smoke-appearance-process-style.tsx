// Throwaway smoke: the appearance page's "agent process display style" row.
// Mounts the real AppearancePage, clicks each pill, and asserts the store +
// outbound set_ui_prefs frame follow; also asserts the replaced base switch
// (display.hideToolActivity) no longer renders anywhere on the page.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-appearance-process-style.tsx
// Dynamic imports: UI modules read DOM globals at import time, so the smoke
// window and the mock WebSocket must be installed before they load.
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

const sent: Array<Record<string, unknown>> = [];
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send(data: string) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(win as unknown as Record<string, unknown>).__TAURI__ = {
  core: { invoke: async (cmd: string) => (cmd === "ws_url" ? "ws://mock-host" : null) },
};

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: AppearancePage } = await import("../ui-src/components/settings/pages/AppearancePage");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

await useAppStore.getState().connect();
// Minimal schema: the appearance/Display group must still render its surviving keys.
// ui.label/description fill the English pack's gap for showTokenUsage.
useAppStore.setState({
  settingsSchema: {
    "display.hideToolActivity": { id: "display.hideToolActivity", type: "boolean", ui: { tab: "appearance", group: "Display", label: "Hide tool activity" } },
    "display.showTokenUsage": { id: "display.showTokenUsage", type: "boolean", ui: { tab: "appearance", group: "Display", label: "Show token usage" } },
  } as never,
  hostSettings: { values: { "display.hideToolActivity": false, "display.showTokenUsage": true } } as never,
  uiPrefs: { ...useAppStore.getState().uiPrefs, lang: "zh-CN" },
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
const prefsFrames = () => sent.filter((m) => m.type === "set_ui_prefs");
const rowByTitle = (title: string) =>
  [...document.querySelectorAll(".srow")].find((r) => (r.textContent || "").includes(title));

try {
  await act(async () => { root.render(createElement(AppearancePage)); });

  const row = rowByTitle("Agent 处理过程显示风格");
  assert.ok(row, "处理过程显示风格行渲染");
  const pills = [...row.querySelectorAll(".mcp-type-pill")];
  assert.deepEqual(pills.map((p) => p.textContent), ["标准", "详细", "完全展开"], "三档标签");
  assert.ok(pills[0].className.includes("on"), "默认选中标准");
  assert.equal(useAppStore.getState().uiPrefs.agentProcessStyle, "standard", "默认档位 standard");

  await click(pills[2]);
  assert.equal(useAppStore.getState().uiPrefs.agentProcessStyle, "expanded", "点击后 store 为 expanded");
  const last = prefsFrames().at(-1) as { prefs?: Record<string, unknown> } | undefined;
  assert.equal(last?.prefs?.agentProcessStyle, "expanded", "set_ui_prefs 帧携带 agentProcessStyle");
  assert.ok(pills[2].className.includes("on") && !pills[0].className.includes("on"), "选中态跟随点击");

  await click(pills[1]);
  assert.equal(useAppStore.getState().uiPrefs.agentProcessStyle, "detailed", "切回详细");

  // the replaced base switch is gone everywhere, its group sibling survives
  assert.ok(!rowByTitle("隐藏工具活动"), "底座隐藏工具活动行已移除");
  assert.ok(rowByTitle("显示 Token 用量"), "同组其他设置仍渲染");

  console.log("✓ 外观页三档显示风格：渲染/切换/set_ui_prefs 全链路正确，底座开关已下线");
} finally {
  await act(async () => { root.unmount(); });
  win.happyDOM.close();
}
