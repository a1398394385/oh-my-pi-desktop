// Live tool bodies (TUI parity): while the model still streams a call's arguments the host
// forwards the file body as `tool_args` suffix frames, the store grows the row from them, and
// the `tool` frame upgrades that same row instead of adding a second one.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/write-stream.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { createSmokeWindow } from "./ui-smoke-env.ts";
import type { ChatItem, OpenSession, ToolItem } from "../ui-src/types/session";

createSmokeWindow();
// happy-dom globals must exist before the store modules evaluate, so these imports cannot be
// static (same pattern as out-replies.test.ts)
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session");
const { translateEvent } = await import("../host/translate.ts");
const { createDeltaCoalescer } = await import("../host/delta-coalesce.ts");
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { renderItems } = await import("../ui-src/components/chat/items");

const ENTRY = { transcript: [], cwd: "/tmp" } as never;

/** One streamed argument chunk: the partial message carries the call block the host reads. */
function chunk(id: string, name: string, delta: string) {
  return translateEvent(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta,
        partial: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
      },
    },
    ENTRY,
  );
}

describe("streamed write body → tool_args frames", () => {
  test("suffix frames concatenate back into the file body", () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i} of the streamed file`).join("\n");
    const raw = JSON.stringify({ path: "notes.md", content });
    const frames = [];
    // >256 bytes per chunk: the parse throttle only re-parses once the buffer grew enough
    for (let i = 0; i < raw.length; i += 320) {
      const ev = chunk("w-stream-1", "write", raw.slice(i, i + 320));
      if (ev) frames.push(ev);
    }
    const joined = frames.map((f) => (f.kind === "tool_args" ? f.text : "")).join("");
    expect(joined).toBe(content);
    expect(frames[0]?.kind).toBe("tool_args");
    if (frames[0]?.kind !== "tool_args") throw new Error("expected tool_args");
    expect(frames[0].name).toBe("write");
    expect(frames[0].path).toBe("notes.md");
    // Only the first frame carries the path; repeats would be per-frame overhead
    expect(frames.at(-1)).toMatchObject({ kind: "tool_args", toolCallId: "w-stream-1" });
  });

  test("other tools and malformed blocks stay untranslated", () => {
    expect(chunk("w-stream-2", "edit", '{"path":"a.ts","content":"x"}')).toBeNull();
    expect(chunk("w-stream-2", "write", "")).toBeNull();
  });

  test("a finished body stops emitting frames", () => {
    const raw = JSON.stringify({ path: "a.ts", content: "abc" });
    expect(chunk("w-stream-3", "write", raw)?.kind).toBe("tool_args");
    expect(chunk("w-stream-3", "write", "")).toBeNull();
  });
});

describe("tool_args coalescing", () => {
  test("frames of one call merge into a single suffix; another call flushes first", () => {
    const out: { kind: string; text?: string; toolCallId?: string }[] = [];
    const c = createDeltaCoalescer((p) => out.push(p as never));
    c.push({ kind: "tool_args", name: "write", toolCallId: "a", text: "one", path: "a.ts" });
    c.push({ kind: "tool_args", name: "write", toolCallId: "a", text: "two" });
    c.push({ kind: "tool_args", name: "write", toolCallId: "b", text: "other" });
    c.flush();
    expect(out.map((f) => [f.toolCallId, f.text])).toEqual([
      ["a", "onetwo"],
      ["b", "other"],
    ]);
  });
});

describe("streamed write row in the store", () => {
  const SID = "write-stream-1";
  const PATH = "/tmp/write-stream/session-a.jsonl";

  function seed(): void {
    const s = { sessionId: SID, path: PATH, items: [], assistantDraft: "", streaming: true, subagents: new Map() } as unknown as OpenSession;
    useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s) }));
  }
  const items = (): ToolItem[] => useAppStore.getState().openSessions.get(PATH)!.items as ToolItem[];

  test("frames create the row and grow its body", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_args", name: "write", toolCallId: "c1", text: "a\nb", path: "x.ts" });
    applyEvent({ type: "event", sessionId: SID, kind: "tool_args", name: "write", toolCallId: "c1", text: "\nc" });
    expect(items()).toHaveLength(1);
    expect(items()[0].streamText).toBe("a\nb\nc");
    expect(items()[0].args?.path).toBe("x.ts");
    expect(items()[0].running).toBe(true);
  });

  test("a reset frame replaces the body", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_args", name: "write", toolCallId: "c1", text: "abc" });
    applyEvent({ type: "event", sessionId: SID, kind: "tool_args", name: "write", toolCallId: "c1", text: "ab", reset: true });
    expect(items()[0].streamText).toBe("ab");
  });

  test("the tool frame upgrades the streaming row instead of adding a second one", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_args", name: "write", toolCallId: "c1", text: "body", path: "x.ts" });
    applyEvent({ type: "event", sessionId: SID, kind: "tool", name: "write", toolCallId: "c1", args: { path: "x.ts", content: "body" }, files: ["x.ts"] });
    expect(items()).toHaveLength(1);
    expect(items()[0].files).toEqual(["x.ts"]);
    expect(items()[0].running).toBe(true);
  });

  test("the terminal update drops the preview in favour of the call's own diff", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_args", name: "write", toolCallId: "c1", text: "body", path: "x.ts" });
    applyEvent({ type: "event", sessionId: SID, kind: "tool", name: "write", toolCallId: "c1", args: { path: "x.ts", content: "body" } });
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "write", toolCallId: "c1", added: 1, removed: 0, diffContent: "+body" });
    expect(items()).toHaveLength(1);
    expect(items()[0].streamText).toBeUndefined();
    expect(items()[0].running).toBe(false);
    expect(items()[0].diffContent).toBe("+body");
  });
});

describe("a streaming write row stays out of the change group", () => {
  test("it renders as its own row with the live body visible", async () => {
    const { createElement, Fragment } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const write = (o: Partial<ToolItem>): ToolItem => ({ role: "tool", text: "write", name: "write", ...o });
    const settled = write({ toolCallId: "w1", args: { path: "a.ts" }, running: false });
    const live = write({ toolCallId: "w2", args: { path: "b.ts" }, running: true, streamText: "const a = 1;" });
    const out = renderItems([settled, live] as ChatItem[], "", []);
    // A merged group carries `group`; a standalone edit row does not
    expect(out.some((el) => Array.isArray((el.props as { item?: ToolItem }).item?.group))).toBe(false);
    expect(out).toHaveLength(2);
    // The store mutates items in place, so the body only reaches the screen through the
    // scalar prop snapshot items.tsx → ToolRow → EditRow: a memo-blocked row renders none.
    const html = renderToStaticMarkup(createElement(Fragment, null, ...out));
    expect(html).toContain("const a = 1;");
  });
});

// Live `edit` diff (base `tool_stream_update`): the row prints the patch line by line while
// the model is still emitting the call's arguments, then the settled diff takes over.
describe("streamed edit diff → tool_preview frames", () => {
  const ev = (files: unknown[], toolName = "edit") =>
    translateEvent({ type: "tool_stream_update", toolCallId: "e1", toolName, update: { generation: 1, streaming: true, files } }, ENTRY);

  test("the first file carrying a diff becomes one whole frame", () => {
    const first = ev([{ path: "a.ts", error: "No changes" }, { path: "b.ts", diff: "@@ -1 +1 @@\n-x\n+y" }]);
    expect(first).toMatchObject({ kind: "tool_preview", name: "edit", toolCallId: "e1", path: "b.ts", diff: "@@ -1 +1 @@\n-x\n+y" });
    expect(ev([{ path: "a.ts" }])).toBeNull();
  });

  test("a newer batch of the same call replaces the buffered frame", () => {
    const out: { kind: string; diff?: string }[] = [];
    const c = createDeltaCoalescer((p) => out.push(p as never));
    c.push(ev([{ path: "a.ts", diff: "+one" }])!);
    c.push(ev([{ path: "a.ts", diff: "+one\n+two" }])!);
    c.flush();
    expect(out).toEqual([{ kind: "tool_preview", name: "edit", toolCallId: "e1", path: "a.ts", diff: "+one\n+two" }]);
  });
});

describe("streamed edit row in the store", () => {
  const SID = "edit-stream-1";
  const PATH = "/tmp/write-stream/session-b.jsonl";
  const seed = (): void => {
    const s = { sessionId: SID, path: PATH, items: [], assistantDraft: "", streaming: true, subagents: new Map() } as unknown as OpenSession;
    useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s) }));
  };
  const items = (): ToolItem[] => useAppStore.getState().openSessions.get(PATH)!.items as ToolItem[];
  const frame = (diff: string) => ({ type: "event", sessionId: SID, kind: "tool_preview", name: "edit", toolCallId: "e1", path: "a.ts", diff });

  test("preview frames grow the row and the settled call owns the diff afterwards", () => {
    seed();
    applyEvent(frame("@@ -1 +1 @@\n-a") as never);
    expect(items()[0].streamDiff?.diff).toBe("@@ -1 +1 @@\n-a");
    expect(items()[0].args?.path).toBe("a.ts");
    expect(items()[0].running).toBe(true);
    applyEvent(frame("@@ -1 +1 @@\n-a\n+b") as never);
    expect(items()[0].streamDiff?.diff).toBe("@@ -1 +1 @@\n-a\n+b");
    // The tool frame upgrades the same row (the arguments completed, the call now runs)
    applyEvent({ type: "event", sessionId: SID, kind: "tool", name: "edit", toolCallId: "e1", args: { input: "[a.ts#ABCD]\nPUT 1.=1:\n+b" }, files: ["a.ts"] } as never);
    expect(items()).toHaveLength(1);
    expect(items()[0].streamDiff?.diff).toBe("@@ -1 +1 @@\n-a\n+b");
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "edit", toolCallId: "e1", added: 1, removed: 1, diffContent: "+b" } as never);
    expect(items()[0].streamDiff).toBeUndefined();
    expect(items()[0].diffContent).toBe("+b");
  });
});
