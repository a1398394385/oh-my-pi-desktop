// Pool busy resync after an interrupt. The sidebar spinner is `streaming ||
// busyPaths`, and busyPaths only changes on a `pool_sessions` frame. The host
// used to publish that frame from agent_start/agent_end alone, while the base's
// isStreaming also covers the prompt-setup window (#promptInFlightCount):
// aborting a prompt that is still in setup clears the flag with no agent event,
// so nothing ever republished busy=false and the row kept spinning on an idle
// session. A direct snapshot taken inside that window was worse than useless:
// it put busy=true on the client while the publish dedupe cache still held the
// pre-run key, so every later lifecycle publish computed an identical key and
// skipped the correction.
//
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/pool-busy-broadcast.test.ts --pool=forks --poolOptions.forks.singleFork
import { TEST_PROFILE, activeProfile } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { test } from "bun:test";

assert.equal(activeProfile, TEST_PROFILE, "must run on the omp-desktop-test profile, never the default");

// Dynamic on purpose: host/bootstrap.ts pins its profile at module evaluation,
// so OMP_PROFILE must be set (by smoke-profile above) before these load.
const { sessions, activeWs, activeRemoteWs, pushPoolSnapshot, pushPromptDropped, handleRunLifecycleEvent } =
  await import("../host/state.ts");
const { sessionHandlers } = await import("../host/rpc/session.ts");
import type { PoolEntry } from "../host/state.ts";

interface StubSession {
  isStreaming: boolean;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}
interface StubEntry {
  path: string;
  cwd: string;
  title: string | null;
  transcript: Array<{ role: string; text: string; entryId?: string }>;
  isSubagent: boolean;
  activeMs: number;
  activeStartedAt: number | null;
  lastActiveAt: number;
  uiSockets: Set<{ send(data: string): unknown }>;
  session: StubSession;
}
interface Frame {
  type?: string;
  ok?: boolean;
  sessions?: Array<{ path: string; busy?: boolean }>;
}

const PATH = "/tmp/pool-busy-broadcast/s1.jsonl";

/** PoolEntry stand-in: only what the abort broadcast and the snapshot read.
 *  `state.streaming` is the mutable switch behind the read-only getter. */
function stubEntry(path: string, streaming: boolean) {
  const state = { streaming };
  const entry: StubEntry = {
    path,
    cwd: "/tmp/pool-busy-broadcast",
    title: null,
    transcript: [],
    isSubagent: false,
    activeMs: 0,
    activeStartedAt: null,
    lastActiveAt: Date.now(),
    uiSockets: new Set(),
    session: {
      get isStreaming() {
        return state.streaming;
      },
      abort: async () => {},
      waitForIdle: async () => {},
      dispose: async () => {},
    },
  };
  return { entry: entry as unknown as PoolEntry, state };
}

function channel() {
  const frames: Frame[] = [];
  return { frames, ws: { send: (data: string) => frames.push(JSON.parse(data) as Frame) } };
}

const lastPool = (frames: Frame[]) => frames.filter((f) => f.type === "pool_sessions").at(-1);
const busyOf = (frame: Frame | undefined, p: string) => frame?.sessions?.find((r) => r.path === p)?.busy;

/** Wire both UI channels to fresh frame logs, run `fn`, then detach them. */
async function withChannels(fn: (local: ReturnType<typeof channel>, remote: ReturnType<typeof channel>) => Promise<void>) {
  const local = channel();
  const remote = channel();
  activeWs.value = local.ws;
  activeRemoteWs.value = remote.ws;
  try {
    await fn(local, remote);
  } finally {
    activeWs.value = null;
    activeRemoteWs.value = null;
  }
}

test("abort_session resyncs the pool on both channels when no agent event fires", async () => {
  await withChannels(async (local, remote) => {
    const { entry, state } = stubEntry(PATH, true);
    sessions.set("s-abort", entry);
    try {
      // What a list refresh showed the client while the base was inside setup.
      pushPoolSnapshot(local.ws);
      assert.equal(busyOf(lastPool(local.frames), PATH), true, "abort 前客户端被置成 busy=true");
      local.frames.length = 0;
      remote.frames.length = 0;
      // abort() drops the setup window silently: no agent_start/agent_end follows.
      state.streaming = false;
      const requested = channel();
      await sessionHandlers.abort_session(requested.ws, { sessionId: "s-abort" });
      assert(
        requested.frames.some((f) => f.type === "session_aborted" && f.ok === true),
        "abort_session 必须回执 session_aborted",
      );
      assert.equal(busyOf(lastPool(local.frames), PATH), false, "abort 之后本地通道必须收到 busy=false 的池快照");
      assert.equal(busyOf(lastPool(remote.frames), PATH), false, "abort 之后远端通道必须收到 busy=false 的池快照");
    } finally {
      sessions.delete("s-abort");
    }
  });
});

test("a dropped prompt republishes the pool by itself", async () => {
  await withChannels(async (local) => {
    const { entry, state } = stubEntry(PATH, true);
    sessions.set("s-drop", entry);
    try {
      entry.transcript.push({ role: "user", text: "hi" });
      entry.uiSockets.add(local.ws); // entryBus(entry) delivers prompt_dropped here
      local.frames.length = 0;
      state.streaming = false; // the base already withdrew the setup window
      pushPromptDropped(entry, "s-drop", "hi");
      assert(
        local.frames.some((f) => f.type === "prompt_dropped"),
        "pushPromptDropped 仍要发 prompt_dropped 帧",
      );
      assert.equal(busyOf(lastPool(local.frames), PATH), false, "prompt 被丢弃后必须广播 busy=false");
    } finally {
      sessions.delete("s-drop");
    }
  });
});

test("a direct snapshot keeps the publish dedupe cache honest", async () => {
  await withChannels(async (local) => {
    // Field sequence: the run's lifecycle publish recorded the empty key, a
    // direct snapshot (list refresh) then put busy=true on the client from
    // inside the setup window, and the abort cleared the flag silently.
    const { entry, state } = stubEntry(PATH, false);
    sessions.set("s-dedupe", entry);
    try {
      handleRunLifecycleEvent(entry, { type: "agent_end" }); // cache = ""
      state.streaming = true;
      pushPoolSnapshot(local.ws); // client now holds busy=true
      state.streaming = false; // abort cleared it silently
      const mark = local.frames.length;
      handleRunLifecycleEvent(entry, { type: "agent_end" }); // next lifecycle publish
      const pushed = local.frames.slice(mark).filter((f) => f.type === "pool_sessions");
      assert(pushed.length > 0, "直接快照写入 busy=true 后，下一次生命周期广播不能被 key 去重吃掉");
      assert.equal(busyOf(pushed.at(-1), PATH), false, "该广播必须把客户端从 busy=true 纠正回 false");
    } finally {
      sessions.delete("s-dedupe");
    }
  });
});
