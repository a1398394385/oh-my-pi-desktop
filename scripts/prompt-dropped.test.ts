// A prompt cancelled before it reached the agent (Esc racing the prompt RPC's awaits, or the
// base's turn-setup drop hook) used to leave the optimistic bubble on screen while the session
// file never had the message, and to strand the slot's local streaming flag with no turn_end
// coming. The drop frame withdraws the bubble, stops the local run and hands the text back.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/prompt-dropped.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { dispatchFrame } from "../ui-src/store/wsHandlers";
import type { HostFrame } from "../ui-src/types/frames";
import type { OpenSession } from "../ui-src/types/session";

const SID = "drop-1";
const PATH = "/tmp/prompt-dropped/session-a.jsonl";

function seedSession(overrides: Partial<OpenSession> = {}): void {
  const s = {
    sessionId: SID,
    path: PATH,
    items: [{ role: "user", text: "取消我" }],
    assistantDraft: "",
    streaming: true,
    turnItemStart: null,
    turnStartAt: Date.now(),
    workingText: null,
    pendingApprovals: [],
    ...overrides,
  } as unknown as OpenSession;
  useAppStore.setState((st) => ({
    openSessions: new Map(st.openSessions).set(PATH, s),
    activePath: PATH,
    composerSetSignal: null,
  }));
}

const dropFrame = () =>
  dispatchFrame({ type: "prompt_dropped", sessionId: SID, text: "取消我" } as unknown as HostFrame);

describe("prompt dropped before dispatch", () => {
  test("withdraws the optimistic bubble, stops the local run and restores the text", () => {
    seedSession({ items: [{ role: "assistant", text: "旧回复" }, { role: "user", text: "取消我" }] as never });
    dropFrame();
    const s = useAppStore.getState().openSessions.get(PATH)!;
    expect(s.items).toEqual([{ role: "assistant", text: "旧回复" }]);
    expect(s.streaming).toBe(false);
    expect(s.turnStartAt).toBeNull();
    expect(useAppStore.getState().composerSetSignal?.text).toBe("取消我");
  });

  test("a persisted user row with an entryId is never withdrawn", () => {
    seedSession({ items: [{ role: "user", text: "取消我", entryId: "e1" }] as never });
    dropFrame();
    expect(useAppStore.getState().openSessions.get(PATH)!.items).toHaveLength(1);
  });

  test("a host-confirmed run keeps its streaming state", () => {
    seedSession({ turnItemStart: 0 });
    dropFrame();
    expect(useAppStore.getState().openSessions.get(PATH)!.streaming).toBe(true);
  });
});
