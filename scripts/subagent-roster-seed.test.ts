// A socket that subscribes mid-run (remote control opened while subagents are out, or a
// frontend reload) never saw the "started" frame, and the disk replay skips a transcript
// still being written — the running subagent's roster row stayed invisible until the run
// ended. createSubagentView seeds those rows from the live registry instead.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/subagent-roster-seed.test.ts
import { describe, expect, test } from "bun:test";
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { createSubagentView } from "../host/subagent-view.ts";
import type { PoolEntry } from "../host/state.ts";

// The registry's own status vocabulary (base AgentProgress, seen through the progress payload
// the host forwards). Seeding keys off it, so the map below must stay exhaustive: a new base
// status becomes a tsc error here instead of a silently unclassified row.
type ProgressStatus = SubagentProgressPayload["progress"]["status"];
type LifecycleStatus = SubagentLifecyclePayload["status"];
const SEEDS_IN_FLIGHT: Record<ProgressStatus, boolean> = {
  pending: true,
  running: true,
  completed: false, // terminal rows come from the disk replay
  failed: false,
  aborted: false,
};

interface Frame {
  type: string;
  subagentId?: string;
  status?: LifecycleStatus;
  name?: string;
  sessionFile?: string;
  registeredAt?: number;
}

function attach(snapshots: unknown[]): Frame[] {
  const frames: Frame[] = [];
  const ws = { send: (data: string) => frames.push(JSON.parse(data) as Frame) };
  const unsubscribe = () => {};
  const entry = {
    session: { subscribe: () => unsubscribe },
    // The roster subscribes the root session's observability bus when the SDK exposes one
    sessionResult: {},
    subagentRegistry: { getSubagents: () => snapshots },
  } as unknown as PoolEntry;
  const eventBus = { on: () => unsubscribe };
  createSubagentView(ws, "s1", entry, eventBus).unsubscribe();
  return frames;
}

const snapshot = (over: { id?: string; status?: ProgressStatus } = {}) => ({
  id: "sa1",
  index: 0,
  agent: "scout",
  description: "勘察 skill 重构",
  status: "running",
  sessionFile: "/tmp/parent/CoreSkillFlow.jsonl",
  progress: { index: 0, durationMs: 12_000 },
  ...over,
});

describe("subagent roster seeding on attach", () => {
  test("a mid-run subscriber gets the in-flight subagent as a started row", () => {
    const frames = attach([snapshot()]);
    expect(frames).toHaveLength(1);
    const [row] = frames;
    expect(row.type).toBe("subagent_lifecycle");
    expect(row.subagentId).toBe("sa1");
    expect(row.status).toBe("started");
    expect(row.name).toBe("scout");
    expect(row.sessionFile).toBe("/tmp/parent/CoreSkillFlow.jsonl");
    // Elapsed keeps counting from the real start, not from the attach
    expect(Date.now() - (row.registeredAt ?? 0)).toBeGreaterThanOrEqual(12_000);
  });

  test("only in-flight statuses seed a started row; terminal ones wait for the disk replay", () => {
    for (const [status, inFlight] of Object.entries(SEEDS_IN_FLIGHT) as [ProgressStatus, boolean][]) {
      const rows = attach([snapshot({ status })]);
      expect({ status, seeded: rows.length }).toEqual({ status, seeded: inFlight ? 1 : 0 });
      if (inFlight) expect(rows[0].status).toBe("started");
    }
  });

  test("terminal rows of every kind stay unseeded in one batch", () => {
    expect(
      attach([snapshot({ status: "completed" }), snapshot({ id: "sa2", status: "failed" }), snapshot({ id: "sa3", status: "aborted" })]),
    ).toEqual([]);
  });

  test("no registry (rebuilt session) seeds nothing", () => {
    expect(attach([])).toEqual([]);
  });
});
