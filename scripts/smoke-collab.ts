// Collab RPC smoke: in-process round-trip of the collab domain handlers at
// module-call depth — pool lookup, role-null state read, relay start against a
// rejected local port (CollabRelayUnavailableError → error frame, no runtime
// left behind), garbage join link (parseCollabLink error), leave cleanup, and
// the guest prompt/abort relay hooks reporting "not a guest". No real relay
// and no real agent session: the pool entry is a minimal fake (a failed
// CollabHost.start only touches crypto + the socket; nothing is persisted and
// no registry publish happens on the failure path).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-collab.ts
import { smokeEnv } from "./smoke-profile.ts";

// The SSOT import above pins this process to the test profile before any host
// module evaluates; smokeEnv() re-affirms the env contract of this run.
if (smokeEnv().OMP_PROFILE !== "omp-desktop-test") throw new Error("smoke must run under omp-desktop-test");

import { sessions, type PoolEntry } from "../host/state.ts";
import { collabHandlers, relayGuestPrompt, relayGuestAbort } from "../host/rpc/collab.ts";
import type { CollabStateFrame } from "../host/wire/frames-live.ts";

let passed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}`, detail ?? "");
  }
}

// Fake UI socket: collects every frame the handlers push at it. Frames are
// narrowed through the collab_state type guard below (the smoke only expects
// that one frame type).
interface FakeWs {
  frames: unknown[];
  send(data: string): void;
}
function fakeWs(): FakeWs {
  const frames: unknown[] = [];
  return { frames, send(data) { frames.push(JSON.parse(data)); } };
}
// Frames this smoke emits are CollabStateFrame by construction; the guard only
// checks the discriminant, then narrows to the named wire type.
function lastCollabState(ws: FakeWs): CollabStateFrame | undefined {
  const f = ws.frames[ws.frames.length - 1];
  if (typeof f !== "object" || f === null || !("type" in f) || f.type !== "collab_state") return undefined;
  return f as CollabStateFrame;
}

const SID = "collab-smoke-session-id";
const requester = fakeWs();
const watcher = fakeWs();
// Minimal PoolEntry: a failed start() touches session.settings (only when no
// explicit relayUrl — we always pass one), sessionManager.getSessionId()
// (CollabHost constructor) and the uiSockets fan-out.
sessions.set(SID, {
  session: {
    settings: {},
    sessionManager: { getSessionId: () => SID, getSessionFile: () => "/tmp/collab-smoke.json", getCwd: () => "/tmp" },
  },
  uiSockets: new Set([watcher]),
} as unknown as PoolEntry);

async function invoke(type: keyof typeof collabHandlers, msg: Record<string, unknown>): Promise<void> {
  await collabHandlers[type](requester as never, { sessionId: SID, ...msg } as never);
}
const timeoutReject = (ms: number, label: string) => {
  const { promise, reject } = Promise.withResolvers<never>();
  setTimeout(() => reject(new Error(label)), ms);
  return promise;
};

// 1. collab_state read before anything: role null, addressed frame
await invoke("collab_state", {});
ok("state before any op → role null", lastCollabState(requester)?.state.role === null, lastCollabState(requester));

// 2. collab_start against a refused port: CollabHost.start rejects
//    (CollabRelayUnavailableError) → error frame, no role, runtime cleaned up
let startError: unknown;
await Promise.race([
  invoke("collab_start", { relayUrl: "ws://127.0.0.1:1" }).catch((err) => { startError = err; }),
  timeoutReject(30_000, "collab_start did not settle within 30s"),
]);
ok("collab_start settles (relay unreachable)", startError === undefined, startError);
const startFrame = lastCollabState(requester);
ok("failed start → collab_state frame with error", typeof startFrame?.error === "string" && startFrame.state.role === null, startFrame);
ok("failed start → no links leaked", !startFrame?.state.link && !startFrame?.state.viewLink, startFrame?.state);

// 3. collab_join with a garbage link: parseCollabLink error → error frame
await invoke("collab_join", { link: "not-a-collab-link" });
const joinFrame = lastCollabState(requester);
ok("garbage join → collab_state frame with error", typeof joinFrame?.error === "string" && joinFrame.state.role === null, joinFrame);

// 4. collab_leave with nothing live: clean role-null reply (no throw)
await invoke("collab_leave", {});
ok("leave with nothing live → role null", lastCollabState(requester)?.state.role === null, lastCollabState(requester));

// 5. state read after the round-trip: still clean
await invoke("collab_state", {});
ok("state after round-trip → role null, no error", lastCollabState(requester)?.state.role === null && !lastCollabState(requester)?.error, lastCollabState(requester));

// 6. Fan-out: the watcher attached to the pool entry received the same pushes
ok("uiSockets fan-out received collab_state frames", watcher.frames.length > 0 && lastCollabState(watcher)?.sessionId === SID, watcher.frames.length);

// 7. Guest relay hooks with no collab runtime: not consumed, local flow continues
ok("guest prompt hook no-op without runtime", relayGuestPrompt(SID, "hi") === false);
ok("guest abort hook no-op without runtime", relayGuestAbort(SID) === false);

// 8. Unknown session: state read still answers role null; ops error cleanly
await collabHandlers.collab_state(requester as never, { sessionId: "nope" } as never);
ok("state on unknown session → role null", lastCollabState(requester)?.state.role === null, lastCollabState(requester));
await collabHandlers.collab_start(requester as never, { sessionId: "nope", relayUrl: "ws://127.0.0.1:1" } as never);
ok("start on unknown session → error frame", typeof lastCollabState(requester)?.error === "string" && lastCollabState(requester)?.state.role === null, lastCollabState(requester));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILED:", failures.join(", "));
  process.exit(1);
}
