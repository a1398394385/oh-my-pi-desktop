// Run: OMP_PROFILE=omp-desktop-test bun test scripts/run-changes.test.ts --pool=forks --poolOptions.forks.singleFork
// Run-scoped file-change tracking + revert: net-change filtering, snapshot persistence,
// top-of-stack enforcement, after-content guard, chained undo, journal replay.
import { describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { trackRunToolStart, trackRunToolEnd, finalizeRunChanges, revertRunFile, runFileDiff, readRunChanges, settleRunChanges } from "../host/run-changes.ts";
import { entriesToTranscript } from "../host/translate-history.ts";
import { translateEvent } from "../host/translate.ts";
import type { RunChangeFile } from "../host/wire/payloads.ts";
import type { PoolEntry } from "../host/state.ts";

type Emitted = { anchor: string; files: RunChangeFile[] };
type JournalEntry = { type: string; customType?: string; data?: unknown; id?: string };

function fakeEntry(cwd: string) {
  const entries: JournalEntry[] = [];
  let seq = 0;
  // Test double for PoolEntry: the tracker only reads cwd/path/manager.
  const entry = {
    cwd,
    path: path.join(cwd, "session.jsonl"),
    manager: {
      getEntries: () => entries,
      getArtifactsDir: () => path.join(cwd, "artifacts"),
      appendCustomEntry(customType: string, data: unknown) {
        const id = `c${++seq}`;
        entries.push({ type: "custom", customType, data, id });
        return id;
      },
    },
  } as unknown as PoolEntry;
  return { entry, entries };
}

async function settle() {
  // Let the tracker's async pre/post-reads land: spin event-loop turns (no wall-clock wait,
  // same pattern as translate-diff.test.ts) before the simulated tool write / finalize.
  for (let i = 0; i < 100; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "rchg-"));
}

describe("run-changes tracking + revert", () => {
  test("write creates a file: created flag, snapshot, revert deletes it", async () => {
    const cwd = await tmpdir();
    const { entry, entries } = fakeEntry(cwd);
    const abs = path.join(cwd, "a.txt");
    trackRunToolStart(entry, "write", { path: abs, content: "hello\nworld\n" });
    await settle();
    await fsp.writeFile(abs, "hello\nworld\n");
    trackRunToolEnd(entry, "write", { path: abs, content: "hello\nworld\n" }, {}, false, { added: 2, removed: 0 });
    const emitted: Emitted[] = [];
    await finalizeRunChanges(entry, "anchor1", (anchor, files) => emitted.push({ anchor, files }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].anchor).toBe("anchor1");
    expect(emitted[0].files).toHaveLength(1);
    const f = emitted[0].files[0];
    expect(f.path).toBe(abs);
    expect(f.created).toBe(true);
    expect(f.added).toBe(2);
    expect(f.noSnapshot).toBeUndefined();
    expect(readRunChanges(entries)[0].files[0].created).toBe(true);

    await revertRunFile(entry, "anchor1", abs);
    await expect(fsp.stat(abs)).rejects.toThrow();
    expect(readRunChanges(entries)[0].files[0].reverted).toBe(true);
  });

  test("edit uses the tool's oldText/newText; revert restores the old content", async () => {
    const cwd = await tmpdir();
    const { entry } = fakeEntry(cwd);
    const abs = path.join(cwd, "b.txt");
    await fsp.writeFile(abs, "old\n");
    trackRunToolStart(entry, "edit", { path: abs, oldText: "old", newText: "new" });
    await settle();
    await fsp.writeFile(abs, "new\n");
    trackRunToolEnd(entry, "edit", { path: abs }, { details: { oldText: "old\n", newText: "new\n" } }, false);
    const emitted: Emitted[] = [];
    await finalizeRunChanges(entry, "anchor2", (anchor, files) => emitted.push({ anchor, files }));
    expect(emitted[0].files[0].added).toBe(1);
    expect(emitted[0].files[0].removed).toBe(1);
    const diff = await runFileDiff(entry, "anchor2", abs);
    expect(diff).toContain("-1|old");
    expect(diff).toContain("+1|new");

    await revertRunFile(entry, "anchor2", abs);
    expect(await fsp.readFile(abs, "utf8")).toBe("old\n");
  });

  test("only the last run may revert a file; chained undo pops the stack", async () => {
    const cwd = await tmpdir();
    const { entry } = fakeEntry(cwd);
    const abs = path.join(cwd, "c.txt");
    await fsp.writeFile(abs, "v0\n");
    // run 1: v0 -> v1
    trackRunToolStart(entry, "edit", { path: abs });
    await settle();
    await fsp.writeFile(abs, "v1\n");
    trackRunToolEnd(entry, "edit", { path: abs }, { details: { oldText: "v0\n", newText: "v1\n" } }, false);
    await finalizeRunChanges(entry, "r1", () => {});
    // run 2: v1 -> v2
    trackRunToolStart(entry, "edit", { path: abs });
    await settle();
    await fsp.writeFile(abs, "v2\n");
    trackRunToolEnd(entry, "edit", { path: abs }, { details: { oldText: "v1\n", newText: "v2\n" } }, false);
    await finalizeRunChanges(entry, "r2", () => {});

    await expect(revertRunFile(entry, "r1", abs)).rejects.toThrow(/last|最后/);
    await revertRunFile(entry, "r2", abs);
    expect(await fsp.readFile(abs, "utf8")).toBe("v1\n");
    await revertRunFile(entry, "r1", abs); // r1 is the top of the stack again
    expect(await fsp.readFile(abs, "utf8")).toBe("v0\n");
    await expect(revertRunFile(entry, "r1", abs)).rejects.toThrow(/already|已/);
  });

  test("after-content guard: external modification fails closed", async () => {
    const cwd = await tmpdir();
    const { entry } = fakeEntry(cwd);
    const abs = path.join(cwd, "d.txt");
    await fsp.writeFile(abs, "old\n");
    trackRunToolStart(entry, "edit", { path: abs });
    await settle();
    await fsp.writeFile(abs, "new\n");
    trackRunToolEnd(entry, "edit", { path: abs }, { details: { oldText: "old\n", newText: "new\n" } }, false);
    await finalizeRunChanges(entry, "r1", () => {});
    await fsp.writeFile(abs, "user edit\n");
    await expect(revertRunFile(entry, "r1", abs)).rejects.toThrow(/modified|改动/);
    expect(await fsp.readFile(abs, "utf8")).toBe("user edit\n");
  });

  test("no-net-change runs persist nothing and emit nothing", async () => {
    const cwd = await tmpdir();
    const { entry, entries } = fakeEntry(cwd);
    const abs = path.join(cwd, "e.txt");
    await fsp.writeFile(abs, "same\n");
    trackRunToolStart(entry, "edit", { path: abs });
    await settle();
    trackRunToolEnd(entry, "edit", { path: abs }, { details: { oldText: "same\n", newText: "same\n" } }, false);
    const emitted: Emitted[] = [];
    await finalizeRunChanges(entry, "r1", (anchor, files) => emitted.push({ anchor, files }));
    expect(emitted).toHaveLength(0);
    expect(readRunChanges(entries)).toHaveLength(0);
  });

  test("two writes in one run keep the first before and net stats", async () => {
    const cwd = await tmpdir();
    const { entry } = fakeEntry(cwd);
    const abs = path.join(cwd, "f.txt");
    await fsp.writeFile(abs, "a\n");
    trackRunToolStart(entry, "write", { path: abs, content: "a\nb\n" });
    await settle();
    await fsp.writeFile(abs, "a\nb\n");
    trackRunToolEnd(entry, "write", { path: abs, content: "a\nb\n" }, {}, false, { added: 1, removed: 0 });
    // Second write in the same run: its pre-read must not replace the run's first before
    trackRunToolStart(entry, "write", { path: abs, content: "a\nc\n" });
    await settle();
    await fsp.writeFile(abs, "a\nc\n");
    trackRunToolEnd(entry, "write", { path: abs, content: "a\nc\n" }, {}, false, { added: 1, removed: 1 });
    const emitted: Emitted[] = [];
    await finalizeRunChanges(entry, "r1", (anchor, files) => emitted.push({ anchor, files }));
    expect(emitted[0].files).toHaveLength(1);
    expect(emitted[0].files[0].added).toBe(1); // net a -> a+c: one added line, not 1+1
    expect(emitted[0].files[0].removed).toBe(0);
    await revertRunFile(entry, "r1", abs);
    expect(await fsp.readFile(abs, "utf8")).toBe("a\n");
  });

  test("history replay reattaches changes to the anchor assistant row", () => {
    const msg = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role, timestamp: 0, content: [{ type: "text", text }], ...extra },
    });
    const entries = [
      msg("u1", "user", "改个文件"),
      msg("a1", "assistant", "已修改", { stopReason: "stop" }),
      {
        type: "custom",
        customType: "desktopRunChanges",
        id: "c1",
        data: { changeId: "chg1", anchor: "a1", files: [{ path: "/tmp/x.txt", added: 2, removed: 0, created: true }] },
      },
      { type: "custom", customType: "desktopRunRevert", id: "c2", data: { changeId: "chg1", path: "/tmp/x.txt" } },
    ];
    const out = entriesToTranscript(entries);
    const anchor = out.find((it) => it.role === "assistant" && it.entryId === "a1");
    expect(anchor?.changes).toHaveLength(1);
    expect(anchor?.changes?.[0].path).toBe("/tmp/x.txt");
    expect(anchor?.changes?.[0].reverted).toBe(true);
    expect(anchor?.changes?.[0]).not.toHaveProperty("idx"); // host-side snapshot addressing stays off the wire
  });

  test("live flow: translateEvent + settleRunChanges emits run_changes to attached sockets", async () => {
    const cwd = await tmpdir();
    const { entry, entries } = fakeEntry(cwd);
    const abs = path.join(cwd, "live.txt");
    const sent: Array<Record<string, unknown>> = [];
    const { promise: gotFrame, resolve: frameArrived } = Promise.withResolvers<void>();
    Object.assign(entry, {
      transcript: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "working" },
      ],
      assistantDraft: "",
      thinkingDraft: "",
      thinkingStartedAt: null,
      uiSockets: new Set([
        {
          send(data: string) {
            sent.push(JSON.parse(data));
            if (sent.some((f) => f.kind === "run_changes")) frameArrived();
          },
        },
      ]),
    });
    entries.push(
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", id: "a1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "working" }] } },
    );
    translateEvent({ type: "tool_execution_start", toolName: "write", toolCallId: "t1", args: { path: abs, content: "x\n" } }, entry);
    await settle();
    await fsp.writeFile(abs, "x\n");
    translateEvent({ type: "tool_execution_end", toolName: "write", toolCallId: "t1", args: { path: abs, content: "x\n" }, result: {} }, entry);
    const frame = translateEvent({ type: "agent_end", isTerminal: true, messages: [] }, entry);
    expect(frame).toMatchObject({ kind: "turn_end", runEnd: true, assistantEntryId: "a1" });
    settleRunChanges(entry, "sid");
    await gotFrame;
    const rc = sent.find((f) => f.kind === "run_changes") as { entryId?: string; files?: RunChangeFile[] };
    expect(rc.entryId).toBe("a1"); // anchored to the run-tail assistant entry backfilled by agent_end
    expect(rc.files?.[0].path).toBe(abs);
    expect(rc.files?.[0].created).toBe(true);
  });
});
