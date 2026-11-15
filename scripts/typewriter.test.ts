// Streaming tool bodies reveal at a steady rate instead of jumping in the host/store batch
// (40ms coalesce + 100ms applyDelta window). These are the per-frame reducers the rAF loop calls.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/typewriter.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { nextChars, nextLines } from "../ui-src/components/chat/typewriter";

describe("character reveal", () => {
  test("advances a bounded step per frame while the buffer grows", () => {
    // 320 cps over 16ms ≈ 5 chars
    expect(nextChars("", "0123456789abcdef", 16)).toBe("01234");
    expect(nextChars("01234", "0123456789abcdef", 16)).toBe("0123456789");
  });

  test("catches up once the backlog would trail behind, and clamps a long frame", () => {
    const target = "x".repeat(1000);
    // Large dt must not drain the whole backlog in one frame (tab was backgrounded).
    const step = nextChars("", target, 5000).length;
    expect(step).toBeGreaterThan(5);
    expect(step).toBeLessThan(200);
  });

  test("adopts a rewritten buffer whole instead of retyping it", () => {
    // Reset / truncation: the target is no longer a prefix extension of what is shown.
    expect(nextChars("hello", "world", 16)).toBe("world");
    expect(nextChars("hi", "h", 16)).toBe("h");
  });

  test("is a no-op once caught up", () => {
    expect(nextChars("done", "done", 16)).toBe("done");
  });
});

describe("line reveal", () => {
  test("adds one line per frame", () => {
    expect(nextLines("", "a\nb\nc")).toBe("a");
    expect(nextLines("a", "a\nb\nc")).toBe("a\nb");
  });

  test("batches a long diff instead of spending a frame per line", () => {
    const target = Array.from({ length: 200 }, (_, i) => `+${i}`).join("\n");
    const shown = nextLines("", target).split("\n").length;
    expect(shown).toBeGreaterThan(1);
    expect(shown).toBeLessThan(200);
  });

  test("takes the whole frame when it shrank (host re-sends the diff)", () => {
    expect(nextLines("a\nb\nc", "a\nz")).toBe("a\nz");
  });
});
