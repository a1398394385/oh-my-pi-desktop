// A pooled subagent entry stops accumulating at the last UI detach while the SDK keeps
// appending to the same child transcript file: reopening it pushed a snapshot cut off
// mid-run — the wake-turn prompt and the child's final report were both missing (BUG-111).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/subagent-resync.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resyncSubagentTranscript } from "../host/subagent-view.ts";
import type { PoolEntry } from "../host/state.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-resync-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const header = (id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-27T06:56:43.987Z", cwd: tmp, parentSession: path.join(tmp, "parent.jsonl") });
const user = (id: string, text: string, ts: string) =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: text } });
const assistant = (id: string, text: string, ts: string) =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

// assignment → the run the viewer had seen; then the IRC wake prompt and the final report
const assignment = user("u1", "只审 Spec §1-3", "2026-10-27T06:56:45.000Z");
const midRun = assistant("a1", "继续查证", "2026-10-27T07:38:23.750Z");
const irc = user("u2", "[Wait interrupted by message]\n<irc from=\"parent\" agent=\"Main\">请立即停止扩展调查</irc>", "2026-10-27T07:40:42.406Z");
const report = assistant("a2", "审阅结论：S1 数据源分裂", "2026-10-27T07:41:42.302Z");

function childFile(name: string, lines: string[]): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, [header(name), ...lines].join("\n") + "\n");
  return file;
}

// In-memory index of the pool entry: only what the events carried before the detach
const frozenIndex = (lines: string[]) => lines.map((l) => JSON.parse(l));

function entry(file: string, frozen: unknown[], streaming = false): PoolEntry {
  return {
    path: file,
    isSubagent: true,
    activeMs: 0,
    transcript: [{ role: "loop", text: "", collapsed: true, items: [] }],
    manager: { getEntries: () => frozen },
    session: { isStreaming: streaming },
  } as unknown as PoolEntry;
}

describe("resyncSubagentTranscript", () => {
  test("re-reads the child file when it grew past the in-memory index", async () => {
    const full = [assignment, midRun, irc, report];
    const file = childFile("Child", full);
    const e = entry(file, frozenIndex([assignment, midRun]));

    await resyncSubagentTranscript(e);

    const items = e.transcript as Array<{ role: string; text?: string }>;
    expect(items.map((i) => i.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(items[2].text).toContain("<irc");
    expect(items[3].text).toBe("审阅结论：S1 数据源分裂");
    expect(e.activeMs).toBeGreaterThan(0);
  });

  test("keeps the pool snapshot when the file tail is already indexed", async () => {
    const full = [assignment, midRun, irc, report];
    const file = childFile("SameTail", full);
    const e = entry(file, frozenIndex(full));
    const before = e.transcript;

    await resyncSubagentTranscript(e);

    expect(e.transcript).toBe(before);
  });

  test("never re-reads a still-streaming entry (the live events own the newer state)", async () => {
    const file = childFile("Streaming", [assignment, midRun, irc, report]);
    const e = entry(file, frozenIndex([assignment, midRun]), true);
    const before = e.transcript;

    await resyncSubagentTranscript(e);

    expect(e.transcript).toBe(before);
  });
});
