import { describe, expect, test } from "bun:test";
import { backfillUserEntryIds, backfillAssistantEntryIds } from "../host/translate.ts";
import type { PoolEntry } from "../host/state.ts";

// Fake pool entry: transcript = the host's live transcript items, manager.getEntries()
// = the persisted disk entries (message entries only, ids as given).
function fakeEntry(transcript: Array<Record<string, unknown>>, disk: Array<Record<string, unknown>>): PoolEntry {
  return {
    transcript,
    manager: { getEntries: () => disk },
  } as unknown as PoolEntry;
}

function diskUser(id: string, text: string) {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function diskAssistant(id: string, blocks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { type: "message", id, message: { role: "assistant", content: blocks, ...extra } };
}

describe("backfillUserEntryIds", () => {
  test("identical user texts across rounds each get their own disk entry", () => {
    // Round 1: user "go on" #1 persisted as u1 and backfilled.
    const e1 = fakeEntry([{ role: "user", text: "go on" }], [diskUser("u1", "go on")]);
    expect(backfillUserEntryIds(e1)).toBe("u1");

    // Round 2: user "go on" #2 persisted as u2. Regression: the matcher used to
    // re-match the already-consumed u1 (its within-call `from` cursor resets),
    // so the second "go on" was anchored at u1 and the assistant backfill below
    // shifted onto the wrong window.
    e1.transcript.push({ role: "user", text: "go on" });
    e1.manager.getEntries = () => [diskUser("u1", "go on"), diskUser("u2", "go on")];
    expect(backfillUserEntryIds(e1)).toBe("u2");
    expect(e1.transcript[1].entryId).toBe("u2");
    expect(e1.transcript[0].entryId).toBe("u1");
  });
});

describe("backfillAssistantEntryIds", () => {
  test("thinking/toolCall-only disk entries do not consume transcript slots", () => {
    // One transcript assistant item (the final text segment), but three disk
    // assistant entries — the first two carry no text block. Regression: entry-
    // level positional alignment assigned the FIRST disk entry's id to the
    // segment, so the fork button under the final output anchored an earlier
    // message and the slice dropped the output the user forked from.
    const entry = fakeEntry(
      [
        { role: "user", text: "go on", entryId: "u1" },
        { role: "assistant", text: "final answer" },
      ],
      [
        diskUser("u1", "go on"),
        diskAssistant("a1", [{ type: "thinking", thinking: "t" }, { type: "toolCall", name: "grep" }]),
        diskAssistant("a2", [{ type: "thinking", thinking: "t" }, { type: "toolCall", name: "glob" }]),
        diskAssistant("a3", [{ type: "thinking", thinking: "t" }, { type: "text", text: "final answer" }]),
      ],
    );
    expect(backfillAssistantEntryIds(entry, "u1")).toBe("a3");
    expect(entry.transcript[1].entryId).toBe("a3");
  });

  test("incident replay: aborted reply + duplicate user text anchor the final output exactly", () => {
    // Mirrors 01a13ff5: turn 1 "go on" aborted (empty assistant entry, no error
    // row), turn 2 "go on" ends with 3 assistant entries of which only the last
    // has text. The returned anchor must be the turn-final entry.
    // Round 1 (turn 1 ends): only the first "go on" exists; backfills u1.
    const entry = fakeEntry(
      [{ role: "user", text: "go on" }],
      [diskUser("u1", "go on")],
    );
    expect(backfillUserEntryIds(entry)).toBe("u1");
    // Turn 2 streams: second "go on" + two text segments arrive; the abort
    // entry a0 and turn 2's entries persist by turn 2's agent_end.
    entry.transcript.push({ role: "user", text: "go on" }, { role: "assistant", text: "seg 1" }, { role: "assistant", text: "seg 2" });
    entry.manager.getEntries = () => [
      diskUser("u1", "go on"),
      diskAssistant("a0", [], { stopReason: "aborted", errorMessage: "Interrupted by user" }),
      diskUser("u2", "go on"),
      diskAssistant("a1", [{ type: "thinking", thinking: "t" }, { type: "toolCall", name: "grep" }]),
      diskAssistant("a2", [{ type: "text", text: "seg 1" }, { type: "toolCall", name: "grep" }]),
      diskAssistant("a3", [{ type: "text", text: "seg 2" }]),
    ];
    // Round 2 (turn 2 ends): the second "go on" must anchor at u2, not re-match u1.
    expect(backfillUserEntryIds(entry)).toBe("u2");
    // With the correct anchor, both segments align 1:1 with the text-bearing
    // disk entries; the fork button key is the turn-final assistant entry.
    expect(backfillAssistantEntryIds(entry, "u2")).toBe("a3");
    expect(entry.transcript[2].entryId).toBe("a2");
    expect(entry.transcript[3].entryId).toBe("a3");
  });
});
