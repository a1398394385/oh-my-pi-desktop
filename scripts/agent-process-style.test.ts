// Agent process display style (ui.prefs.agentProcessStyle) drives both folding
// levels in chat/items.tsx: "standard" folds a >=3 read-only run and merges
// same-type events, "detailed" drops the read-only run fold, "expanded" drops
// the same-type merges too. "concise" folds like standard (that shape is what the
// live reveal shows) and adds renderItems' hideProcessFrom filter, which strips
// the running turn's process rows down to the assistant outputs. Both renderItems
// branches (top-level flow and the child container used by LoopGroup) must honour it.
// The dynamic imports are deliberate: the store module reads localStorage while
// evaluating, so the happy-dom globals above must exist first (same shape as the
// other UI smokes).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/agent-process-style.test.ts
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { AgentProcessStyle } from "../ui-src/store/shapes";
import type { ChatItem, RailEntry, ToolItem } from "../ui-src/types/session";

const win = new Window({ url: "http://localhost/?preview=1" });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  localStorage: win.localStorage, navigator: win.navigator, location: win.location,
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { renderItems } = await import("../ui-src/components/chat/items");
const { default: ReadonlyGroup } = await import("../ui-src/components/chat/ReadonlyGroup");
const { default: AssistantMsg } = await import("../ui-src/components/chat/AssistantMsg");

const setStyle = (v: AgentProcessStyle) =>
  useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, agentProcessStyle: v } }));

// renderItems only ever attaches `item` to ToolRow nodes; ReactElement.props is unknown here
type RowProps = { item?: ToolItem };
const rowProps = (el: ReactElement): RowProps => el.props as RowProps;

const tool = (o: Partial<ToolItem> & Pick<ToolItem, "name" | "toolCallId">): ToolItem =>
  ({ role: "tool", text: "", ...o });

const reads2: ToolItem[] = [1, 2].map((n) =>
  tool({ name: "read", toolCallId: "r2" + n, args: { path: "/f" + n } }));
const reads3: ToolItem[] = [...reads2, tool({ name: "read", toolCallId: "r23", args: { path: "/f3" } })];
const cmds2: ToolItem[] = [1, 2].map((n) =>
  tool({ name: "bash", toolCallId: "c" + n, args: { command: "ls" } }));
// edits break a read-only run, so [reads2, edits2] exercises the read group and the
// changes group as two separate level-3 merges
const edits2: ToolItem[] = [1, 2].map((n) =>
  tool({ name: "edit", toolCallId: "e" + n, args: { path: "/a" + n + ".ts" } }));

function scan(items: ToolItem[], pfx = "") {
  const out = renderItems(items as ChatItem[], pfx, []);
  const rows = out.filter((el) => rowProps(el).item);
  return {
    readonlyBlocks: out.filter((el) => el.type === ReadonlyGroup).length,
    // a merged row carries `group` on its ToolItem; flat rows never do
    mergedGroups: rows.filter((el) => Array.isArray(rowProps(el).item?.group)).length,
    toolRows: rows.length,
  };
}

describe("agent process display style", () => {
  test("standard folds a >=3 read-only run and merges same-type events", () => {
    setStyle("standard");
    expect(scan(reads3)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    // below the fold threshold the level-3 read group takes over
    expect(scan(reads2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
    expect(scan(cmds2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
  });

  test("detailed drops the read-only run fold but keeps same-type merges", () => {
    setStyle("detailed");
    expect(scan(reads3)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
    expect(scan(cmds2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
  });

  test("expanded keeps every tool event on its own row", () => {
    setStyle("expanded");
    // 2 reads + 2 commands = 4 rows, none swallowed by a merge
    expect(scan([...reads2, ...cmds2])).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 4 });
  });

  test("child container branch honours the same gates", () => {
    setStyle("standard");
    expect(scan(reads3, "k")).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 0, mergedGroups: 2, toolRows: 2 });

    setStyle("expanded");
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 4 });
  });

  test("concise folds like standard", () => {
    setStyle("concise");
    expect(scan(reads3)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    expect(scan(reads2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
  });

  test("hideProcessFrom drops the live turn's process rows, keeping outputs", () => {
    setStyle("concise");
    const items = [
      { role: "user", text: "go" },
      ...reads2,
      { role: "assistant", text: "first" },
      ...cmds2,
      { role: "assistant", text: "second" },
    ] as ChatItem[];
    const flat = (out: ReactElement[]) => {
      const acc: ReactElement[] = [];
      const walk = (els: ReactElement[]) => {
        for (const el of els) {
          acc.push(el);
          const kids = (el.props as { children?: unknown }).children;
          if (Array.isArray(kids)) walk(kids as ReactElement[]);
        }
      };
      walk(out);
      return acc;
    };

    // UserMsg carries `item` too, so count by role: only the two outputs survive
    const isToolRow = (el: ReactElement) => rowProps(el).item?.role === "tool";

    const entries: RailEntry[] = [];
    const hidden = flat(renderItems(items, "", entries, undefined, { hideProcessFrom: 0 }));
    expect(hidden.filter(isToolRow)).toHaveLength(0);
    expect(hidden.some((el) => el.type === ReadonlyGroup)).toBe(false);
    expect(hidden.filter((el) => el.type === AssistantMsg)).toHaveLength(2);
    // the rail mirrors the visible rows
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "assistant"]);

    // reveal: no filter, the process rows (and their standard folds) come back
    const shown = flat(renderItems(items, "", [], undefined, {}));
    expect(shown.filter(isToolRow).length).toBeGreaterThan(0);
  });

  test("an unknown stored value falls back to standard", () => {
    // localStorage is user-writable, so the store can hold a value outside the union
    const bogus = "bogus" as AgentProcessStyle;
    setStyle(bogus);
    expect(scan(reads3).readonlyBlocks).toBe(1);
  });
});
