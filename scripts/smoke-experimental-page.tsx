// Smoke: the experimental page keeps each feature's detail rows hidden until its master
// switch is on (ACP compaction / cache keep-alive) and reveals them in one expand-down
// block when the switch flips.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-experimental-page.tsx
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

const win = new Window({ url: "http://localhost/?preview=1" });
if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
Object.assign(globalThis, {
  window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator,
  location: win.location, Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
  DocumentFragment: win.DocumentFragment, Text: win.Text, Selection: win.Selection, Range: win.Range,
  HTMLFormElement: win.HTMLFormElement, HTMLInputElement: win.HTMLInputElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLButtonElement: win.HTMLButtonElement,
  FormData: win.FormData, Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class MockWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(win as unknown as Record<string, unknown>).__TAURI__ = {
  core: {
    invoke: async (cmd: string) => {
      if (cmd === "audio_devices") return [];
      if (cmd === "ws_url") return "ws://mock-host";
      return null;
    },
  },
};

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: ExperimentalPage } = await import("../ui-src/components/settings/pages/ExperimentalPage");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const baseSettings = {
  acpEnabled: false,
  acpConfig: { tierMode: "absolute", l1: 150000, l2: 250000, l3: 350000, tailTurns: 2, tailTokens: 20000, tailUserMessages: 4 },
  sessionContextEnabled: false,
  keepaliveEnabled: false,
  keepaliveConfig: {
    mode: "default", targets: [], intervalMs: 480000, maxIdleMs: 3600000, maxMissStreak: 3,
    maxErrorStreak: 3, spendCapUsd: 1, minPromptTokens: 512, maxOutputTokens: 16,
    probeDuringApproval: false, probeDuringAsk: false, readWarmups: 1,
  },
  hooksEnabled: true,
};

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

const render = async (settings: Record<string, unknown>) => {
  useAppStore.setState({ hostSettings: settings as never });
  await act(async () => root.render(createElement(ExperimentalPage)));
  // the page probes the audio device list on mount; let that promise settle inside act()
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  await act(async () => { await promise; });
};
const text = () => host.textContent ?? "";
const blocks = () => [...host.querySelectorAll(".exp-rows")];

try {
  // 1. Both switches off: no detail block at all
  await render(baseSettings);
  assert.equal(blocks().length, 0, "no detail block while both switches are off");
  assert(!text().includes("L1 档位阈值"), "ACP tier rows hidden");
  assert(!text().includes("探测节奏"), "keepalive probe rows hidden");
  assert(!text().includes("环心显示保温次数"), "keepalive ring-counter row hidden");

  // 2. ACP on: its detail block appears with the tier / tail rows
  await render({ ...baseSettings, acpEnabled: true });
  assert.equal(blocks().length, 1, "ACP detail block appears");
  assert(text().includes("L1 档位阈值") && text().includes("尾部保护区(turn)"), "ACP detail rows visible");
  assert(text().includes("尾部保护区(用户消息)"), "user-message tail row visible");
  assert(!text().includes("探测节奏"), "keepalive rows stay hidden");

  // 3. Keepalive on as well: two independent blocks
  await render({ ...baseSettings, acpEnabled: true, keepaliveEnabled: true });
  assert.equal(blocks().length, 2, "both detail blocks visible");
  assert(text().includes("探测节奏") && text().includes("保温模型"), "keepalive detail rows visible");
  assert(text().includes("环心显示保温次数"), "keepalive ring-counter row visible");

  // 4. Flipping ACP off collapses only its own block
  await render({ ...baseSettings, acpEnabled: false, keepaliveEnabled: true });
  assert.equal(blocks().length, 1, "ACP block collapses when its switch goes off");
  assert(!text().includes("L1 档位阈值"), "ACP tier rows hidden again");
  assert(text().includes("探测节奏"), "keepalive rows stay visible");

  console.log("✓ pg-experimental：ACP / 缓存保温的详情行随总开关展开收起");
} finally {
  await act(async () => root.unmount());
}
