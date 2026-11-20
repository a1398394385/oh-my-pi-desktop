// Args body folding (ToolRow.tsx ArgsBox): a 5–10 line args payload folds to four whole lines
// with a "show all" row; ≤4 lines render whole, >10 lines keep the shipped internal scroll.
// The line count comes from measurement, so the test stubs scrollHeight from the rendered text
// (happy-dom has no layout) and asserts the branches + the toggle round-trip.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/tool-args-fold.test.ts --pool=forks --poolOptions.forks.singleFork
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { Root } from "react-dom/client";

const ROW_PX = 18;
const win = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: win, document: win.document, Node: win.Node, Element: win.Element,
  HTMLElement: win.HTMLElement, MutationObserver: win.MutationObserver,
  ResizeObserver: win.ResizeObserver,
  navigator: win.navigator, location: win.location, localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, Event: win.Event,
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).__TAURI__ = { core: { invoke: async () => null } };
// No layout in happy-dom: the box height is its own rendered line count, which is exactly what
// the real measurement reads back from scrollHeight.
Object.defineProperty(win.HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: { textContent: string | null }) { return (this.textContent || "").split("\n").length * ROW_PX; },
});

const { initI18n } = await import("../ui-src/i18n");
// The language packs load lazily (lazyPackBackend), so the await is what puts the
// Chinese strings in place — without it t() hands back the raw key.
await initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: ToolRow } = await import("../ui-src/components/chat/ToolRow");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

// A generic tool (no dedicated row) is the branch that renders the raw args body
function argsWithLines(lines: number) {
  const args: Record<string, string> = {};
  for (let i = 1; args && Object.keys(args).length < lines - 2; i++) args[`field${i}`] = `value${i}`;
  return args;
}

function mount(lines: number): { host: HTMLElement; root: Root } {
  useAppStore.setState({
    ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    openSessions: new Map(),
    activePath: "/tmp/fold.jsonl",
  });
  const item = {
    name: "custom_tool",
    args: argsWithLines(lines),
    intent: "probe",
    output: "done",
    cmdExpanded: true,
  } as never;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(ToolRow, { item })); });
  return { host, root };
}

const bodyOf = (host: HTMLElement) => host.querySelector(".cmd-card-cmd");
const toggleOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".cmd-card-foot button");

describe("args body folding", () => {
  test("four lines or fewer render whole with no toggle", () => {
    const { host, root } = mount(4);
    expect(bodyOf(host)?.className).not.toContain("folded");
    expect(toggleOf(host)).toBeNull();
    act(() => root.unmount());
  });

  test("a five-line payload folds with a left-aligned show-all toggle", () => {
    const { host, root } = mount(5);
    expect(bodyOf(host)?.className).toContain("folded");
    expect(toggleOf(host)?.textContent).toContain("展开全部");
    act(() => root.unmount());
  });

  test("the toggle expands in place and collapses back", () => {
    const { host, root } = mount(8);
    const body = bodyOf(host);
    const toggle = toggleOf(host)!;
    expect(body?.className).toContain("folded");
    expect(body?.className).not.toContain("open");
    act(() => toggle.click());
    expect(bodyOf(host)?.className).toContain("open");
    expect(toggleOf(host)?.textContent).toContain("收起");
    act(() => toggleOf(host)!.click());
    expect(bodyOf(host)?.className).not.toContain("open");
    expect(toggleOf(host)?.textContent).toContain("展开全部");
    act(() => root.unmount());
  });

  test("ten lines still fold, eleven fall back to the internal scroll", () => {
    const ten = mount(10);
    expect(bodyOf(ten.host)?.className).toContain("folded");
    act(() => ten.root.unmount());
    const eleven = mount(11);
    expect(bodyOf(eleven.host)?.className).not.toContain("folded");
    expect(toggleOf(eleven.host)).toBeNull();
    act(() => eleven.root.unmount());
  });
});
