// Pool-release notification smoke: every path that drops a pooled session must
// also invalidate the frontend slot on EVERY channel (local desktop + remote
// control). A channel left holding the slot keeps the pool UUID that the drop
// just made unresolvable, and its next session-scoped RPC answers
// "errors.session.notFound" while the view keeps a frozen working line — the
// reported "scheduled task errored: <errors.session.notFound>: <pool uuid>".
//
// Coverage:
//   A  broadcastSessionUnloaded: both channels, one frame per path, path +
//      previousPaths deduped
//   B  session_unload (manual eject): both channels get session_unloaded for
//      the entry's moved-from and current path; entry leaves the pool. The
//      requester is not special-cased — it gets the same broadcast, so no
//      duplicate requester-only frame is sent
//   C  delete_session: both channels get session_unloaded for the entry it
//      evicted (requester-only notification was the defect)
//   D  releasePoolForProfileSwitch: every pooled entry's slot is invalidated
//      before the pool empties (previously a silent sessions.clear())
//
// Usage: bun scripts/smoke-pool-unload-notify.ts (profile pinned by smoke-profile).
// The host modules are imported dynamically on purpose: host/bootstrap.ts pins
// its profile at module-evaluation time, so OMP_PROFILE must be set before the
// import runs — a static import would be hoisted above the pin.
import { TEST_PROFILE, activeProfile } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

assert.equal(activeProfile, TEST_PROFILE, "must run on the omp-desktop-test profile, never the default");

const { sessions, H, activeWs, activeRemoteWs, broadcastSessionUnloaded, releasePoolForProfileSwitch } = await import("../host/state.ts");
const { sessionHandlers } = await import("../host/rpc/session.ts");

H.agentDir = getAgentDir();
H.desktopProjectsPath = join(H.agentDir, "omp-desktop.json");

/** Minimal wire shape these assertions read; the host sends far more. */
interface Frame {
  type?: string;
  path?: string;
  unloaded?: boolean;
}

/** Local channel + a distinct remote channel: the frames each one received. */
function channels() {
  const local: Frame[] = [];
  const remote: Frame[] = [];
  activeWs.value = { send: (s: string) => local.push(JSON.parse(s)) };
  activeRemoteWs.value = { send: (s: string) => remote.push(JSON.parse(s)) };
  return { local, remote };
}
const unloadedPaths = (frames: Frame[]) => frames.filter((f) => f.type === "session_unloaded").map((f) => f.path).sort();

/** PoolEntry stand-in: only the fields the release paths touch; the full entry
 *  needs a live AgentSession, which these paths must not depend on. */
function stubEntry(path: string, previousPaths: string[] = []) {
  return {
    path,
    previousPaths,
    activeStartedAt: null,
    mcpMountGen: 0,
    mcpMountInFlight: undefined,
    mcpReleases: [],
    unsubscribe() {},
    session: { dispose: async () => {}, queuedMessageCount: 0 },
  } as unknown as Parameters<typeof sessions.set>[1]; // reason: subset stub above; the release paths only read path/previousPaths/unsubscribe/session.dispose
}

const scratch = join(getAgentDir(), "smoke-pool-notify-tmp");
mkdirSync(scratch, { recursive: true });

try {
  // ---- A: helper fan-out + dedupe.
  {
    const { local, remote } = channels();
    broadcastSessionUnloaded(["/w/a.jsonl", "/w/a.jsonl", "/w/a-moved.jsonl"]);
    assert.deepEqual(unloadedPaths(local), ["/w/a-moved.jsonl", "/w/a.jsonl"], "A: local must get one frame per unique path");
    assert.deepEqual(unloadedPaths(remote), ["/w/a-moved.jsonl", "/w/a.jsonl"], "A: remote must get the same frames");
    assert.ok(local.every((f) => f.unloaded === true), "A: frames carry unloaded:true");
    console.log("A ok: broadcast reaches both channels, one frame per path");
  }

  // ---- B: manual eject invalidates every channel, requester receipt included.
  {
    const { local, remote } = channels();
    const movedTo = join(scratch, "b-new.jsonl");
    const movedFrom = join(scratch, "b-old.jsonl");
    sessions.set("smoke-notify-unload", stubEntry(movedTo, [movedFrom]));
    await sessionHandlers.session_unload({ send: () => {} }, { path: movedFrom });
    assert.equal(sessions.has("smoke-notify-unload"), false, "B: entry must leave the pool");
    assert.deepEqual(unloadedPaths(local), [movedFrom, movedTo].sort(), "B: local must drop the slot for both spellings");
    assert.deepEqual(unloadedPaths(remote), [movedFrom, movedTo].sort(), "B: remote must drop the slot too");
    console.log("B ok: eject invalidates both channels");
  }

  // ---- C: delete_session invalidates every channel.
  {
    const { local, remote } = channels();
    const file = join(scratch, "c-del.jsonl");
    const oldFile = join(scratch, "c-del-old.jsonl");
    writeFileSync(file, "");
    sessions.set("smoke-notify-delete", stubEntry(file, [oldFile]));
    await sessionHandlers.delete_session({ send: () => {} }, { path: file });
    assert.equal(sessions.has("smoke-notify-delete"), false, "C: entry must leave the pool");
    assert.deepEqual(unloadedPaths(local), [file, oldFile].sort(), "C: local must drop the slot");
    assert.deepEqual(unloadedPaths(remote), [file, oldFile].sort(), "C: remote must drop the slot");
    console.log("C ok: delete invalidates both channels");
  }

  // ---- D: profile switch releases the whole pool with a notice per entry.
  {
    const { local, remote } = channels();
    const p1 = join(scratch, "d-1.jsonl");
    const p2 = join(scratch, "d-2.jsonl");
    sessions.set("smoke-notify-p1", stubEntry(p1));
    sessions.set("smoke-notify-p2", stubEntry(p2, [join(scratch, "d-2-old.jsonl")]));
    releasePoolForProfileSwitch();
    assert.equal(sessions.size, 0, "D: pool must be empty after a profile switch");
    assert.deepEqual(unloadedPaths(local), [join(scratch, "d-2-old.jsonl"), p1, p2].sort(), "D: every entry's paths reach local");
    assert.deepEqual(unloadedPaths(remote), unloadedPaths(local), "D: remote gets the same set");
    console.log("D ok: profile switch invalidates every slot before clearing");
  }

  console.log("smoke-pool-unload-notify: all cases passed");
} finally {
  sessions.clear();
  activeWs.value = null;
  activeRemoteWs.value = null;
  rmSync(scratch, { recursive: true, force: true });
}
