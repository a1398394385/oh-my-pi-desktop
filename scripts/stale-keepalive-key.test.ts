// Stale keepalive snapshots (BUG-xxx class): keepaliveStatus is keyed by pool UUID, and a
// host reload/rebuild of the same path mints a new UUID. The old key was never removed, so a
// context card opened between the two generations showed the previous entry's probes /
// nextProbeAt (e.g. "5 probes, next 25min") next to the live entry's ("0 probes, next 5min").
// session_created replaces the slot and must drop the replaced entry's key.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/stale-keepalive-key.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { sessionHandlers } from "../ui-src/store/wsHandlers/session";
import type { OpenSession } from "../ui-src/types/session";

const PATH = "/tmp/replay/session-stale-ka.jsonl";

function snapshot(sessionId: string, probes: number) {
  return {
    type: "keepalive_status" as const,
    sessionId,
    enabled: true,
    active: true,
    probes,
    hits: probes,
    misses: 0,
    errors: 0,
    savedUsd: 0,
    spendUsd: 0,
    nextProbeAt: Date.now() + 1_500_000,
  };
}

function seed(oldId: string): void {
  useAppStore.setState({
    ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    activePath: PATH,
    openSessions: new Map([[PATH, { sessionId: oldId, cwd: "/tmp", items: [], subagents: new Map() } as unknown as OpenSession]]),
    keepaliveStatus: {
      [oldId]: snapshot(oldId, 5),
      "other-pool": snapshot("other-pool", 2),
    },
  });
}

describe("session_created drops the replaced pool entry's keepalive key", () => {
  test("old key removed, live slot and unrelated keys kept", () => {
    seed("old-pool");
    sessionHandlers.session_created({
      type: "session_created",
      sessionId: "new-pool",
      path: PATH,
      cwd: "/tmp",
    } as never);
    const st = useAppStore.getState();
    expect(st.openSessions.get(PATH)?.sessionId).toBe("new-pool");
    expect(st.keepaliveStatus["old-pool"]).toBeUndefined();
    expect(st.keepaliveStatus["other-pool"]?.probes).toBe(2);
  });

  test("same pool id (in-place re-announcement) keeps its snapshot", () => {
    seed("same-pool");
    sessionHandlers.session_created({
      type: "session_created",
      sessionId: "same-pool",
      path: PATH,
      cwd: "/tmp",
    } as never);
    expect(useAppStore.getState().keepaliveStatus["same-pool"]?.probes).toBe(5);
  });
});
