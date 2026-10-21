// Advisor advice rendering (base customType "advisor"). Two contracts:
//   1. host/translate-advisor.ts normalizes the batch and both paths emit an outer row
//      (the desktop never rendered this custom message before — the whole feature is
//      "the row exists and keeps its position");
//   2. items.tsx puts blocking notes at that position while the process is visible and
//      hands every note to the turn-tail card once the concise live view hides the rows.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/advisor-row.test.ts
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { ChatItem } from "../ui-src/types/session";
import type { PoolEntry } from "../host/state.ts";

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
const { default: AdvisorCard, AdvisorInline } = await import("../ui-src/components/chat/AdvisorCard");
const { default: ReadonlyGroup } = await import("../ui-src/components/chat/ReadonlyGroup");
const { default: LoopGroup } = await import("../ui-src/components/chat/LoopGroup");
const { translateEvent } = await import("../host/translate.ts");
const { entriesToTranscript } = await import("../host/translate-history.ts");
const { sealRunItems } = await import("../ui-src/store/run-seal");
const { advisorHistoryRow, advisorNotesOf } = await import("../host/translate-advisor.ts");

const batch = {
  notes: [
    { note: "stop: the wire type has no custom role yet", severity: "blocker", turn: 3, turnsAgo: 0 },
    { note: "replay skips custom_message", severity: "concern", advisor: "reviewer", turnsAgo: 1 },
    { note: "nit: rename the helper", severity: "nit", turnsAgo: 2 },
  ],
};

describe("advisor batch normalization", () => {
  test("keeps severity, advisor and age; defaults a missing severity to concern", () => {
    const notes = advisorNotesOf({ role: "custom", customType: "advisor", details: { notes: [{ note: "a" }] } });
    expect(notes).toEqual([{ note: "a", severity: "concern" }]);
    expect(advisorNotesOf({ role: "custom", customType: "advisor", details: batch })?.map((n) => n.severity)).toEqual([
      "blocker", "concern", "nit",
    ]);
  });

  test("non-advisor custom types and empty payloads yield nothing", () => {
    expect(advisorNotesOf({ role: "custom", customType: "goal-continuation", content: "x" })).toBeNull();
    expect(advisorNotesOf({ role: "assistant", content: "x" })).toBeNull();
    // garbled details fall back to the raw content instead of dropping the batch
    expect(advisorNotesOf({ role: "custom", customType: "advisor", content: "raw note" })).toEqual([
      { note: "raw note", severity: "concern" },
    ]);
  });
});

describe("advisor rows through the host", () => {
  test("live: emits the event and records the row in the pooled transcript", () => {
    const entry = { cwd: "/tmp", transcript: [], assistantDraft: "" } as unknown as PoolEntry;
    const ev = translateEvent({ type: "message_end", message: { role: "custom", customType: "advisor", details: batch } }, entry);
    expect(ev?.kind).toBe("advisor");
    expect(entry.transcript.at(-1)?.role).toBe("advisor");
  });

  test("replay: the advice row is one event inside the single run group", () => {
    const toolCall = (id: string, ts: string) => ({
      type: "message", id, timestamp: ts,
      message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "/" + id } }] },
    });
    const entries = [
      { type: "message", id: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      toolCall("t1", "2026-01-01T00:00:01Z"),
      { type: "custom_message", id: "adv", timestamp: "2026-01-01T00:00:02Z", customType: "advisor", content: "", display: true, details: batch },
      toolCall("t2", "2026-01-01T00:00:03Z"),
      { type: "message", id: "a2", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ];
    const out = entriesToTranscript(entries);
    // one group per run: the note keeps its place among the run's own events
    expect(out.map((it) => it.role)).toEqual(["user", "loop", "assistant"]);
    expect((out[1] as { items: { role: string }[] }).items.map((it) => it.role)).toEqual([
      "tool", "advisor", "tool",
    ]);
  });

  test("replay: an advice row after the run's last output does not bury that output", () => {
    const entries = [
      { type: "message", id: "u1", timestamp: "t0", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      {
        type: "message", id: "a1", timestamp: "t1",
        message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" } }] },
      },
      {
        type: "message", id: "a2", timestamp: "t2",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
      { type: "custom_message", id: "adv", timestamp: "t3", customType: "advisor", content: "", display: true, details: batch },
    ];
    expect(advisorHistoryRow(entries[3])?.role).toBe("advisor");
    expect(advisorHistoryRow(entries[0])).toBeNull();
    const out = entriesToTranscript(entries);
    // the note annotates the output before it, so that output stays the turn's visible result
    expect(out.map((it) => it.role)).toEqual(["user", "loop", "assistant"]);
    // TranscriptItem is a role union; the asserted roles above pin this row's shape
    const tail = out[2] as { text?: string };
    expect(tail.text).toBe("done");
    const group = (out[1] as { items: { role: string; notes?: { severity?: string }[] }[] }).items;
    expect(group.map((it) => it.role)).toEqual(["tool", "advisor"]);
    expect(group[1].notes?.map((n) => n.severity)).toEqual(["blocker", "concern", "nit"]);
  });
});

const setStyle = (v: "concise" | "standard" | "detailed" | "expanded") =>
  useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, agentProcessStyle: v } }));

// Render tree → flat node list (renderItems nests turns in .turn-section wrappers)
// ReactElement.props is unknown here; rows are counted by type and read through this
const props = (el: ReactElement) => el.props as Record<string, unknown>;
function flat(els: ReactElement[]): ReactElement[] {
  const acc: ReactElement[] = [];
  const walk = (list: ReactElement[]) => {
    for (const el of list) {
      acc.push(el);
      const kids = (el.props as { children?: unknown }).children;
      if (Array.isArray(kids)) walk(kids as ReactElement[]);
    }
  };
  walk(els);
  return acc;
}

const read = (id: string): ChatItem =>
  ({ role: "tool", text: "", name: "read", toolCallId: id, args: { path: "/" + id } }) as ChatItem;

describe("run sealing with an advice row", () => {
  test("the advice row joins the run's single group and keeps its place", () => {
    const sess = {
      items: [
        { role: "user", text: "go" },
        read("s1"),
        { role: "advisor", text: "", notes: [batch.notes[0]] },
        read("s2"),
        { role: "assistant", text: "done" },
      ] as ChatItem[],
      turnItemStart: 1,
      turnStartAt: null,
    };
    sealRunItems(sess as never, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    expect(sess.items.map((it) => it.role)).toEqual(["user", "loop", "assistant"]);
    const group = sess.items[1] as { items: { role: string }[]; usage?: unknown };
    expect(group.items.map((it) => it.role)).toEqual(["tool", "advisor", "tool"]);
    expect(group.usage).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  });

  test("an advice row that ends the run keeps the run's output visible", () => {
    const sess = {
      items: [
        { role: "user", text: "go" },
        read("s1"),
        { role: "assistant", text: "done" },
        { role: "advisor", text: "", notes: batch.notes },
      ] as ChatItem[],
      turnItemStart: 1,
      turnStartAt: null,
    };
    sealRunItems(sess as never, null);
    expect(sess.items.map((it) => it.role)).toEqual(["user", "loop", "assistant"]);
  });
});

describe("advisor rows in the chat flow", () => {
  test("visible process: the blocker sits inline and the card keeps the rest", () => {
    setStyle("standard");
    const items = [
      { role: "user", text: "go" },
      read("r1"),
      { role: "advisor", text: "", notes: batch.notes },
      read("r2"),
      { role: "assistant", text: "done" },
    ] as ChatItem[];
    const nodes = flat(renderItems(items, "", []));
    const inline = nodes.filter((el) => el.type === AdvisorInline);
    expect(inline).toHaveLength(1);
    // only the blocker renders inline; concern + nit ride the card
    expect(props(inline[0]).notes).toHaveLength(1);
    expect(nodes.filter((el) => el.type === AdvisorCard)).toHaveLength(1);
    // the advice row is neither a tool row nor folded into a read-only block
    expect(nodes.filter((el) => el.type === ReadonlyGroup)).toHaveLength(0);
  });

  test("visible process: two advice rows share one closing card, blockers stay inline", () => {
    setStyle("expanded");
    const items = [
      { role: "user", text: "go" },
      { role: "advisor", text: "", notes: [batch.notes[0]] },
      read("r1"),
      { role: "advisor", text: "", notes: [batch.notes[1]] },
      { role: "assistant", text: "done" },
    ] as ChatItem[];
    const nodes = flat(renderItems(items, "", []));
    expect(nodes.filter((el) => el.type === AdvisorInline).length).toBe(1);
    const cards = nodes.filter((el) => el.type === AdvisorCard);
    expect(cards).toHaveLength(1);
    expect((props(cards[0]).notes as { severity?: string }[]).map((n) => n.severity)).toEqual(["concern"]);
  });

  test("collapsed process: every note (blocker included) moves to the turn-tail card", () => {
    setStyle("concise");
    const items = [
      { role: "user", text: "go" },
      read("r1"),
      { role: "advisor", text: "", notes: batch.notes },
      { role: "assistant", text: "streaming output" },
    ] as ChatItem[];
    const nodes = flat(renderItems(items, "", [], undefined, { hideProcessFrom: 0 }));
    expect(nodes.filter((el) => el.type === AdvisorInline)).toHaveLength(0);
    const cards = nodes.filter((el) => el.type === AdvisorCard);
    expect(cards).toHaveLength(1);
    expect(props(cards[0]).notes).toHaveLength(3);
    // the tool row stays hidden with the rest of the process
    expect(nodes.some((el) => (props(el).item as { role?: string } | undefined)?.role === "tool")).toBe(false);
  });

  test("revealed concise process: blockers return inline, the card drops them", () => {
    setStyle("concise");
    const items = [
      { role: "user", text: "go" },
      read("r1"),
      { role: "advisor", text: "", notes: batch.notes },
      { role: "assistant", text: "done" },
    ] as ChatItem[];
    // no hideProcessFrom = the reader expanded the working row
    const nodes = flat(renderItems(items, "", []));
    expect(nodes.filter((el) => el.type === AdvisorInline)).toHaveLength(1);
    const cards = nodes.filter((el) => el.type === AdvisorCard);
    expect(props(cards[0]).notes.map((n) => n.severity)).toEqual([
      "concern", "nit",
    ]);
  });

  test("advice folded into a sealed run group still reaches the reader", () => {
    setStyle("standard");
    const items = [
      { role: "user", text: "go" },
      { role: "loop", text: "", collapsed: true, items: [read("g1"), { role: "advisor", text: "", notes: batch.notes }] },
      { role: "assistant", text: "done" },
    ] as ChatItem[];
    const nodes = flat(renderItems(items, "", []));
    // collapsed group hides its rows, so the notes surface on the turn's closing card
    expect(nodes.filter((el) => el.type === AdvisorInline)).toHaveLength(0);
    const cards = nodes.filter((el) => el.type === AdvisorCard);
    expect(cards).toHaveLength(1);
    expect(props(cards[0]).notes).toHaveLength(3);
    // expanded group keeps the row in place: no turn-tail card, the group's own rows
    // carry the blocker inline (they render through the nested-container branch)
    const open = flat(renderItems([items[0], { ...items[1], collapsed: false }, items[2]] as ChatItem[], "", []));
    expect(open.filter((el) => el.type === AdvisorCard)).toHaveLength(0);
    const group = open.find((el) => el.type === LoopGroup);
    const inner = flat(renderItems((props(group).item as { items: ChatItem[] }).items, "k", []));
    expect(inner.filter((el) => el.type === AdvisorInline)).toHaveLength(1);
    expect(props(inner.filter((el) => el.type === AdvisorCard)[0]).notes.map((n) => n.severity)).toEqual(["concern", "nit"]);
  });

  test("a blocker breaks a read-only fold it sits inside", () => {
    setStyle("standard");
    const items = [
      { role: "user", text: "go" },
      read("r1"), read("r2"),
      { role: "advisor", text: "", notes: [batch.notes[0]] },
      read("r3"), read("r4"),
      { role: "assistant", text: "done" },
    ] as ChatItem[];
    // 2 reads on each side stay under the 3-row fold threshold, so the advice row is what
    // keeps them apart: without it the four would fold into one block
    const nodes = flat(renderItems(items, "", []));
    expect(nodes.filter((el) => el.type === ReadonlyGroup)).toHaveLength(0);
    expect(nodes.filter((el) => el.type === AdvisorInline)).toHaveLength(1);
  });
});
