// Attach/snapshot transcript contract. host/translate.ts accumulates the live stream flat
// (no loop groups, no run-changes rows), so a `messages` frame built from entry.transcript
// flattened every turn added after the pool entry was created: no "worked for N s · total
// usage" group row, no files-changed card. The attach snapshot therefore ships
// entriesToTranscript(manager.getBranch()) — this test pins both halves:
//   1. the rebuilt layout carries the loop group and the anchored change card;
//   2. the flat live layout carries neither (the regression the fix removes).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/snapshot-transcript.test.ts
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

const win = new Window({ url: "http://localhost/?preview=1" });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  localStorage: win.localStorage, navigator: win.navigator, location: win.location,
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { renderItems } = await import("../ui-src/components/chat/items");
const { default: LoopGroup } = await import("../ui-src/components/chat/LoopGroup");
const { default: RunChanges } = await import("../ui-src/components/chat/RunChanges");
const { entriesToTranscript } = await import("../host/translate-history.ts");
const { RUN_CHANGES_CUSTOM_TYPE } = await import("../host/run-changes.ts");
import type { ChatItem } from "../ui-src/types/session";

const ts = (m: number) => `2026-01-01T00:0${m}:00.000Z`;

// One turn: a tool call, then the run-final report, plus the run's change record anchored on
// that report — the shape every completed desktop run persists.
const entries = [
  { type: "message", id: "u1", timestamp: ts(0), message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
  {
    type: "message",
    id: "a1",
    timestamp: ts(1),
    message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "/tmp/x.ts" } }], stopReason: "toolUse" },
  },
  { type: "message", id: "r1", timestamp: ts(2), message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }] } },
  { type: "message", id: "a2", timestamp: ts(3), message: { role: "assistant", content: [{ type: "text", text: "fixed" }], stopReason: "stop" } },
  { type: "custom", customType: RUN_CHANGES_CUSTOM_TYPE, data: { changeId: "c1", anchor: "a2", files: [{ path: "/tmp/x.ts", added: 3, removed: 1 }] } },
];

const flat = (els: ReactElement[]): ReactElement[] => {
  const acc: ReactElement[] = [];
  const walk = (list: ReactElement[]) => {
    for (const el of list) {
      if (!el) continue;
      acc.push(el);
      const kids = (el.props as { children?: unknown }).children;
      if (Array.isArray(kids)) walk(kids as ReactElement[]);
    }
  };
  walk(els);
  return acc;
};
const count = (els: ReactElement[], component: unknown) => els.filter((el) => el.type === component).length;

describe("attach snapshot transcript", () => {
  test("rebuilt layout keeps the process group and the run's change card", () => {
    const items = entriesToTranscript(entries) as unknown as ChatItem[];
    const nodes = flat(renderItems(items, "", []));
    expect(count(nodes, LoopGroup)).toBe(1);
    expect(count(nodes, RunChanges)).toBe(1);
  });

  test("flat live layout loses both (why the snapshot must not send entry.transcript)", () => {
    // entry.transcript shape: same rows, never folded into a group, never carrying changes
    const live = [
      { role: "user", text: "fix it", entryId: "u1" },
      { role: "tool", text: "edit", name: "edit", toolCallId: "tc1" },
      { role: "assistant", text: "fixed", entryId: "a2" },
    ] as unknown as ChatItem[];
    const nodes = flat(renderItems(live, "", []));
    expect(count(nodes, LoopGroup)).toBe(0);
    expect(count(nodes, RunChanges)).toBe(0);
  });
});
