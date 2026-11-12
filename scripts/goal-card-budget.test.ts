// Goal bar state marker: a `budget-limited` goal keeps `enabled` (base flips only
// `goal.status`), so the pause/resume branch alone cannot tell it from a running
// goal. The card must show the budget stall, and must never read as "paused".
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/goal-card-budget.test.ts --pool=forks --poolOptions.forks.singleFork
// UI modules read DOM globals at import time, so the happy-dom window must be
// installed before any of them loads (same shape as smoke-composer-bars.ts).
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { Root } from "react-dom/client";

const win = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: win, document: win.document, Node: win.Node, Element: win.Element,
  HTMLElement: win.HTMLElement, MutationObserver: win.MutationObserver,
  ResizeObserver: win.ResizeObserver,
  navigator: win.navigator, location: win.location, localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, Event: win.Event,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).__TAURI__ = { core: { invoke: async () => null } };

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: GoalCard } = await import("../ui-src/components/composer/GoalCard");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const sent: string[] = [];

function mount(goal: Record<string, unknown>): { host: HTMLElement; root: Root } {
  sent.length = 0;
  const session = { sessionId: "g1", items: [], goal } as never;
  useAppStore.setState({
    ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    send: (obj: { text?: string }) => { if (obj.text) sent.push(obj.text); },
    diskProjects: [],
    openSessions: new Map([["/tmp/g1.jsonl", session]]),
    activePath: "/tmp/g1.jsonl",
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(GoalCard)); });
  return { host, root };
}

const goal = (extra: Record<string, unknown> = {}) => ({
  objective: "ship the audit fix",
  status: "active",
  enabled: true,
  tokenBudget: 100000,
  tokensUsed: 120000,
  timeUsedSeconds: 65,
  costUsed: 0.5,
  ...extra,
});

describe("GoalCard budget stall", () => {
  test("a budget-limited goal shows the stall marker", () => {
    const { host, root } = mount(goal({ status: "budget-limited" }));
    expect(host.textContent).toContain("预算耗尽");
    // the unblock command is discoverable from the marker's tooltip
    const marker = [...host.querySelectorAll("[title]")].find((el) => el.textContent === "预算耗尽");
    expect(marker?.getAttribute("title")).toContain("/goal budget");
    act(() => root.unmount());
  });

  test("budget-limited is not rendered as paused", () => {
    const { host, root } = mount(goal({ status: "budget-limited" }));
    // the stall marker is present and the affordance is still the pause one:
    // base treats a budget-limited goal as live (pause is legal, resume alone
    // re-limits on the next accounting turn)
    expect(host.textContent).toContain("预算耗尽");
    const titles = [...host.querySelectorAll("button[title]")].map((b) => b.getAttribute("title") ?? "");
    expect(titles.some((t) => t.includes("/goal pause"))).toBe(true);
    expect(titles.some((t) => t.includes("/goal resume"))).toBe(false);
    act(() => root.unmount());
  });

  test("a running goal has no stall marker, a paused goal still resumes", () => {
    const running = mount(goal());
    expect(running.host.textContent).not.toContain("预算耗尽");
    act(() => running.root.unmount());

    const paused = mount(goal({ status: "paused", enabled: false }));
    expect(paused.host.textContent).not.toContain("预算耗尽");
    const titles = [...paused.host.querySelectorAll("button[title]")].map((b) => b.getAttribute("title") ?? "");
    expect(titles.some((t) => t.includes("/goal resume"))).toBe(true);
    act(() => paused.root.unmount());
  });
});
