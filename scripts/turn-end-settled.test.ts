// Non-terminal turn_end (host maps base agent_end isTerminal:false — a queued continuation or a
// background wait): the run stays open, but this segment's output and its entryIds must land.
// Otherwise the next run backfills them onto its own rows and the run_changes card the host sends
// right after this frame has no row to anchor to.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/turn-end-settled.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { dispatchFrame } from "../ui-src/store/wsHandlers";
import type { HostFrame } from "../ui-src/types/frames";
import type { AssistantItem, OpenSession, ToolItem, UserItem } from "../ui-src/types/session";

const SID = "settled-1";
const PATH = "/tmp/turn-end-settled/session-a.jsonl";

function seedSession(): void {
  const s = {
    sessionId: SID,
    path: PATH,
    items: [
      { role: "user", text: "改一下输入框" },
      { role: "tool", name: "edit", toolCallId: "c1", args: {}, running: true },
    ],
    assistantDraft: "改完了",
    streaming: true,
    turnItemStart: 1,
    turnStartAt: Date.now(),
    workingText: "正在处理…",
    pendingApprovals: [],
  } as unknown as OpenSession;
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s), activePath: PATH }));
}

const settledFrame = (extra: Record<string, unknown>) =>
  dispatchFrame({ type: "event", kind: "turn_end", sessionId: SID, settled: false, ...extra } as unknown as HostFrame);

describe("non-terminal turn_end", () => {
  test("lands the draft and the entryIds, keeps the run open", () => {
    seedSession();
    settledFrame({ userEntryId: "u1", assistantEntryId: "a1" });
    const s = useAppStore.getState().openSessions.get(PATH)!;
    expect(s.streaming).toBe(true); // the continuation still owns the run
    expect(s.workingText).toBe("正在处理…");
    expect(s.assistantDraft).toBe("");
    expect(s.items.at(-1)).toMatchObject({ role: "assistant", text: "改完了", entryId: "a1" });
    expect(s.items.find((it): it is UserItem => it.role === "user")?.entryId).toBe("u1");
    expect(s.items.find((it): it is ToolItem => it.role === "tool")?.running).toBe(false);
    expect(s.turnItemStart).toBe(1); // the fold window stays open for the continuation
  });

  test("the settled output is lifted out of the continuation's seal", () => {
    seedSession();
    settledFrame({ assistantEntryId: "a1", final: true });
    dispatchFrame({ type: "event", kind: "text_delta", sessionId: SID, text: "下一轮回答" } as unknown as HostFrame);
    dispatchFrame({ type: "event", kind: "turn_end", sessionId: SID, runEnd: true, final: true } as unknown as HostFrame);
    const s = useAppStore.getState().openSessions.get(PATH)!;
    // Both outputs stay top-level; without the segment's stop mark the earlier one would fold
    // into the continuation's loop group and its change card would be invisible.
    expect(s.items.filter((it): it is AssistantItem => it.role === "assistant").map((it) => it.entryId)).toEqual([
      "a1",
      undefined,
    ]);
  });

  test("a run_changes frame right after anchors to the settled row", () => {
    seedSession();
    settledFrame({ assistantEntryId: "a1" });
    dispatchFrame({
      type: "event",
      kind: "run_changes",
      sessionId: SID,
      entryId: "a1",
      files: [{ path: "/w/a.ts", added: 3, removed: 1 }],
    } as unknown as HostFrame);
    const s = useAppStore.getState().openSessions.get(PATH)!;
    const row = s.items.find((it): it is AssistantItem => it.role === "assistant" && it.entryId === "a1");
    expect(row?.changes).toHaveLength(1);
  });
});
