// detachEntryUi: the fan-out teardown shared by socket close and the frontend's LRU
// eviction signal (mcp_detach). The last watcher must tear the core subscriptions down
// and restart the idle clock, otherwise sweepIdlePoolSessions keeps skipping the entry
// and the session stays in the pool (and in the sidebar's active-tasks list) forever.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/session-attach-detach.test.ts
import { describe, expect, test } from "bun:test";
import { detachEntryUi } from "../host/session-entry-core.ts";
import type { PoolEntry } from "../host/state.ts";

function fakeEntry() {
  const unsubscribed: string[] = [];
  const views = new Map<{ send(data: string): unknown }, { unsubscribe(): void }>();
  const sockets = new Set<{ send(data: string): unknown }>();
  const ws = () => ({ send: () => undefined });
  const a = ws();
  const b = ws();
  views.set(a, { unsubscribe: () => unsubscribed.push("a") });
  views.set(b, { unsubscribe: () => unsubscribed.push("b") });
  sockets.add(a);
  sockets.add(b);
  const entry = {
    uiSockets: sockets,
    uiSubViews: views,
    unsubscribe: () => unsubscribed.push("core"),
  } as unknown as PoolEntry;
  return { entry, a, b, unsubscribed };
}

describe("detachEntryUi", () => {
  test("one of two watchers leaving keeps the core subscriptions live", () => {
    const { entry, a, b, unsubscribed } = fakeEntry();
    detachEntryUi(a, entry);
    expect(entry.uiSockets.has(a)).toBe(false);
    expect(entry.uiSockets.has(b)).toBe(true);
    expect(unsubscribed).toEqual(["a"]);
    expect(entry.uiSubViews.has(a)).toBe(false);
  });

  test("last watcher leaving tears the core subscriptions down", () => {
    const { entry, a, b, unsubscribed } = fakeEntry();
    detachEntryUi(a, entry);
    detachEntryUi(b, entry);
    expect(unsubscribed).toEqual(["a", "b", "core"]);
    expect(entry.uiSockets.size).toBe(0);
  });

  test("repeat detach of the same socket is a no-op", () => {
    const { entry, a, unsubscribed } = fakeEntry();
    detachEntryUi(a, entry);
    detachEntryUi(a, entry);
    expect(unsubscribed).toEqual(["a"]);
  });
});
