// The approved-plan execution turn persists as a synthetic developer message (the base
// marks plan-approved prompts synthetic to skip user attribution), so a rebuilt transcript
// had no user row to open the turn: every row rendered flat under #stream (flex children
// never collapse margins → doubled line spacing) and the run never folded into a loop
// group. Regression: the synthetic message carrying the rendered plan body maps back to
// the user bubble the live dispatch echoed (host/plan-approve.ts), the execution turn
// groups like an operator turn, and sumRunDurationMs counts its span. Other synthetic
// developer messages (auto-continue, reminders) keep their existing handling.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/translate-history-plan-approve.test.ts
import { describe, expect, test } from "bun:test";
import { entriesToTranscript, sumRunDurationMs } from "../host/translate-history.ts";
import type { TranscriptItem } from "../host/wire/payloads.ts";

const at = (sec: number) => `2026-01-01T00:00:${String(sec).padStart(2, "0")}.000Z`;
const PLAN_BODY = "# Plan title\n\n- step 1\n- step 2";
// Mirrors the base plan-mode-approved.md render: instruction sheet + inlined plan body.
const approvedText = `Plan approved.\n\n<instruction>\nExecute plan step-by-step.\n</instruction>\n\n<plan path="local://plan.md">\n${PLAN_BODY}\n</plan>\n\n<critical>\nMUST continue until complete.\n</critical>`;
const syntheticDevEntry = (id: string, parentId: string | null, sec: number, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: at(sec),
  message: { role: "developer", synthetic: true, timestamp: 0, content: [{ type: "text", text }] },
});
const thinkingEntry = (id: string, parentId: string, sec: number) => ({
  type: "message",
  id,
  parentId,
  timestamp: at(sec),
  message: { role: "assistant", timestamp: 0, content: [{ type: "thinking", thinking: "hmm" }] },
});
const textEntry = (id: string, parentId: string, sec: number, text: string, stop = false) => ({
  type: "message",
  id,
  parentId,
  timestamp: at(sec),
  message: { role: "assistant", timestamp: 0, stopReason: stop ? "stop" : undefined, content: [{ type: "text", text }] },
});

const roles = (items: TranscriptItem[]) => items.map((it) => it.role);

describe("entriesToTranscript approved-plan mapping", () => {
  test("synthetic developer message with a plan block opens the turn as the user bubble", () => {
    const items = entriesToTranscript([
      syntheticDevEntry("d1", null, 0, approvedText),
      thinkingEntry("a1", "d1", 1),
      textEntry("a2", "d1", 2, "done", true),
    ]);
    expect(roles(items)).toEqual(["user", "loop", "assistant"]);
    expect(items[0].text).toBe(PLAN_BODY);
    expect(items[0].entryId).toBe("d1");
    // The execution run folds into one loop group behind the bubble, like an operator turn
    expect(items[1].role).toBe("loop");
    expect(items[1].items?.map((it) => it.role)).toEqual(["thinking"]);
    expect(items[2].text).toBe("done");
  });

  test("synthetic developer message without a plan block keeps the existing flat handling", () => {
    const items = entriesToTranscript([
      syntheticDevEntry("d1", null, 0, "Auto-continuing the task."),
      textEntry("a1", "d1", 1, "done", true),
    ]);
    expect(roles(items)).not.toContain("user");
    expect(roles(items)).toContain("assistant");
  });

  test("operator turn before the approval still groups separately", () => {
    const userEntry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: at(0),
      message: { role: "user", timestamp: 0, content: [{ type: "text", text: "explore" }] },
    };
    const items = entriesToTranscript([
      userEntry,
      thinkingEntry("a1", "u1", 1),
      textEntry("a2", "u1", 2, "plan ready", true),
      syntheticDevEntry("d1", "a2", 3, approvedText),
      thinkingEntry("a3", "d1", 4),
      textEntry("a4", "d1", 5, "executed", true),
    ]);
    expect(roles(items)).toEqual(["user", "loop", "assistant", "user", "loop", "assistant"]);
    expect(items[3].text).toBe(PLAN_BODY);
  });
});

describe("sumRunDurationMs approved-plan segmentation", () => {
  test("the execution run's wall-clock span counts even with no user message", () => {
    const ms = sumRunDurationMs([
      syntheticDevEntry("d1", null, 0, approvedText),
      thinkingEntry("a1", "d1", 5),
    ]);
    expect(ms).toBe(5000);
  });
});
