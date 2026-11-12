// The status row's icon and thought tail key off a streaming thinking item (liveActivity), so a
// block left streaming past its turn pins the row on the dead "thinking" activity. Two paths used
// to leave one behind: a turn that ends inside the thinking phase (interrupt/error → no closing
// `thinking` frame), and a new thinking phase starting while the previous block never closed.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/thinking-streaming-settle.test.ts --pool=forks --poolOptions.forks.singleFork
import "./dom-stub";
import { describe, expect, test, vi } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { dispatchFrame } from "../ui-src/store/wsHandlers";
import { initI18n } from "../ui-src/i18n";
import type { HostFrame } from "../ui-src/types/frames";
import type { OpenSession } from "../ui-src/types/session";

initI18n("zh-CN");

const SID = "think-settle-1";
const PATH = "/tmp/thinking-settle/session-a.jsonl";

function seed(items: unknown[]): void {
  const s = {
    sessionId: SID,
    path: PATH,
    items,
    assistantDraft: "",
    streaming: true,
    turnItemStart: 0,
    turnStartAt: Date.now(),
    workingText: "思考",
    pendingApprovals: [],
  } as unknown as OpenSession;
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s), activePath: PATH }));
}

const frame = (f: Record<string, unknown>): void => dispatchFrame({ sessionId: SID, ...f } as unknown as HostFrame);

type ThinkRow = { role: string; streaming?: boolean; thinking?: string };

// Turn teardown may fold the run's rows into a loop group, so the thinking block can sit nested.
function thinkingRows(items: unknown[]): ThinkRow[] {
  const out: ThinkRow[] = [];
  for (const it of items as { role: string; items?: unknown[] }[]) {
    if (it.role === "loop" && it.items) out.push(...thinkingRows(it.items));
    else if (it.role === "thinking") out.push(it as ThinkRow);
  }
  return out;
}

describe("streaming thinking blocks settle with the turn", () => {
  test("turn_end closes a thinking block that never got its closing frame", () => {
    seed([{ role: "user", text: "想想" }, { role: "thinking", text: "思考", thinking: "半截想法", streaming: true }]);
    frame({ type: "event", kind: "turn_end", runEnd: true, final: true });
    const blocks = thinkingRows(useAppStore.getState().openSessions.get(PATH)!.items);
    expect(blocks.map((b) => b.streaming)).toEqual([false]);
  });

  test("a new thinking phase closes the stale block instead of stealing its deltas", () => {
    vi.useFakeTimers();
    try {
      seed([{ role: "thinking", text: "思考", thinking: "旧想法", streaming: true }]);
      frame({ type: "event", kind: "thinking", phase: "start" });
      frame({ type: "event", kind: "thinking_delta", text: "新想法" });
      vi.advanceTimersByTime(150);
      const blocks = thinkingRows(useAppStore.getState().openSessions.get(PATH)!.items);
      expect(blocks.map((b) => b.streaming)).toEqual([false, true]);
      expect(blocks[1].thinking).toBe("新想法");
    } finally {
      vi.useRealTimers();
    }
  });
});
