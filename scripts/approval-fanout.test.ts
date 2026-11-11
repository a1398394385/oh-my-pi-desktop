// approval_resolved crosses both channels (BUG: the ask/plan/approval card replayed to a
// late-joining remote UI stayed on screen after the desktop answered, and answering it
// failed with "approval request not found" — the receipt only went to the answering socket).
//
// The request frame is per-answerer by design (requestApproval / attachEntryUi replay), so
// the receipt must fan out over the session's uiSockets instead.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/approval-fanout.test.ts
import { describe, expect, test } from "bun:test";
import { pendingApprovals, requestApproval, sessions, settleApprovalResponse, type PoolEntry } from "../host/state.ts";

interface FakeSocket {
  sent: string[];
  send(data: string): void;
  frames(): Record<string, unknown>[];
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
    frames() {
      return sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    },
  };
}

/** The fan-out only reads uiSockets; building a full PoolEntry here would drag the whole
 *  session runtime into the test for no coverage. */
function attachEntry(sessionId: string, sockets: FakeSocket[]): void {
  sessions.set(sessionId, { uiSockets: new Set(sockets) } as unknown as PoolEntry);
}

function resolvedFrames(sock: FakeSocket): Record<string, unknown>[] {
  return sock.frames().filter((f) => f.type === "approval_resolved");
}

describe("approval_resolved fan-out", () => {
  test("answering socket and every attached UI each get exactly one receipt", async () => {
    const desktop = fakeSocket();
    const remote = fakeSocket();
    const stranger = fakeSocket(); // not attached to this session
    attachEntry("probe-approval", [desktop, remote]);
    try {
      const wait = requestApproval(desktop, "probe-approval", "probe", ["ok", "cancel"]);
      const request = desktop.frames().find((f) => f.type === "approval_request");
      expect(request).toBeDefined();
      // attachEntryUi replays the open dialog to a UI that joins mid-wait.
      remote.send(JSON.stringify(request));

      settleApprovalResponse(desktop, { requestId: String(request!.requestId), answer: "ok" });
      await expect(wait).resolves.toBe("ok");

      expect(resolvedFrames(desktop)).toHaveLength(1);
      expect(resolvedFrames(remote)).toHaveLength(1);
      expect(resolvedFrames(remote)[0]!.requestId).toBe(request!.requestId);
      expect(resolvedFrames(stranger)).toHaveLength(0);

      // The stale card used to send a second answer for the same requestId.
      expect(() => settleApprovalResponse(remote, { requestId: String(request!.requestId) })).toThrow();
    } finally {
      pendingApprovals.clear();
      sessions.delete("probe-approval");
    }
  });

  test("a session that left the pool still acks the answering socket", async () => {
    const desktop = fakeSocket();
    try {
      const wait = requestApproval(desktop, "probe-gone", "probe", ["ok"]);
      const request = desktop.frames().find((f) => f.type === "approval_request");
      settleApprovalResponse(desktop, { requestId: String(request!.requestId), answer: "ok" });
      await expect(wait).resolves.toBe("ok");
      expect(resolvedFrames(desktop)).toHaveLength(1);
    } finally {
      pendingApprovals.clear();
    }
  });
});
