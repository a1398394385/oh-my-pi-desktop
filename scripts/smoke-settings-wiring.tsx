// Throwaway smoke: desktop-wired host settings — LoopGroup summary gating
// (display.showTokenUsage / display.showTurnTime) and the colorBlindMode root
// attribute. Function-level: both targets are pure (render-time store reads /
// DOM attribute write), no component tree needed.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-settings-wiring.tsx
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

const win = new Window({ url: "http://localhost/?preview=1" });
if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  localStorage: win.localStorage, navigator: win.navigator, location: win.location,
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { loopSummaryText } = await import("../ui-src/components/chat/LoopGroup");
const { applyColorBlindMode } = await import("../ui-src/appearance");

const setValues = (values: Record<string, unknown>) =>
  useAppStore.setState((s) => ({ hostSettings: { ...(s.hostSettings ?? {}), values } as never }));

try {
  const item = { role: "loop", collapsed: true, items: [], durationSec: 37, usage: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 0 } } as never;

  // 1. turn time is unconditional (display.showTurnTime hidden — desktop made it always-on)
  setValues({});
  const base = loopSummaryText(item);
  assert.ok(base.includes("已工作") && !base.includes("总消耗"), "默认仅耗时（常显）: " + base);

  // 2. showTokenUsage adds the usage segment on top
  setValues({ "display.showTokenUsage": true });
  const withUsage = loopSummaryText(item);
  assert.ok(withUsage.includes("总消耗") && withUsage.includes("input 1.2K") && withUsage.includes("已工作"), "耗时+用量: " + withUsage);

  // 3. colorBlindMode root attribute
  applyColorBlindMode(true);
  assert.equal(document.documentElement.dataset.colorblind, "on", "开启挂 data-colorblind");
  applyColorBlindMode(false);
  assert.equal(document.documentElement.dataset.colorblind, undefined, "关闭移除 data-colorblind");
  applyColorBlindMode(undefined);
  assert.equal(document.documentElement.dataset.colorblind, undefined, "未设置不挂属性");

  console.log("✓ 设置对接：Loop 摘要（耗时常显 + 用量门控）与色盲模式根属性正确");
} finally {
  win.happyDOM.close();
  process.exit(0); // imported store modules keep timers alive; assertions are done
}
