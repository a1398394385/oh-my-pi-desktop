// session_unloaded right-slot contract (BUG-137): a session this client still holds OPEN
// (archive / delete) takes its right-panel slot with it on the background branch too, while a
// slot kept only for a session the frontend already LRU-evicted survives — that slot is
// deliberate panel memory (host idle eviction / session switch-back), not a leak.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/session-unload-slot.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { createSmokeWindow } from "./ui-smoke-env";
import type { OpenSession } from "../ui-src/types/session";

createSmokeWindow();
// Dynamic imports are deliberate (the welcome-slot test has the same shape): right.ts reads
// its slot table from localStorage at module scope, so the window has to exist first.
const { useAppStore } = await import("../ui-src/store");
const { openTabInSlot, registerSlotDisposer } = await import("../ui-src/store/right");
const { onMessage } = await import("../ui-src/store/ws");

const openPath = "/proj/bg.jsonl";
const evictedPath = "/proj/evicted.jsonl";

describe("session_unloaded slot", () => {
  test("open background session drops its slot, LRU-evicted one keeps it", () => {
    // openSessions holds only the open one; the other keeps a slot as panel memory, the
    // way frontend LRU eviction leaves it (scheduleEvict drops the entry, not the slot).
    useAppStore.setState({ openSessions: new Map([[openPath, {} as unknown as OpenSession]]), activePath: null });
    openTabInSlot(openPath, "tree");
    openTabInSlot(evictedPath, "tree");
    let openDisposed = 0;
    let evictedDisposed = 0;
    registerSlotDisposer(openPath, () => openDisposed++);
    registerSlotDisposer(evictedPath, () => evictedDisposed++);

    onMessage({ type: "session_unloaded", path: openPath, unloaded: true });
    expect(openDisposed).toBe(1);
    expect(useAppStore.getState().openSessions.has(openPath)).toBe(false);

    // A session this client no longer holds: host-side pool eviction only, slot untouched.
    onMessage({ type: "session_unloaded", path: evictedPath, unloaded: true });
    expect(evictedDisposed).toBe(0);
  });
});
