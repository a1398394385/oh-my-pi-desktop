// Subagent status had two parallel hand-written tables (sort weight, display group) over the
// same literals, and every consumer patched misses with `?? "running"`: a status this UI does
// not know (a newer base state, e.g. "paused") rendered as a Running pill and sorted last.
// One table now answers both questions; unknown values get their own group and a tail order.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/subagent-status-table.test.ts
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import type { SubagentState } from "../ui-src/types/session";

const win = new Window({ url: "http://localhost/?preview=1" });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  localStorage: win.localStorage,
  navigator: win.navigator,
  location: win.location,
  matchMedia: ((q: string) => ({
    matches: false,
    media: q,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as never,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

// Dynamic: the store reads window at module scope, so the happy-dom globals above must exist first.
const { stInfo, subStatus, stKeyOf, stLabel } = await import("../ui-src/components/shared/agent/subShared");
const { buildRows } = await import("../ui-src/components/shared/agent/subRoster");

const sub = (status: string, over: Partial<SubagentState> = {}): SubagentState => ({
  agent: "scout",
  description: status,
  status,
  text: "",
  tools: [],
  streaming: false,
  ...over,
});

describe("subagent status table", () => {
  test("an unknown status is never reported as running", () => {
    const info = stInfo("paused");
    expect(info.group).not.toBe("running");
    expect(info.group).toBe("unknown");
    expect(stKeyOf("paused")).toBe("paused");
    expect(stLabel("paused", (k) => k)).toBe("paused");
  });

  test("an unknown status sorts after every known status", () => {
    const unknown = stInfo("paused").order;
    for (const st of ["started", "pending", "running", "completed", "failed", "aborted"]) {
      expect(unknown).toBeGreaterThan(stInfo(st).order);
    }
  });

  test("both base vocabularies resolve to a known group", () => {
    // lifecycle frames: started|completed|failed|aborted, progress frames: pending|running|completed|failed|aborted
    for (const st of ["started", "completed", "failed", "aborted", "pending", "running"]) {
      expect(stInfo(st).group).not.toBe("unknown");
    }
  });

  test("pending is a running-phase row, not a tail-order one", () => {
    expect(stInfo("pending").group).toBe("running");
    expect(stInfo("pending").order).toBe(stInfo("running").order);
  });

  test("streaming beats the stored status", () => {
    expect(subStatus(sub("completed", { streaming: true }))).toBe("running");
    expect(stInfo(subStatus(sub("completed", { streaming: true }))).group).toBe("running");
  });

  test("roster rows order running, then terminal states, then unknown", () => {
    const rows = buildRows([
      ["u", sub("paused")],
      ["a", sub("aborted")],
      ["c", sub("completed")],
      ["r", sub("running")],
    ]);
    expect(rows.map((r) => r.id)).toEqual(["r", "c", "a", "u"]);
  });
});
