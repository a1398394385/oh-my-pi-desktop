// Composer echo for consumed slash commands: `command_output` must land in the
// one-second composer card (commandFlash) and never in the transcript — the
// command card row was removed on purpose (a consumed command is an
// input-level event; it must not push the turn's action bar down either).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/command-flash.test.ts
import "./dom-stub";
import { describe, expect, test, vi } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { dispatchFrame } from "../ui-src/store/wsHandlers";
import type { HostFrame } from "../ui-src/types/frames";
import type { OpenSession } from "../ui-src/types/session";

const SID = "flash-1";
const PATH = "/tmp/flash/session-a.jsonl";

function seedSession(): OpenSession {
  const s: OpenSession = {
    sessionId: SID,
    path: PATH,
    items: [{ role: "user", text: "跑一下命令" }],
    assistantDraft: "",
    streaming: false,
    turnItemStart: null,
    turnStartAt: null,
    workingText: null,
  } as unknown as OpenSession;
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s), activePath: PATH, commandFlash: null }));
  return s;
}

const output = (text: string, command: string) =>
  dispatchFrame({ type: "command_output", sessionId: SID, text, command } as unknown as HostFrame);

describe("slash-command composer echo", () => {
  test("output lands in commandFlash only — no transcript row", () => {
    const s = seedSession();
    const before = s.items.length;
    output("Advisor enabled.", "/advisor on");
    const flash = useAppStore.getState().commandFlash;
    expect(flash).not.toBeNull();
    expect(flash!.sessionId).toBe(SID);
    expect(flash!.command).toBe("/advisor on");
    expect(flash!.text).toBe("Advisor enabled.");
    // The transcript is untouched: no meta row, no command card
    expect(useAppStore.getState().openSessions.get(PATH)!.items.length).toBe(before);
  });

  test("holds 1s, flips out, then unmounts; a second frame restarts the window", () => {
    vi.useFakeTimers();
    try {
      seedSession();
      output("first", "/a");
      const first = useAppStore.getState().commandFlash!;
      expect(first.phase).toBe("in");
      vi.advanceTimersByTime(400);
      output("second", "/b");
      const second = useAppStore.getState().commandFlash!;
      expect(second.seq).toBeGreaterThan(first.seq); // seq is the animation key
      expect(second.text).toBe("second");
      expect(second.phase).toBe("in"); // a new command re-enters, cancelling any pending flip-out
      vi.advanceTimersByTime(900); // 0.9s after the second frame: still held
      expect(useAppStore.getState().commandFlash!.phase).toBe("in");
      vi.advanceTimersByTime(150); // past 1s: the exit flip is armed
      expect(useAppStore.getState().commandFlash!.phase).toBe("out");
      vi.advanceTimersByTime(300); // exit flip done: unmounted
      expect(useAppStore.getState().commandFlash).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
