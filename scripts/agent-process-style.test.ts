// Agent process display style (ui.prefs.agentProcessStyle) drives the chat/items.tsx fold:
// "standard" folds a whole work segment (everything between two outputs) into one block and
// merges same-type events, "detailed" drops the segment fold, "expanded" (labeled
// "complete") drops the same-type merges too, and "all" ("fully expanded") lays rows out
// like expanded while the store opens every process block by default.
// "concise" folds like standard and additionally starts the live segment collapsed
// (LiveProcess) — that default is the only difference at render time.
// renderItems' liveFrom hands the streaming turn's current segment to LiveProcess instead of
// laying those rows out inline. Both renderItems branches (top-level flow and the child
// container used by LoopGroup) must honour the segment gates.
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
const { default: LiveProcess } = await import("../ui-src/components/chat/LiveProcess");
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

// LiveProcess carries its collected rows as `items`; same unknown-props situation as rowProps
const liveItemsOf = (el: ReactElement): ChatItem[] => {
  const props = el.props as { items: ChatItem[] };
  return props.items;
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
  test("standard folds a work segment into one block and keeps edits on their own row", () => {
    setStyle("standard");
    expect(scan(reads3)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    // the segment is the unit, not a run threshold: a two-row segment folds as well
    expect(scan(reads2)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    expect(scan(cmds2)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    // edits break the segment: the reads fold, the edits merge into their own group
    expect(scan([...reads2, ...edits2])).toEqual({ readonlyBlocks: 1, mergedGroups: 1, toolRows: 1 });
    // an edit first: nothing to fold before it
    expect(scan([...edits2, ...reads2])).toEqual({ readonlyBlocks: 1, mergedGroups: 1, toolRows: 1 });
  });

  test("detailed stops merging reads but keeps the other same-type groups", () => {
    setStyle("detailed");
    // no segment fold, no read-group merge: three reads stay three rows
    expect(scan(reads3)).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 3 });
    // change/terminal/device groups still merge
    expect(scan(cmds2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
    expect(scan(edits2)).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 1 });
    expect(scan([...reads2, ...edits2])).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 3 });
  });

  test("expanded keeps every tool event on its own row", () => {
    setStyle("expanded");
    // 2 reads + 2 commands = 4 rows, none swallowed by a merge
    expect(scan([...reads2, ...cmds2])).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 4 });
  });

  test("child container branch honours the same gates", () => {
    setStyle("standard");
    expect(scan(reads3, "k")).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 1, mergedGroups: 1, toolRows: 1 });

    setStyle("concise");
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });

    setStyle("detailed");
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 0, mergedGroups: 1, toolRows: 3 });

    setStyle("expanded");
    expect(scan([...reads2, ...edits2], "k")).toEqual({ readonlyBlocks: 0, mergedGroups: 0, toolRows: 4 });
  });

  test("concise folds like standard but also swallows edits", () => {
    setStyle("concise");
    expect(scan(reads3)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    expect(scan(reads2)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    // the only difference from standard: edits join the segment instead of standing alone
    expect(scan([...reads2, ...edits2])).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    expect(scan(edits2)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
  });

  test("liveFrom hands the current segment to LiveProcess, keeping outputs inline", () => {
    setStyle("standard");
    // liveFrom = the first row after the turn's last output (index 3)
    const items = [
      { role: "user", text: "go" },
      ...reads2,
      { role: "assistant", text: "first" },
      ...cmds2,
    ] as ChatItem[];

    const nodes = flatten(renderItems(items, "", [], undefined, { liveFrom: 4 }));
    const live = nodes.filter((el) => el.type === LiveProcess);
    expect(live).toHaveLength(1);
    expect(liveItemsOf(live[0])).toHaveLength(2);
    // the work before that output still folds into its own card
    expect(nodes.filter((el) => el.type === ReadonlyGroup)).toHaveLength(1);
    // the collected rows never lay out inline
    expect(nodes.filter((el) => rowProps(el).item?.role === "tool")).toHaveLength(0);
    expect(nodes.filter((el) => el.type === AssistantMsg)).toHaveLength(1);
  });

  test("liveFrom keeps edits out of the live segment under standard", () => {
    setStyle("standard");
    const items = [
      { role: "user", text: "go" },
      { role: "assistant", text: "first" },
      ...cmds2,
      ...edits2,
    ] as ChatItem[];

    const nodes = flatten(renderItems(items, "", [], undefined, { liveFrom: 2 }));
    const live = nodes.filter((el) => el.type === LiveProcess);
    expect(live).toHaveLength(1);
    // only the commands are collected; the edits stay inline as their own changes group
    expect(liveItemsOf(live[0]).map((it) => (it as ToolItem).name)).toEqual(["bash", "bash"]);
    expect(nodes.some((el) => Array.isArray(rowProps(el).item?.group))).toBe(true);

    setStyle("concise");
    const collected = flatten(renderItems(items, "", [], undefined, { liveFrom: 2 }));
    expect(liveItemsOf(collected.filter((el) => el.type === LiveProcess)[0])).toHaveLength(4);
  });

  test("flat styles gather no live segment", () => {
    setStyle("detailed");
    const items = [
      { role: "user", text: "go" },
      { role: "assistant", text: "first" },
      ...cmds2,
    ] as ChatItem[];

    const nodes = flatten(renderItems(items, "", [], undefined, { liveFrom: 2 }));
    const live = nodes.filter((el) => el.type === LiveProcess);
    expect(live).toHaveLength(1);
    // nothing collected: the intent row has no body, the commands merge into one row
    expect(liveItemsOf(live[0])).toHaveLength(0);
    expect(nodes.filter((el) => Array.isArray(rowProps(el).item?.group))).toHaveLength(1);
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
    expect(scan(liveCmds2)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 0 });
    setPrefs({ expandToolOutput: true });
    expect(scan(liveCmds2)).toEqual({ readonlyBlocks: 1, mergedGroups: 0, toolRows: 1 });

    // a streaming thinking row stays outside the run instead of being collected into it
    const thinkLive = { role: "thinking", text: "t", thinking: "", streaming: true } as ChatItem;
    setPrefs({ showThinking: false });
    setPrefs({ expandToolOutput: false });
    expect(blockSizes([...reads3, thinkLive])).toEqual([4]);
    setPrefs({ showThinking: true });
    expect(blockSizes([...reads3, thinkLive])).toEqual([3]);
  });
});

// "Expand while running" (Ctrl+O) lives in the store's frame handlers: the tool card opens on
// the tool frame and folds back at the terminal tool_update.
describe("expand while running opens the tool card", () => {
  const SID = "style-crto-1";
  const P = "/tmp/style-crto/session.jsonl";
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

  test("the card opens on birth and folds at the end", () => {
    setStyle("standard");
    prefs({ expandToolOutput: true });
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool", name: "bash", toolCallId: "t1", args: { command: "ls" } } as never);
    const live = items()[0];
    if (live.role !== "tool") throw new Error(`expected a tool row, got ${live.role}`);
    expect(live.cmdExpanded).toBe(true);
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "bash", toolCallId: "t1", output: "ok" } as never);
    const done = items()[0];
    if (done.role !== "tool") throw new Error(`expected a tool row, got ${done.role}`);
    expect(done.cmdExpanded).toBe(false);
  });
});
