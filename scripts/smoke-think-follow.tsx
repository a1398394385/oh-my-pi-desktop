// Smoke: streaming follow of ThinkingRow's inner .think-scroll (default-expanded via
// Ctrl+T must pin the growing thinking text to its tail).
// happy-dom has no layout, so clientHeight/scrollHeight are stubbed on the prototype
// (scrollHeight faked from the text length) and the scrollTop setter dispatches scroll
// synchronously to drive the no-fade / follow latch.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-think-follow.tsx
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

const win = new Window({ url: "https://localhost/" });
if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  location: win.location,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  HTMLElement: win.HTMLElement,
  HTMLDivElement: win.HTMLDivElement,
  Element: win.Element,
  Node: win.Node,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  MutationObserver: win.MutationObserver,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  matchMedia: ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as never,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tops = new WeakMap<object, number>();
const P = win.Element.prototype as unknown as Record<string, unknown>;
Object.defineProperty(P, "clientHeight", { get: () => 200, configurable: true });
Object.defineProperty(P, "scrollHeight", {
  get(this: { textContent: string | null }) { return Math.max(200, (this.textContent || "").length * 30); },
  configurable: true,
});
Object.defineProperty(P, "scrollTop", {
  get(this: object) { return tops.get(this) ?? 0; },
  set(this: object, v: number) {
    tops.set(this, v);
    (this as unknown as EventTarget).dispatchEvent(new win.Event("scroll"));
  },
  configurable: true,
});

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { default: ThinkingRow } = await import("../ui-src/components/chat/ThinkingRow");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

const thinkEl = () => host.querySelector(".think-scroll") as unknown as HTMLElement & { scrollTop: number; scrollHeight: number };
const para = (n: number) => "思考".repeat(n);
const render = async (thinking: string, streaming = true) => {
  await act(async () => {
    root.render(createElement(ThinkingRow, { item: { text: "思考中", thinking, streaming, expanded: true } }));
  });
};

try {
  // 1) default-expanded + streaming: pinned to the tail
  await render(para(60));
  const el = thinkEl();
  assert.ok(el, "think-scroll 未渲染");
  assert.ok(el.scrollHeight > 200, "测试前提失败：内容需要溢出内层滚动");
  assert.equal(el.scrollTop, el.scrollHeight, "流式首帧应钉在尾部");

  // 2) user scrolled up to read: later deltas must not yank the view back
  el.scrollTop = 40;
  await render(para(120));
  assert.equal(thinkEl().scrollTop, 40, "用户上滚后不应被拽回底部");

  // 3) scrolled back to the bottom: follow re-arms
  const el2 = thinkEl();
  el2.scrollTop = el2.scrollHeight;
  await render(para(180));
  assert.equal(thinkEl().scrollTop, thinkEl().scrollHeight, "滚回底部后应恢复跟随");

  // 4) stream finished (the store collapses the row at thinking_end; assert only that
  //    the follow no longer writes scrollTop)
  await render(para(240), false);
  const before = thinkEl().scrollTop;
  await render(para(300), false);
  assert.equal(thinkEl().scrollTop, before, "非流式内容不应被强制跟随");

  console.log("OK: 思考行流式跟随内层滚动（钉底 / 上滚保护 / 回底恢复 / 非流式不动）");
} finally {
  await act(async () => root.unmount());
  await win.happyDOM.close();
}
