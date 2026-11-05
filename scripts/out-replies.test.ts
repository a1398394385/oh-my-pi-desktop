// `out://` mid-call replies (base 18.14): eval/bash repeat every reply so far on each
// tool_execution_update. The host projects them onto a running tool_update frame, and the
// store must refresh the card without sealing it (a terminal tool_update still folds it).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/out-replies.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { createSmokeWindow } from "./ui-smoke-env.ts";
import type { OpenSession, ToolItem } from "../ui-src/types/session";

// happy-dom globals must exist before the store modules evaluate, so these imports cannot be
// static (same pattern as task-spawn-details.test.ts)
createSmokeWindow();
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session");
const { translateEvent } = await import("../host/translate.ts");

const SID = "out-replies-1";
const PATH = "/tmp/out-replies/session-a.jsonl";

function update(toolName: string, details: unknown, toolCallId = "c1") {
  return translateEvent(
    { type: "tool_execution_update", toolCallId, toolName, args: {}, partialResult: { content: [], details } },
    {} as never,
  );
}

describe("tool_execution_update → out:// replies", () => {
  test("replies project onto a running tool_update frame", () => {
    expect(update("eval", { replies: ["waiting on tests", "half done"] })).toEqual({
      kind: "tool_update",
      name: "eval",
      toolCallId: "c1",
      replies: ["waiting on tests", "half done"],
      running: true,
    });
  });

  test("a repeated replies array is not re-sent", () => {
    expect(update("bash", { replies: ["a"] }, "c2")?.kind).toBe("tool_update");
    expect(update("bash", { replies: ["a"] }, "c2")).toBeNull();
    expect(update("bash", { replies: ["a", "b"] }, "c2")?.kind).toBe("tool_update");
  });

  test("updates without replies stay untranslated", () => {
    expect(update("bash", { output: "chunk" })).toBeNull();
    expect(update("bash", { replies: [] })).toBeNull();
  });

  test("task updates keep the details-only frame", () => {
    const details = { progress: [{ id: "Shell", agent: "scout", status: "running" }] };
    expect(update("task", details)).toEqual({ kind: "tool_details", name: "task", toolCallId: "c1", details });
  });

  test("the terminal frame carries the call's replies", () => {
    const ev = translateEvent(
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "eval",
        args: {},
        result: { content: [{ type: "text", text: "ok" }], details: { replies: ["waiting on tests"] } },
      },
      { transcript: [], cwd: "/tmp" } as never,
    );
    if (ev?.kind !== "tool_update") throw new Error(`expected tool_update, got ${ev?.kind}`);
    expect(ev.replies).toEqual(["waiting on tests"]);
    expect(ev.running).toBeUndefined();
  });
});

describe("running tool_update frame in the store", () => {
  function seed(): void {
    const s = {
      sessionId: SID,
      path: PATH,
      items: [
        {
          role: "tool",
          text: "eval",
          name: "eval",
          toolCallId: "c1",
          running: true,
          cmdExpanded: true,
          replies: ["first"],
        },
      ],
      assistantDraft: "",
      streaming: false,
      subagents: new Map(),
    } as unknown as OpenSession;
    useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s) }));
  }

  test("refreshes replies without sealing or folding the row", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", replies: ["first", "second"], running: true });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.replies).toEqual(["first", "second"]);
    expect(item.running).toBe(true);
    expect(item.cmdExpanded).toBe(true);
  });

  test("the terminal frame seals the row and keeps the replies", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", output: "done", replies: ["first"] });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.output).toBe("done");
    expect(item.running).toBe(false);
    expect(item.replies).toEqual(["first"]);
  });

  test("a terminal frame without replies keeps the ones on screen", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", replies: ["first", "second"], running: true });
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", output: "done" });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.running).toBe(false);
    expect(item.replies).toEqual(["first", "second"]);
  });
});
