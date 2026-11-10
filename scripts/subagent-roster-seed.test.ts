// A socket that subscribes mid-run (remote control opened while subagents are out, or a
// frontend reload) never saw the "started" frame, and the disk replay skips a transcript
// still being written — the running subagent's roster row stayed invisible until the run
// ended. createSubagentView seeds those rows from the live registry instead.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/subagent-roster-seed.test.ts
import { describe, expect, test } from "bun:test";
import { createSubagentView } from "../host/subagent-view.ts";
import type { PoolEntry } from "../host/state.ts";

interface Frame {
  type: string;
  subagentId?: string;
  status?: string;
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
    subagentRegistry: { getSubagents: () => snapshots },
  } as unknown as PoolEntry;
  const eventBus = { on: () => unsubscribe };
  createSubagentView(ws, "s1", entry, eventBus).unsubscribe();
  return frames;
}

const snapshot = (over: Record<string, unknown>) => ({
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
    const frames = attach([snapshot({})]);
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

  test("pending counts as in flight too", () => {
    expect(attach([snapshot({ status: "pending" })]).map((r) => r.status)).toEqual(["started"]);
  });

  test("finished subagents are left to the disk replay", () => {
    expect(attach([snapshot({ status: "completed" }), snapshot({ id: "sa2", status: "failed" })])).toEqual([]);
  });

  test("no registry (rebuilt session) seeds nothing", () => {
    expect(attach([])).toEqual([]);
  });
});
