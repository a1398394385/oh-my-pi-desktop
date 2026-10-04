import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { translateEvent, entriesToTranscript } from "../host/translate.ts";
import type { PoolEntry } from "../host/state.ts";

describe("translate.ts write and edit diff generation", () => {
  test("generates scoped diff for write tool modifying existing file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-write-test-"));
    const file = path.join(tmp, "test.txt");
    fs.writeFileSync(file, "line 1\nline 2\nline 3\nline 4\nline 5\n", "utf8");

    const entry = {
      cwd: tmp,
      transcript: [],
      assistantDraft: "",
    } as unknown as PoolEntry;

    // tool_execution_start
    const startEv = {
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        path: "test.txt",
      },
    };
    translateEvent(startEv, entry);

    // Now disk file is overwritten
    fs.writeFileSync(file, "line 1\nline 2\nline 3 modified\nline 4\nline 5\n", "utf8");

    // tool_execution_end
    const endEv = {
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        path: "test.txt",
        content: "line 1\nline 2\nline 3 modified\nline 4\nline 5\n",
      },
      result: {
        content: [{ type: "text", text: "Successfully wrote" }],
        details: { resolvedPath: file },
      },
    };
    const update = translateEvent(endEv, entry);

    expect(update?.kind).toBe("tool_update");
    if (update?.kind === "tool_update") {
      expect(update.added).toBe(1);
      expect(update.removed).toBe(1);
      expect(typeof update.diffContent).toBe("string");
      expect(update.diffContent).toContain("-3|line 3");
      expect(update.diffContent).toContain("+3|line 3 modified");
      // Must not contain unaffected lines beyond context
      expect(update.diffContent?.split("\n").length).toBeLessThan(7);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("preserves diffContent and details on multi-file perFileResults", () => {
    const entry = {
      cwd: "/tmp",
      transcript: [],
      assistantDraft: "",
    } as unknown as PoolEntry;

    const startEv = {
      type: "tool_execution_start",
      toolName: "edit",
      toolCallId: "call_edit_multi",
      args: { input: "patch input" },
    };
    translateEvent(startEv, entry);

    const endEv = {
      type: "tool_execution_end",
      toolName: "edit",
      toolCallId: "call_edit_multi",
      args: { input: "patch input" },
      result: {
        details: {
          diff: " 1|a\n+2|a2\n 1|b\n-2|b1\n+2|b2",
          perFileResults: [
            { path: "a.ts", diff: " 1|a\n+2|a2" },
            { path: "b.ts", diff: " 1|b\n-2|b1\n+2|b2" },
          ],
        },
      },
    };
    const update = translateEvent(endEv, entry);
    expect(update?.kind).toBe("tool_update");
    if (update?.kind === "tool_update") {
      expect(update.diffContent).toBe(" 1|a\n+2|a2\n 1|b\n-2|b1\n+2|b2");
      expect(Array.isArray((update.details as any)?.perFileResults)).toBe(true);
    }
  });

  test("entriesToTranscript reconstructs diff for subsequent writes of same file", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: "do something",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_w1",
              name: "write",
              arguments: { path: "foo.txt", content: "hello world\nline 2\n" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_w1",
          toolName: "write",
          details: { resolvedPath: "/tmp/foo.txt" },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_w2",
              name: "write",
              arguments: { path: "foo.txt", content: "hello beautiful world\nline 2\n" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_w2",
          toolName: "write",
          details: { resolvedPath: "/tmp/foo.txt" },
        },
      },
    ];

    const transcript = entriesToTranscript(entries);
    // Find the loop group or items
    const items = transcript.flatMap((t) => t.items ?? [t]);
    const w2 = items.find((t) => t.toolCallId === "call_w2");
    expect(w2).toBeDefined();
    expect(w2?.diffContent).toBeDefined();
    expect(w2?.diffContent).toContain("-1|hello world");
    expect(w2?.diffContent).toContain("+1|hello beautiful world");
    expect(w2?.added).toBe(1);
    expect(w2?.removed).toBe(1);
  });

  test("parseDiff handles bare @@ hunks and line-number diffs", async () => {
    const { parseDiff } = await import("../ui-src/components/diff/LightweightDiff.tsx");
    // Bare @@ hunk
    const resBare = parseDiff("@@\n-old\n+new\n context");
    expect(resBare.rows.length).toBe(3);
    expect(resBare.rows[0]).toMatchObject({ kind: "removed", text: "old", no: 1 });
    expect(resBare.rows[1]).toMatchObject({ kind: "added", text: "new", no: 1 });
    expect(resBare.rows[2]).toMatchObject({ kind: "context", text: "context" });

    // Line number diff
    const resLn = parseDiff(" 10|ctx\n-11|old\n+11|new");
    expect(resLn.rows.length).toBe(3);
    expect(resLn.rows[0]).toMatchObject({ kind: "context", text: "ctx", no: 10 });
    expect(resLn.rows[1]).toMatchObject({ kind: "removed", text: "old", no: 11 });
    expect(resLn.rows[2]).toMatchObject({ kind: "added", text: "new", no: 11 });
  });
});
