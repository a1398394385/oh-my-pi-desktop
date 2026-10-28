// Abort receipt vs. a wedged run: host acks `abort_session` before the base emits turn_end,
// so a run stuck in a provider request would leave the working row counting and the tool
// spinners turning forever. The receipt must settle the visible state on its own, while a
// real turn_end landing first must win (no duplicated draft row).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/abort-settle.test.ts
import "./dom-stub";
import { describe, expect, test, vi } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { dispatchFrame } from "../ui-src/store/wsHandlers";
import type { HostFrame } from "../ui-src/types/frames";
import type { OpenSession } from "../ui-src/types/session";

const SID = "abort-1";
const PATH = "/tmp/abort-settle/session-a.jsonl";

function seedSession(overrides: Partial<OpenSession> = {}): void {
  const s = {
    sessionId: SID,
    path: PATH,
    items: [
      { role: "user", text: "跑个长任务" },
      { role: "tool", name: "bash", toolCallId: "c1", args: {}, running: true },
    ],
    assistantDraft: "半截输出",
    streaming: true,
    turnItemStart: 1,
    turnStartAt: Date.now() - 47 * 60 * 1000,
    workingText: "正在处理…",
    pendingApprovals: [{ id: "ap1" }],
    ...overrides,
  } as unknown as OpenSession;
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s), activePath: PATH }));
}

const abortFrame = () => dispatchFrame({ type: "session_aborted", sessionId: SID, ok: true } as unknown as HostFrame);

describe("abort receipt settles a wedged run", () => {
  test("no turn_end: streaming stops, draft lands as a row, tools stop spinning", () => {
    vi.useFakeTimers();
    try {
      seedSession();
      abortFrame();
      // Still running inside the grace window: a late turn_end may still arrive
      expect(useAppStore.getState().openSessions.get(PATH)!.streaming).toBe(true);
      vi.advanceTimersByTime(2100);
      const s = useAppStore.getState().openSessions.get(PATH)!;
      expect(s.streaming).toBe(false);
      expect(s.assistantDraft).toBe("");
      expect(s.workingText).toBeNull();
      expect(s.pendingApprovals).toEqual([]);
      expect(s.items.at(-1)).toMatchObject({ role: "assistant", text: "半截输出" });
      const tool = s.items.find((it) => it.role === "tool") as { running: boolean };
      expect(tool.running).toBe(false);
      // turnItemStart is preserved so a late turn_end still seals the run
      expect(s.turnItemStart).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("turn_end first: the fallback is a no-op (draft not duplicated)", () => {
    vi.useFakeTimers();
    try {
      seedSession();
      abortFrame();
      dispatchFrame({ type: "event", kind: "turn_end", sessionId: SID, runEnd: true, final: true } as unknown as HostFrame);
      const afterTurnEnd = useAppStore.getState().openSessions.get(PATH)!;
      const count = afterTurnEnd.items.length;
      vi.advanceTimersByTime(2100);
      const s = useAppStore.getState().openSessions.get(PATH)!;
      expect(s.items.length).toBe(count);
      expect(s.assistantDraft).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  test("session already closed: the fallback is silent", () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({ openSessions: new Map(), activePath: null });
      abortFrame();
      expect(() => vi.advanceTimersByTime(2100)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
