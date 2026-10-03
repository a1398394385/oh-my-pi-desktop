// StatsPage i18n smoke: mount the real StatsPage in happy-dom with zh-CN,
// stub fetch for the stats API, and assert the shell/nav/overview render
// through the language pack (no hardcoded English chrome left).
// Run: PATH=/Volumes/MacApps/Home/.bun/bin:$PATH bun run scripts/smoke-stats-page.ts
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
window.localStorage.setItem("omp-ui-settings", JSON.stringify({ lang: "zh-CN" }));
globalThis.navigator = window.navigator;
globalThis.WebSocket = class {};
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.matchMedia = (q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
globalThis.location = window.location;
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.MutationObserver = window.MutationObserver;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Document = window.Document;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Text = window.Text;
globalThis.Range = window.Range;

// Stats API stubs: empty-but-shaped payloads so routes render their empty states.
const emptyJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/stats/overview")) {
    return emptyJson({
      overall: {
        totalRequests: 0, successfulRequests: 0, failedRequests: 0, errorRate: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
        cacheRate: 0, cacheSavings: 0, totalCost: 0, unpricedRequests: 0, totalPremiumRequests: 0,
        avgDuration: null, avgTtft: null, avgTokensPerSecond: null,
      },
      byAgentType: [],
      timeSeries: [],
    });
  }
  if (url.includes("/api/stats/recent")) return emptyJson([]);
  return emptyJson({});
}) as typeof fetch;

// Minimal EventSource stub: opens immediately and pushes one idle live status
// so the LiveChip renders its connected state.
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(_url: string) {
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({
          version: 1,
          sync: { phase: "idle", current: 0, total: 0, processed: 0, lastSyncedAt: null, error: null },
          indexingHours: 0,
        }),
      });
    }, 0);
  }
  close() {}
}
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

document.body.innerHTML = '<div id="host"></div>';

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../ui-src/store");
// Seed a fake WS so api.getApiBase() resolves and LiveProvider opens its
// EventSource (chip renders the connected "Live" state).
useAppStore.setState({
  ws: { url: "ws://localhost", readyState: 1, send() {}, close() {} } as unknown as WebSocket,
});
const { default: StatsPage } = await import("../ui-src/components/settings/pages/StatsPage");

const root = createRoot(document.getElementById("host")!);
root.render(React.createElement(StatsPage));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

const text = document.body.textContent ?? "";
let failures = 0;
const expectContains = (label: string, needle: string) => {
  const ok = text.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: "${needle}"`);
};

// Page title via settingsPage.nav.stats
expectContains("page title", "使用统计");
// Nav sections via the pack (zh)
expectContains("nav overview", "概览");
expectContains("nav models", "模型");
expectContains("nav costs", "费用");
expectContains("nav requests", "请求");
expectContains("nav errors", "错误");
expectContains("nav traces", "追踪");
expectContains("nav tools", "工具");
expectContains("nav projects", "项目");
expectContains("nav providers", "服务商");
expectContains("nav frustration", "挫败");
expectContains("nav gain", "收益");
// Live chip initial state when connected and idle (zh label of the "Live" key)
expectContains("live chip", "实时");
// Overview route page title from the pack
expectContains("overview title", "活动汇总");
// Empty-state copy from the pack (range "7d" window label interpolated)
expectContains("overview empty", "过去 7 天");

// Hardcoded-English regression sentinels: chrome strings that used to be literals.
const leftovers = ["Nothing here yet", "Stats Sections", "Time range", "No data in this range", "Load latest"];
for (const s of leftovers) {
  if (text.includes(s)) {
    failures += 1;
    console.log(`FAIL leftover English literal in DOM: "${s}"`);
  }
}

root.unmount();
if (failures > 0) {
  console.error(`smoke-stats-page: ${failures} failure(s)`);
  process.exit(1);
}
console.log("smoke-stats-page: all checks passed");
process.exit(0);
