// A3 smoke: delete_session must honor the pool-entry identity protocol
// (path + previousPaths, see state.ts PoolEntry) and run the full release
// sequence — release MCP, unsubscribe, leave the pool, dispose — matching
// reload_session / session_unload. Single-process bun run importing the host
// module directly (bootstrap runs setProfile before its SDK await-imports,
// so OMP_PROFILE governs the profile).
//
// Coverage:
//   A  delete by a pre-persistence-move path (previousPaths hit) clears the
//      live pool entry, unsubscribes and disposes the AgentSession, and
//      unlinks the requested file
//   B  exact-path hit regression (plain entry, no previousPaths)
//   C  dispose failure does not abort the cleanup and leaves a stderr trace
//   D  an unrelated path must not evict a pooled entry
//   E  a busy entry (in-flight turn) must refuse deletion: error raised, pool
//      entry and file untouched
//   F  previousPaths hit also sweeps pin/archive records holding both the old
//      and the new location of the session
//
// Usage: bun scripts/smoke-delete-session.ts (profile is pinned by smokeEnv, no env needed)
// Must stay above the host/ imports below: importing this module pins
// process.env.OMP_PROFILE, which host/bootstrap.ts reads at evaluation time.
import { activeProfile, TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

// activeProfile (not process.env) because smokeEnv pins the profile for the spawned
// host; this assertion guards the in-process half, which reads getAgentDir() itself.
assert.equal(
  activeProfile,
  TEST_PROFILE,
  "must run on the omp-desktop-test profile, never the default",
);

// Capture stderr so the dispose-failure trace can be asserted; lines are still
// forwarded for human visibility.
const stderrLines: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: any, ...rest: any[]) => {
  stderrLines.push(String(chunk));
  return (origWrite as any)(chunk, ...rest);
}) as typeof process.stderr.write;

const { sessions, H } = await import("../host/state.ts");
const { sessionHandlers } = await import("../host/rpc/session.ts");

// Minimal applyProfile equivalent: the RPC handlers write profile-managed
// files (omp-desktop.json) that only a full host startup would otherwise
// have wired up. All paths stay inside the test profile.
H.agentDir = getAgentDir();
H.desktopProjectsPath = join(H.agentDir, "omp-desktop.json");

// Scratch dir inside the test profile but outside the scanned sessions/
// tree, so listAll (run by handleListSessions at the end of delete_session)
// never parses our stub files.
const scratch = join(getAgentDir(), "smoke-a3-tmp");
mkdirSync(scratch, { recursive: true });

const frames: any[] = [];
const fakeWs = { send: (s: string) => frames.push(JSON.parse(s)) };

interface Counters {
  dispose: number;
  unsubscribe: number;
}
function makeStubEntry(
  path: string,
  previousPaths: string[],
  counters: Counters,
  disposeImpl?: () => Promise<void>,
  busy = false,
) {
  return {
    path,
    previousPaths,
    // sessionBusy contract (host/rpc/session.ts): non-null activeStartedAt =
    // in-flight turn; isStreaming mirrors the AgentSession getter the busy
    // check reconciles against (a stale window with isStreaming=false settles)
    activeStartedAt: busy ? 1 : null,
    mcpMountGen: 0,
    mcpMountInFlight: undefined,
    mcpReleases: [],
    unsubscribe: () => {
      counters.unsubscribe++;
    },
    session: {
      dispose: disposeImpl ?? (async () => {
        counters.dispose++;
      }),
      queuedMessageCount: 0,
      ...(busy ? { isStreaming: true } : {}),
    },
  } as any;
}

try {
  // ---- A: previousPaths hit — delete by the pre-move path clears the live
  // entry and disposes the session (the A3 bug: only entry.path matched, so
  // the entry survived while its file was deleted).
  {
    const movedFrom = join(scratch, "a-old.jsonl");
    const movedTo = join(scratch, "a-new.jsonl");
    writeFileSync(movedFrom, "");
    const counters: Counters = { dispose: 0, unsubscribe: 0 };
    sessions.set("smoke-a3-moved", makeStubEntry(movedTo, [movedFrom], counters));
    await sessionHandlers.delete_session(fakeWs, { path: movedFrom });
    assert.equal(sessions.has("smoke-a3-moved"), false, "A: pool entry must be cleared when deleted via previousPaths");
    assert.equal(counters.unsubscribe, 1, "A: unsubscribe must run once");
    assert.equal(counters.dispose, 1, "A: dispose must run once");
    assert.equal(existsSync(movedFrom), false, "A: requested file must be unlinked");
    console.log("A ok: previousPaths hit clears entry + disposes");
  }

  // ---- B: exact-path hit regression (plain entry).
  {
    const plain = join(scratch, "b-plain.jsonl");
    writeFileSync(plain, "");
    const counters: Counters = { dispose: 0, unsubscribe: 0 };
    sessions.set("smoke-a3-plain", makeStubEntry(plain, [], counters));
    await sessionHandlers.delete_session(fakeWs, { path: plain });
    assert.equal(sessions.has("smoke-a3-plain"), false, "B: pool entry must be cleared on exact-path delete");
    assert.equal(counters.dispose, 1, "B: dispose must run once");
    assert.equal(existsSync(plain), false, "B: file must be unlinked");
    console.log("B ok: exact-path hit regression");
  }

  // ---- C: dispose failure must not abort the cleanup and must leave a
  // stderr trace (no bare catch).
  {
    const boom = join(scratch, "c-boom.jsonl");
    writeFileSync(boom, "");
    const counters: Counters = { dispose: 0, unsubscribe: 0 };
    sessions.set(
      "smoke-a3-boom",
      makeStubEntry(boom, [], counters, async () => {
        counters.dispose++;
        throw new Error("boom-dispose");
      }),
    );
    await sessionHandlers.delete_session(fakeWs, { path: boom });
    assert.equal(sessions.has("smoke-a3-boom"), false, "C: entry must still be cleared when dispose throws");
    assert.equal(existsSync(boom), false, "C: file must still be unlinked when dispose throws");
    assert.ok(
      stderrLines.some((l) => l.includes("delete_session dispose failed")),
      "C: dispose failure must leave a stderr trace",
    );
    console.log("C ok: dispose failure logged, cleanup continues");
  }

  // ---- D: an unrelated path must not evict a pooled entry (match stayed
  // tight while being widened to previousPaths).
  {
    const counters: Counters = { dispose: 0, unsubscribe: 0 };
    sessions.set("smoke-a3-keep", makeStubEntry(join(scratch, "d-keep.jsonl"), [], counters));
    await sessionHandlers.delete_session(fakeWs, { path: join(scratch, "d-unrelated.jsonl") });
    assert.equal(sessions.has("smoke-a3-keep"), true, "D: unrelated path must not evict the entry");
    assert.equal(counters.dispose, 0, "D: unrelated path must not dispose the entry");
    sessions.delete("smoke-a3-keep");
    console.log("D ok: unrelated path does not evict");
  }

  // ---- E: busy rejection — a live entry (in-flight turn) must refuse deletion
  // with an error; pool entry and disk file stay untouched. hostI18n defaults
  // to zh-CN here (initHostI18n is never called), so anchor the deleteBusy key's
  // distinct wording to prove the new key fired (not reload/unload busy).
  {
    const busyFile = join(scratch, "e-busy.jsonl");
    writeFileSync(busyFile, "");
    const counters: Counters = { dispose: 0, unsubscribe: 0 };
    sessions.set("smoke-a3-busy", makeStubEntry(busyFile, [], counters, undefined, true));
    await assert.rejects(
      sessionHandlers.delete_session(fakeWs, { path: busyFile }),
      (err: any) => typeof err?.message === "string" && err.message.includes("先处理再删除"),
      "E: busy session must be refused via errors.session.deleteBusy",
    );
    assert.equal(sessions.has("smoke-a3-busy"), true, "E: busy entry must stay pooled");
    assert.equal(counters.unsubscribe, 0, "E: busy entry must not be unsubscribed");
    assert.equal(counters.dispose, 0, "E: busy entry must not be disposed");
    assert.equal(existsSync(busyFile), true, "E: busy session file must stay untouched");
    sessions.delete("smoke-a3-busy");
    console.log("E ok: busy session refuses deletion, nothing released");
  }

  // ---- F: pin/archive record sweep — after a persistence move the records may
  // hold either the old or the new location; deleting via a previousPaths hit
  // must clear both (④a: the old indexOf(p)-only path left the moved-to record).
  {
    const movedFrom = join(scratch, "f-old.jsonl");
    const movedTo = join(scratch, "f-new.jsonl");
    writeFileSync(movedFrom, "");
    H.desktopProjects.pinnedSessions.push(movedFrom, movedTo);
    H.desktopProjects.archivedSessions.push(movedFrom, movedTo);
    const counters: Counters = { dispose: 0, unsubscribe: 0 };
    sessions.set("smoke-a3-pinmove", makeStubEntry(movedTo, [movedFrom], counters));
    await sessionHandlers.delete_session(fakeWs, { path: movedFrom });
    assert.ok(!H.desktopProjects.pinnedSessions.includes(movedFrom), "F: pre-move pin must be cleared");
    assert.ok(!H.desktopProjects.pinnedSessions.includes(movedTo), "F: post-move pin must be cleared");
    assert.ok(!H.desktopProjects.archivedSessions.includes(movedFrom), "F: pre-move archive must be cleared");
    assert.ok(!H.desktopProjects.archivedSessions.includes(movedTo), "F: post-move archive must be cleared");
    assert.equal(existsSync(movedFrom), false, "F: requested file must be unlinked");
    console.log("F ok: pin/archive records swept across both locations");
  }

  // handleListSessions pushed its refresh frame at the end of every call
  // (since ef2f7a4 it also pushes a pool_sessions snapshot per refresh; the
  // assertion tracks the session_list refresh itself — one per successful
  // delete: A, B, C, F).
  const listFrames = frames.filter((f) => f.type === "session_list");
  assert.ok(listFrames.length >= 4, "delete_session must push session_list refreshes");
  console.log(`smoke-delete-session PASSED (${frames.length} session_list frames)`);
} finally {
  process.stderr.write = origWrite;
  rmSync(scratch, { recursive: true, force: true });
  // Never leak stub entries into the shared pool on failure either.
  for (const id of ["smoke-a3-moved", "smoke-a3-plain", "smoke-a3-boom", "smoke-a3-keep", "smoke-a3-busy", "smoke-a3-pinmove"])
    sessions.delete(id);
}
