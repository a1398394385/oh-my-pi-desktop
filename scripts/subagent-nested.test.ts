// Nested spawns (a subagent spawning its own subagent) must reach the roster on both paths:
// live frames arrive on the root session's SUBAGENT event bus (children get a fresh eventBus
// but inherit subagentEventBus), and disk replay has to walk the <parent>/<parent>.<child>
// artifact directories. Both used to lose depth 2 silently.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/subagent-nested.test.ts
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubagentView, replaySubagentHistory } from "../host/subagent-view.ts";
import type { PoolEntry } from "../host/state.ts";

interface Frame {
  type: string;
  subagentId?: string;
  name?: string;
  parent?: string;
  status?: string;
}

interface FakeBus {
  on(channel: string, fn: (p: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

function fakeBus(): FakeBus {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  return {
    on: (channel: string, fn: (p: unknown) => void) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);
      return () => {};
    },
    emit: (channel: string, payload: unknown) => {
      for (const fn of handlers.get(channel) ?? []) fn(payload);
    },
  };
}

function view(subagentEventBus: FakeBus | undefined): { frames: Frame[] } {
  const frames: Frame[] = [];
  const ws = { send: (data: string) => frames.push(JSON.parse(data) as Frame) };
  const unsubscribe = () => {};
  const entry = {
    session: { subscribe: () => unsubscribe },
    sessionResult: { subagentEventBus },
  } as unknown as PoolEntry;
  // The root eventBus is a different object: depth-1 frames are emitted on both, grandchildren only on the subagent bus
  createSubagentView(ws, "s1", entry, fakeBus()).unsubscribe();
  return { frames };
}

describe("live nested subagent frames", () => {
  test("a grandchild lifecycle lands on the subagent event bus", () => {
    const subagentBus = fakeBus();
    const { frames } = view(subagentBus);
    // The parent's own task call on the event channel is what names the grandchild's owner
    subagentBus.emit("task:subagent:event", {
      id: "Outer",
      event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "task", args: { tasks: [{ name: "Inner" }] } },
    });
    subagentBus.emit("task:subagent:lifecycle", {
      id: "Outer.Inner",
      agent: "task",
      status: "started",
      parentToolCallId: "call-1",
      index: 0,
    });
    const rows = frames.filter((f) => f.type === "subagent_lifecycle");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subagentId: "Outer.Inner", name: "Inner", parent: "Outer", status: "started" });
  });

  test("without a subagent bus the root bus is still the source", () => {
    const frames: Frame[] = [];
    const ws = { send: (data: string) => frames.push(JSON.parse(data) as Frame) };
    const unsubscribe = () => {};
    const entry = { session: { subscribe: () => unsubscribe }, sessionResult: {} } as unknown as PoolEntry;
    const rootBus = fakeBus();
    createSubagentView(ws, "s1", entry, rootBus).unsubscribe();
    rootBus.emit("task:subagent:lifecycle", { id: "Root", agent: "task", status: "started", index: 0 });
    expect(frames.map((f) => f.subagentId)).toEqual(["Root"]);
  });
});

describe("disk replay of nested transcripts", () => {
  test("grandchild files hang under their parent's display name", () => {
    // Artifact layout: <dir>/root.jsonl with its children under <dir>/root/
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-replay-"));
    const rootFile = path.join(dir, "root.jsonl");
    const rootDir = path.join(dir, "root");
    const childFile = path.join(rootDir, "Outer.jsonl");
    const grandDir = path.join(rootDir, "Outer");
    const grandFile = path.join(grandDir, "Outer.Inner.jsonl");
    fs.mkdirSync(grandDir, { recursive: true });
    const session = (parentSession?: string) =>
      JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z", ...(parentSession ? { parentSession } : {}) });
    fs.writeFileSync(rootFile, session());
    fs.writeFileSync(childFile, `${session(rootFile)}\n`);
    fs.writeFileSync(grandFile, `${session(childFile)}\n`);
    // Past the live-write guard (HIST_SUBAGENT_RECENT_MS): still-open transcripts are skipped
    const past = new Date(Date.now() - 3_600_000);
    for (const f of [childFile, grandFile]) fs.utimesSync(f, past, past);

    const frames: Frame[] = [];
    replaySubagentHistory({ send: (data: string) => frames.push(JSON.parse(data) as Frame) }, rootFile, "s1", false);

    const rows = frames.filter((f) => f.type === "subagent_lifecycle");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === "Outer")).toMatchObject({ parent: "Main" });
    expect(rows.find((r) => r.name === "Outer.Inner")).toMatchObject({ parent: "Outer" });
  });

  test("a same-named foreign transcript outside the parent backlink is ignored", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-foreign-"));
    const rootFile = path.join(dir, "root.jsonl");
    const grandDir = path.join(dir, "root", "Outer");
    const grandFile = path.join(grandDir, "Outer.Inner.jsonl");
    fs.mkdirSync(grandDir, { recursive: true });
    fs.writeFileSync(rootFile, JSON.stringify({ type: "session" }));
    fs.writeFileSync(grandFile, JSON.stringify({ type: "session", parentSession: "/elsewhere/other.jsonl" }));
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(grandFile, past, past);

    const frames: Frame[] = [];
    replaySubagentHistory({ send: (data: string) => frames.push(JSON.parse(data) as Frame) }, rootFile, "s1", false);
    expect(frames).toEqual([]);
  });
});
