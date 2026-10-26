// Task card spawn rows: an async task call returns a progress snapshot taken while later spawns
// are still resolving their model, so their rows start without one. The base keeps reporting
// progress after the call returns; the host forwards those as a details-only frame so the rows
// fill in without flipping the settled card back to "running" (tool_update would un-collapse it
// and blank the spinner state of a call that already ended).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/task-spawn-details.test.ts
import { describe, expect, test } from "bun:test";
import { createSmokeWindow } from "./ui-smoke-env.ts";
import type { OpenSession, ToolItem } from "../ui-src/types/session";

// happy-dom globals must exist before the store modules evaluate (same pattern as
// smoke-dual-channel-store.ts), hence the dynamic imports below
createSmokeWindow();
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session");
const { translateEvent } = await import("../host/translate.ts");

const SID = "task-details-1";
const PATH = "/tmp/task-details/session-a.jsonl";
const DETAILS = { progress: [{ id: "RustCrates", agent: "scout", status: "running", resolvedModel: "minimax-code-cn/MiniMax-M3.1-Flash:medium" }] };

// The details-only branch runs before any entry bookkeeping, so an empty entry is enough
const entry = {} as never;

describe("tool_execution_update → tool_details", () => {
  test("task updates forward the refreshed details", () => {
    const ev = translateEvent(
      { type: "tool_execution_update", toolCallId: "c1", toolName: "task", args: {}, partialResult: { content: [], details: DETAILS } },
      entry,
    );
    expect(ev).toEqual({ kind: "tool_details", name: "task", toolCallId: "c1", details: DETAILS });
  });

  test("other tools keep their in-flight updates untranslated", () => {
    const ev = translateEvent(
      { type: "tool_execution_update", toolCallId: "c2", toolName: "bash", args: {}, partialResult: { content: [], details: {} } },
      entry,
    );
    expect(ev).toBeNull();
  });

  test("updates without details are dropped", () => {
    const ev = translateEvent(
      { type: "tool_execution_update", toolCallId: "c3", toolName: "task", args: {}, partialResult: { content: [] } },
      entry,
    );
    expect(ev).toBeNull();
  });
});

describe("tool_details frame in the store", () => {
  // A settled task card the user has expanded by hand: the details refresh must not touch it
  function seed(): void {
    const s = {
      sessionId: SID,
      path: PATH,
      items: [
        {
          role: "tool",
          text: "task",
          name: "task",
          toolCallId: "c1",
          running: false,
          cmdExpanded: true,
          details: { progress: [{ id: "CliEntry", agent: "scout", status: "pending" }] },
        },
      ],
      assistantDraft: "",
      streaming: false,
      subagents: new Map(),
    } as unknown as OpenSession;
    useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s) }));
  }

  test("replaces details only, leaving running and expand state alone", () => {
    seed();
    expect(useAppStore.getState().uiPrefs.expandToolOutput).toBe(true); // the collapse-on-end path is armed
    applyEvent({ type: "event", sessionId: SID, kind: "tool_details", name: "task", toolCallId: "c1", details: DETAILS });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.details).toEqual(DETAILS);
    expect(item.running).toBe(false);
    expect(item.cmdExpanded).toBe(true);
  });

  test("rows match by call id even when the name differs", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_details", name: "other", toolCallId: "c1", details: DETAILS });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.details).toEqual(DETAILS);
  });
});
