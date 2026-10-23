// Welcome (new-task page) right-panel slot contract: the new-task page opens on a clean panel and the
// pseudo-slot never carries session state or reaches localStorage. Session slots keep
// inheriting the live layout (visual continuity) — that half of the contract is asserted here
// too, so a future "clean everything" shortcut cannot silently break session switching.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/right-welcome-slot.test.ts
import { describe, expect, test } from "bun:test";
import { createSmokeWindow } from "./ui-smoke-env";

createSmokeWindow();
// Legacy row written by the buggy build: expanded panel + file tab inherited from a session.
// It must be ignored at load (this is the migration: no separate cleanup pass).
localStorage.setItem("omp-right-slots", JSON.stringify([
  ["welcome", { tabs: ["file"], active: "file", recentClosed: [], selectedFile: "/x.ts", fileView: { path: "/x.ts", text: "x", image: false }, collapsed: false }],
  ["/sess", { tabs: ["gitdiff"], active: "gitdiff", recentClosed: [], selectedFile: null, fileView: null, collapsed: false }],
]));

// Dynamic imports are deliberate (same reason as smoke-right-snapshots.ts): the localStorage
// seed above must land before the store modules load, because right.ts reads the slot table at
// module scope — a static import would hoist above the seed.
const { useAppStore } = await import("../ui-src/store");
const { restoreRightSlot, saveRightSlot } = await import("../ui-src/store/right");

describe("welcome slot", () => {
  test("launch drops the persisted welcome row: new-task page starts clean", () => {
    restoreRightSlot(null);
    const s = useAppStore.getState();
    expect(s.rightTabs).toEqual([]);
    expect(s.rightCollapsed).toBe(true);
  });

  test("session slots still inherit the live layout", () => {
    useAppStore.setState({ rightTabs: ["file"], rightTab: "file", rightCollapsed: false });
    restoreRightSlot("/sess");
    expect(useAppStore.getState().rightTabs).toEqual(["gitdiff"]);
    restoreRightSlot("/brand-new");
    const s = useAppStore.getState();
    expect(s.rightTabs).toEqual(["gitdiff"]);
    expect(s.rightCollapsed).toBe(false);
  });

  test("welcome slot stays runtime-only", () => {
    saveRightSlot(null);
    const keys = (JSON.parse(localStorage.getItem("omp-right-slots")!) as [string, unknown][]).map(([k]) => k);
    expect(keys).not.toContain("welcome");
  });
});
