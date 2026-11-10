// Agent process display style (ui.prefs.agentProcessStyle) drives both folding
// levels in chat/items.tsx: "standard" folds a >=3 read-only run and merges
// same-type events, "detailed" drops the read-only run fold, "expanded" (labeled
// "complete") drops the same-type merges too, and "all" ("fully expanded") lays
// rows out like expanded while the store opens every process block by default.
// "concise" folds like standard (that shape is what the live reveal shows) and
// adds renderItems' hideProcessFrom filter, which strips the running turn's
// process rows down to the assistant outputs. Both renderItems branches (top-level
// flow and the child container used by LoopGroup) must honour it.
// The dynamic imports are deliberate: the store module reads localStorage while
// evaluating, so the happy-dom globals above must exist first (same shape as the
// other UI smokes).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/agent-process-style.test.ts
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { AgentProcessStyle } from "../ui-src/store/shapes";
import type { ChatItem, OpenSession, RailEntry, ToolItem } from "../ui-src/types/session";

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
const { applyEvent } = await import("../ui-src/store/session");

const setStyle = (v: AgentProcessStyle) =>
  useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, agentProcessStyle: v } }));

// renderItems only ever attaches `item` to ToolRow nodes; ReactElement.props is unknown here
type RowProps = { item?: ToolItem };
const rowProps = (el: ReactElement): RowProps => el.props as RowProps;

// ReadonlyGroup carries its folded run as `subs`; same unknown-props situation as rowProps
const groupSubCount = (el: ReactElement): number => {
  const props = el.props as { subs: ChatItem[] };
  return props.subs.length;
};

// A tool row renders inside a Fragment (its `out://` reply card is a sibling), so rows have
// to be collected from the children instead of the top-level element list.
const flatten = (els: unknown, acc: ReactElement[] = []): ReactElement[] => {
  if (!Array.isArray(els)) return acc;
  for (const el of els as ReactElement[]) {
    if (!el || typeof el !== "object") continue;
    acc.push(el);
    flatten((el.props as { children?: unknown })?.children, acc);
  }
  return acc;
};

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
  const all = flatten(renderItems(items as ChatItem[], pfx, []));
  const rows = all.filter((el) => rowProps(el).item);
  return {
    readonlyBlocks: all.filter((el) => el.type === ReadonlyGroup).length,
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

  test("all lays the rows out like expanded", () => {
    setStyle("all");
    expect(scan([...reads2, ...cmds2])).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 4 });
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 4 });
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

    // UserMsg carries `item` too, so count by role: only the two outputs survive
    const isToolRow = (el: ReactElement) => rowProps(el).item?.role === "tool";

    const entries: RailEntry[] = [];
    const hidden = flatten(renderItems(items, "", entries, undefined, { hideProcessFrom: 0 }));
    expect(hidden.filter(isToolRow)).toHaveLength(0);
    expect(hidden.some((el) => el.type === ReadonlyGroup)).toBe(false);
    expect(hidden.filter((el) => el.type === AssistantMsg)).toHaveLength(2);
    // the rail mirrors the visible rows
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "assistant"]);

    // reveal: no filter, the process rows (and their standard folds) come back
    const shown = flatten(renderItems(items, "", [], undefined, {}));
    expect(shown.filter(isToolRow).length).toBeGreaterThan(0);
  });

  test("an unknown stored value falls back to standard", () => {
    // localStorage is user-writable, so the store can hold a value outside the union
    const bogus = "bogus" as AgentProcessStyle;
    setStyle(bogus);
    expect(scan(reads3).readonlyBlocks).toBe(1);
  });

  test("expand while running keeps the live row out of every fold", () => {
    setStyle("standard");
    const setPrefs = (p: { showThinking?: boolean; expandToolOutput?: boolean }) =>
      useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, ...p } }));
    // The folded block's sub count tells whether the running row was swallowed
    const blockSizes = (items: ChatItem[]) =>
      renderItems(items, "", []).filter((el) => el.type === ReadonlyGroup).map(groupSubCount);

    const reads4 = [...reads3, tool({ name: "read", toolCallId: "r24", args: { path: "/f4" } })];
    const liveReads4 = reads4.map((it, i) => (i === 3 ? { ...it, running: true } : it));

    setPrefs({ expandToolOutput: false });
    expect(blockSizes(liveReads4)).toEqual([4]);
    setPrefs({ expandToolOutput: true });
    expect(blockSizes(liveReads4)).toEqual([3]);
    expect(scan(liveReads4)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 1 });

    // same-type merge stops at the running row too
    const liveCmds2 = [cmds2[0], { ...cmds2[1], running: true }];
    setPrefs({ expandToolOutput: false });
    expect(scan(liveCmds2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
    setPrefs({ expandToolOutput: true });
    expect(scan(liveCmds2)).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 2 });

    // a streaming thinking row stays outside the run instead of being collected into it
    const thinkLive = { role: "thinking", text: "t", thinking: "", streaming: true } as ChatItem;
    setPrefs({ showThinking: false });
    setPrefs({ expandToolOutput: false });
    expect(blockSizes([...reads3, thinkLive])).toEqual([4]);
    setPrefs({ showThinking: true });
    expect(blockSizes([...reads3, thinkLive])).toEqual([3]);
  });
});

// The "all" style's open-by-default rule lives in the store's frame handlers: a thinking
// block opens while it streams and folds back on completion, a tool card opens on the tool
// frame and stays open after the terminal tool_update (Ctrl+O still folds it at the end).
describe("all style opens process blocks", () => {
  const SID = "style-all-1";
  const P = "/tmp/style-all/session.jsonl";
  const prefs = (p: { showThinking?: boolean; expandToolOutput?: boolean }) =>
    useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, ...p } }));
  function seed(): void {
    useAppStore.setState((st) => ({
      activePath: P,
      openSessions: new Map(st.openSessions).set(P, {
        sessionId: SID,
        path: P,
        cwd: "/tmp",
        items: [],
        assistantDraft: "",
        streaming: true,
        subagents: new Map(),
      } as unknown as OpenSession),
    }));
  }
  const items = () => useAppStore.getState().openSessions.get(P)!.items;

  test("a streaming thinking block opens with show-thinking off, then folds back", () => {
    setStyle("all");
    prefs({ showThinking: false });
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "thinking", phase: "start" } as never);
    const started = items()[0];
    if (started.role !== "thinking") throw new Error(`expected a thinking row, got ${started.role}`);
    expect(started.expanded).toBe(true);
    applyEvent({ type: "event", sessionId: SID, kind: "thinking", phase: "end", thinking: "done" } as never);
    const ended = items()[0];
    if (ended.role !== "thinking") throw new Error(`expected a thinking row, got ${ended.role}`);
    expect(ended.expanded).toBe(false);
  });

  test("a tool card opens on birth and stays open after the terminal update", () => {
    setStyle("all");
    prefs({ expandToolOutput: false });
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool", name: "bash", toolCallId: "t1", args: { command: "ls" } } as never);
    const born = items()[0];
    if (born.role !== "tool") throw new Error(`expected a tool row, got ${born.role}`);
    expect(born.cmdExpanded).toBe(true);
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "bash", toolCallId: "t1", output: "ok" } as never);
    const settled = items()[0];
    if (settled.role !== "tool") throw new Error(`expected a tool row, got ${settled.role}`);
    expect(settled.cmdExpanded).toBe(true);

    // Ctrl+O keeps its own rule: expand during the run, fold at the end
    setStyle("standard");
    prefs({ expandToolOutput: true });
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool", name: "bash", toolCallId: "t2", args: { command: "ls" } } as never);
    const live = items()[0];
    if (live.role !== "tool") throw new Error(`expected a tool row, got ${live.role}`);
    expect(live.cmdExpanded).toBe(true);
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "bash", toolCallId: "t2", output: "ok" } as never);
    const done = items()[0];
    if (done.role !== "tool") throw new Error(`expected a tool row, got ${done.role}`);
    expect(done.cmdExpanded).toBe(false);
  });
});
