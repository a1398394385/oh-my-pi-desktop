// Streaming-tail markdown rendering smoke: mount the real AssistantMsg (MdSurface/streamdown)
// with a draft growing at the production 100ms flush cadence and assert
// (1) markdown renders DURING streaming, (2) no React setState-loop warnings,
// (3) per-frame render work stays bounded as the draft grows (~21KB total).
// Guards BUG-007 round 3 (full-text markdown re-parse per frame was O(n^2) and froze the app;
// the old plain-text tail was the fix, streamdown's per-block memo is what makes the
// markdown tail safe). Run: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-stream-md.ts
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
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;

document.body.innerHTML = '<div id="host"></div>';

// Dynamic imports on purpose: the i18n/AssistantMsg module chain touches window/document at
// module top level, so the happy-dom globals above must be installed BEFORE evaluation.
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const AssistantMsg = (await import("../ui-src/components/chat/AssistantMsg")).default;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const root = createRoot(document.getElementById("host")!);

// Capture React warnings (the shiki code plugin's highlight effect can nested-update-loop under
// sub-16ms render pacing; at the production 100ms cadence it must not fire at all)
const errMsgs: string[] = [];
console.error = (...args: unknown[]) => {
  errMsgs.push(args.map((a) => String(a)).join(" ").slice(0, 300));
};

// A realistic long reply chunk: headings, lists, inline styles, code fences, tables, quotes.
const CHUNK = [
  "## 分析结果\n\n",
  "这是一段说明文字，包含 **加粗**、`inline(code)` 与自动链接 https://example.com/path。\n\n",
  "- 要点一：列表项内容\n",
  "- 要点二：更多内容\n",
  "1. 有序项\n\n",
  "```ts\nexport function answer(): number {\n  return 42; // compute\n}\n```\n\n",
  "| col | val |\n| --- | --- |\n| a | 1 |\n\n",
  "> 引用块内容\n\n",
].join("");

const INTERVAL = 100; // the store's real streaming flush window (applyDelta)
const N = 150; // 150 chunks x ~140B ~= 21KB final draft

// Warmup: shiki WASM + theme + first highlight land here, not in the measured window
root.render(React.createElement(AssistantMsg, { text: CHUNK, streaming: true }));
await sleep(1500);
errMsgs.length = 0;

let draft = "";
const frameWork: number[] = [];
for (let i = 0; i < N; i++) {
  draft += CHUNK;
  const t0 = performance.now();
  root.render(React.createElement(AssistantMsg, { text: draft, streaming: true }));
  await sleep(INTERVAL); // let the scheduler flush (render itself is async)
  frameWork.push(performance.now() - t0 - INTERVAL); // strip the sleep: pure render work
}

await sleep(100);

// ---- 1) markdown renders during streaming (not deferred to turn end) ----
const h2 = document.querySelector("#host h2");
const li = document.querySelector("#host li");
const pre = document.querySelector("#host pre");
const tail = document.querySelector("#host .streaming-draft");
const ok1 = !!h2 && !!li && !!pre && !!tail;
console.log(`[1] streaming markdown: h2=${!!h2} li=${!!li} pre=${!!pre} tail=${!!tail}`);

// ---- 2) no setState-loop warnings at production cadence ----
const ok2 = errMsgs.length === 0;
console.log(`[2] react warnings: ${errMsgs.length}x${ok2 ? "" : " first: " + (errMsgs[0] ?? "")}`);

// ---- 3) per-frame render work stays bounded (no O(n^2) re-parse) ----
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const maxWork = Math.max(...frameWork);
const medWork = median(frameWork);
const ok3 = medWork < 50 && maxWork < 200;
console.log(`[3] frame work ms: median=${medWork.toFixed(1)} max=${maxWork.toFixed(1)} (draft ${draft.length}B)`);

if (ok1 && ok2 && ok3) {
  console.log("PASS");
  process.exit(0);
}
console.log(`FAIL ok1=${ok1} ok2=${ok2} ok3=${ok3}`);
process.exit(1);
