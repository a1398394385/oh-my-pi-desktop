// Host-authoritative idle settle: the pool snapshot's busy flag is the base's isStreaming, the
// only signal that a run which never sent turn_end(runEnd) (agent_end isTerminal:false — a bg job
// awaiting async delivery) is over. Regression for BUG-120's precondition: the working row, the
// stop button and the sidebar spinner stayed wedged for the whole background window because the
// UI's streaming flag is cleared only by turn_end.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/pool-idle-settle.test.ts
import "./dom-stub";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { landPoolSessions } from "../ui-src/store/session";
import type { OpenSession } from "../ui-src/types/session";

const SID = "pool-idle-1";
const PATH = "/tmp/replay/session-idle.jsonl";
const GRACE = 1500; // IDLE_SETTLE_GRACE_MS in store/session.ts

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function seed(streaming: boolean): void {
  const s = {
    sessionId: SID,
    path: PATH,
    items: [
      { role: "user", text: "跑一下测试" },
      { role: "tool", text: "bash", name: "bash", toolCallId: "t1", running: true },
    ],
    assistantDraft: "半截输出",
    streaming,
    turnItemStart: 1,
    turnStartAt: streaming ? Date.now() : null,
    workingText: streaming ? "工作中" : null,
    pendingApprovals: [],
  } as unknown as OpenSession;
  useAppStore.setState({
    ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    openSessions: new Map([[PATH, s]]),
    activePath: PATH,
    busyPaths: new Set<string>(),
    poolPaths: new Set<string>(),
  });
}

function pool(busy: boolean): void {
  landPoolSessions([{ id: SID, path: PATH, cwd: "/tmp", title: null, busy }]);
}

describe("host idle settle", () => {
  test("an idle host settles a slot whose streaming flag is stuck", () => {
    seed(true);
    pool(false);
    vi.advanceTimersByTime(GRACE + 100);
    const s = useAppStore.getState().openSessions.get(PATH)!;
    expect(s.streaming).toBe(false); // working row / stop button back to idle
    expect(s.workingText).toBeNull();
    const tool = s.items.find((i) => i.role === "tool") as { running?: boolean } | undefined;
    expect(tool?.running).toBe(false); // no eternal spinner on the interrupted tool row
    const tail = s.items[s.items.length - 1];
    expect(tail.role).toBe("assistant"); // produced text kept, not dropped
    expect(tail.text).toBe("半截输出");
  });

  test("a live event frame cancels the settle (the run keeps emitting)", () => {
    seed(true);
    pool(false);
    const { applyEvent } = require("../ui-src/store/session");
    applyEvent({ sessionId: SID, kind: "text_delta", text: "还在写" } as never);
    vi.advanceTimersByTime(GRACE + 100);
    expect(useAppStore.getState().openSessions.get(PATH)!.streaming).toBe(true);
  });

  test("a resumed run (busy=true snapshot) is not settled", () => {
    seed(true);
    pool(false);
    vi.advanceTimersByTime(300);
    pool(true); // async delivery resumed the loop before the grace expired
    vi.advanceTimersByTime(GRACE + 100);
    expect(useAppStore.getState().openSessions.get(PATH)!.streaming).toBe(true);
  });

  test("an already-idle slot is left alone", () => {
    seed(false);
    pool(false);
    vi.advanceTimersByTime(GRACE + 100);
    const s = useAppStore.getState().openSessions.get(PATH)!;
    expect(s.streaming).toBe(false);
    expect(s.items.filter((i) => i.role === "assistant").length).toBe(0); // no phantom row
  });
});
