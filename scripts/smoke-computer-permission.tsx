// Throwaway smoke: the Screen Recording permission row on the computer-control
// settings page (ComputerPage.tsx). macOS reports the non-prompting TCC
// preflight label inside the list_displays reply; when it is "denied" the page
// must offer the System Settings shortcut on the right of its own row, and the
// click must ride the open_screen_recording_settings RPC. Granted / unavailable
// labels must leave the row out entirely.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-computer-permission.tsx
// Dynamic imports: UI modules read DOM globals at import time, so the smoke
// window and the mock WebSocket must be installed before they load (same shape
// as smoke-general-terminal-font.tsx).
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

// Mac UA: ComputerPage gates the row on IS_MAC (ui-src/platform.ts)
const win = new Window({
  url: "http://localhost/?preview=1",
  settings: { navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" } },
});
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

// ---- mock WebSocket: capture every frame the UI sends ----
const sent: Array<Record<string, any>> = [];
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send(data: string) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(win as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: async (cmd: string) => (cmd === "ws_url" ? "ws://mock-host" : null) } };

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: ComputerPage } = await import("../ui-src/components/settings/pages/ComputerPage");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

await useAppStore.getState().connect();

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
const setDisplays = async (capturePermission: string) => {
  await act(async () => {
    useAppStore.setState({
      computerDisplays: { type: "displays", displays: [], error: null, capturePermission } as never,
    });
  });
};
const render = async () => { await act(async () => { root.render(createElement(ComputerPage)); }); };
const permRow = () =>
  [...document.querySelectorAll(".srow")].find((r) => (r.textContent || "").includes("屏幕录制权限"));

try {
  // 1. denied (the reported case): row + shortcut button on the right
  await setDisplays("denied");
  await render();
  const deniedRow = permRow();
  assert.ok(deniedRow, "权限不足时渲染屏幕录制权限行");
  const btn = deniedRow!.querySelector("button.save-btn") as HTMLElement | null;
  assert.ok(btn, "行右侧渲染申请权限按钮");
  assert.equal(btn!.textContent, "申请权限");
  assert.ok(deniedRow!.querySelector(".srow-tx")!.compareDocumentPosition(btn!) & 4, "按钮位于文案右侧");

  // 2. click rides the RPC (host opens the System Settings pane)
  await click(btn!);
  assert.deepEqual(sent.at(-1), { type: "open_screen_recording_settings" }, "点击发出 open_screen_recording_settings，实际 " + JSON.stringify(sent.at(-1)));

  // 3. granted: no permission row at all
  await setDisplays("granted");
  await render();
  assert.equal(permRow(), undefined, "已授权时不渲染权限行");

  // 4. unavailable (non-TCC backends / enumeration failure): also silent
  await setDisplays("unavailable");
  await render();
  assert.equal(permRow(), undefined, "unavailable 时不渲染权限行");

  console.log("✓ 屏幕录制权限行：denied 显示申请权限按钮并发出 RPC，granted/unavailable 不显示");
} finally {
  await act(async () => { root.unmount(); });
  win.happyDOM.close();
}
