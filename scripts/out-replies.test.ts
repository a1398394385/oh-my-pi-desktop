// `out://` mid-call replies (base 18.14): eval/bash repeat every reply so far on each
// tool_execution_update. The host projects them onto a running tool_update frame, and the
// store must refresh the card without sealing it (a terminal tool_update still folds it).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/out-replies.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { createSmokeWindow } from "./ui-smoke-env.ts";
import type { ChatItem, OpenSession, ToolItem } from "../ui-src/types/session";

// happy-dom globals must exist before the store modules evaluate, so these imports cannot be
// static (same pattern as task-spawn-details.test.ts)
createSmokeWindow();
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session");
const { translateEvent } = await import("../host/translate.ts");
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { renderItems } = await import("../ui-src/components/chat/items");
const { default: ReadonlyGroup } = await import("../ui-src/components/chat/ReadonlyGroup");
const { default: OutReply } = await import("../ui-src/components/chat/OutReply");

const SID = "out-replies-1";
const PATH = "/tmp/out-replies/session-a.jsonl";

function update(toolName: string, details: unknown, toolCallId = "c1") {
  return translateEvent(
    { type: "tool_execution_update", toolCallId, toolName, args: {}, partialResult: { content: [], details } },
    {} as never,
  );
}

describe("tool_execution_update → out:// replies", () => {
  test("replies project onto a running tool_update frame", () => {
    expect(update("eval", { replies: ["waiting on tests", "half done"] })).toEqual({
      kind: "tool_update",
      name: "eval",
      toolCallId: "c1",
      replies: ["waiting on tests", "half done"],
      running: true,
    });
  });

  test("a repeated replies array is not re-sent", () => {
    expect(update("bash", { replies: ["a"] }, "c2")?.kind).toBe("tool_update");
    expect(update("bash", { replies: ["a"] }, "c2")).toBeNull();
    expect(update("bash", { replies: ["a", "b"] }, "c2")?.kind).toBe("tool_update");
  });

  test("updates without replies stay untranslated", () => {
    expect(update("bash", { output: "chunk" })).toBeNull();
    expect(update("bash", { replies: [] })).toBeNull();
  });

  test("task updates keep the details-only frame", () => {
    const details = { progress: [{ id: "Shell", agent: "scout", status: "running" }] };
    expect(update("task", details)).toEqual({ kind: "tool_details", name: "task", toolCallId: "c1", details });
  });

  test("the terminal frame carries the call's replies", () => {
    const ev = translateEvent(
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "eval",
        args: {},
        result: { content: [{ type: "text", text: "ok" }], details: { replies: ["waiting on tests"] } },
      },
      { transcript: [], cwd: "/tmp" } as never,
    );
    if (ev?.kind !== "tool_update") throw new Error(`expected tool_update, got ${ev?.kind}`);
    expect(ev.replies).toEqual(["waiting on tests"]);
    expect(ev.running).toBeUndefined();
  });

  // The base returns a fixed "Shown to the user." result for a reply write (the TUI draws the
  // text from the call args), so the host projects args.content instead of details.replies.
  test("a write to out:// carries its content as the reply", () => {
    const ev = translateEvent(
      {
        type: "tool_execution_end",
        toolCallId: "w1",
        toolName: "write",
        args: { path: "out://status.md", content: "half done" },
        result: { content: [{ type: "text", text: "Shown to the user." }] },
      },
      { transcript: [], cwd: "/tmp" } as never,
    );
    if (ev?.kind !== "tool_update") throw new Error(`expected tool_update, got ${ev?.kind}`);
    expect(ev.replies).toEqual(["half done"]);
  });

  test("a refused reply write and a plain file write carry no reply", () => {
    const refused = translateEvent(
      {
        type: "tool_execution_end",
        toolCallId: "w2",
        toolName: "write",
        args: { path: "out://status.md", content: "half done" },
        isError: true,
        result: { content: [{ type: "text", text: "out:// is off in this session" }] },
      },
      { transcript: [], cwd: "/tmp" } as never,
    );
    if (refused?.kind !== "tool_update") throw new Error(`expected tool_update, got ${refused?.kind}`);
    expect(refused.replies).toBeUndefined();

    const file = translateEvent(
      {
        type: "tool_execution_end",
        toolCallId: "w3",
        toolName: "write",
        args: { path: "notes.md", content: "half done" },
        result: { content: [{ type: "text", text: "ok" }] },
      },
      { transcript: [], cwd: "/tmp" } as never,
    );
    if (file?.kind !== "tool_update") throw new Error(`expected tool_update, got ${file?.kind}`);
    expect(file.replies).toBeUndefined();
  });
});

describe("running tool_update frame in the store", () => {
  function seed(): void {
    const s = {
      sessionId: SID,
      path: PATH,
      items: [
        {
          role: "tool",
          text: "eval",
          name: "eval",
          toolCallId: "c1",
          running: true,
          cmdExpanded: true,
          replies: ["first"],
        },
      ],
      assistantDraft: "",
      streaming: false,
      subagents: new Map(),
    } as unknown as OpenSession;
    useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s) }));
  }

  test("refreshes replies without sealing or folding the row", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", replies: ["first", "second"], running: true });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.replies).toEqual(["first", "second"]);
    expect(item.running).toBe(true);
    expect(item.cmdExpanded).toBe(true);
  });

  test("the terminal frame seals the row and keeps the replies", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", output: "done", replies: ["first"] });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.output).toBe("done");
    expect(item.running).toBe(false);
    expect(item.replies).toEqual(["first"]);
  });

  test("a terminal frame without replies keeps the ones on screen", () => {
    seed();
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", replies: ["first", "second"], running: true });
    applyEvent({ type: "event", sessionId: SID, kind: "tool_update", name: "eval", toolCallId: "c1", output: "done" });
    const item = useAppStore.getState().openSessions.get(PATH)!.items[0] as ToolItem;
    expect(item.running).toBe(false);
    expect(item.replies).toEqual(["first", "second"]);
  });
});

describe("out:// reply rows and the read-only fold", () => {
  const tool = (o: Partial<ToolItem> & Pick<ToolItem, "name" | "toolCallId">): ToolItem =>
    ({ role: "tool", text: "", ...o });

  // Render tree walk: OutReply is a component element, so its card div only exists after
  // rendering — the element type is the marker here
  function hasReplyCard(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(hasReplyCard);
    if (!node || typeof node !== "object") return false;
    const el = node as { type?: unknown; props?: { children?: unknown } };
    if (el.type === OutReply) return true;
    return hasReplyCard(el.props?.children);
  }

  // Same walk for a rendered ToolRow: only it carries a ChatItem in `item`
  function hasToolRow(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(hasToolRow);
    if (!node || typeof node !== "object") return false;
    const props = (node as { props?: { item?: { role?: string }; children?: unknown } }).props;
    if (!props) return false;
    return props.item?.role === "tool" || hasToolRow(props.children);
  }

  test("a reply row breaks the fold instead of being swallowed by it", () => {
    const reads = [1, 2, 3].map((n) => tool({ name: "read", toolCallId: "r" + n, args: { path: "/f" + n } }));
    const reply = tool({ name: "bash", toolCallId: "b1", replies: ["progress"] });
    const out = renderItems([...reads, reply] as ChatItem[], "", []);
    const fold = out.find((el) => el.type === ReadonlyGroup);
    if (!fold) throw new Error("expected a fold for the three reads before the reply row");
    expect((fold.props as { subs: ChatItem[] }).subs.map((i) => i.toolCallId)).toEqual(["r1", "r2", "r3"]);
    expect(hasReplyCard(out)).toBe(true);
  });

  test("a write to out:// renders as the reply card, not a tool row", () => {
    const reply = tool({ name: "write", toolCallId: "w1", args: { path: "out://a.md" }, replies: ["hello"] });
    const out = renderItems([reply] as ChatItem[], "", []);
    expect(hasReplyCard(out)).toBe(true);
    expect(hasToolRow(out)).toBe(false);
  });

  test("the streamed body stands in for the reply until the call settles", () => {
    const live = tool({ name: "write", toolCallId: "w2", args: { path: "out://b.md" }, running: true, streamText: "half" });
    const out = renderItems([live] as ChatItem[], "", []);
    expect(hasReplyCard(out)).toBe(true);
    expect(hasToolRow(out)).toBe(false);
  });

  test("a plain file write keeps its tool row", () => {
    const file = tool({ name: "write", toolCallId: "w3", args: { path: "notes.md" }, replies: ["hello"] });
    const out = renderItems([file] as ChatItem[], "", []);
    expect(hasToolRow(out)).toBe(true);
  });

  test("a reply write with no body yet keeps the tool row", () => {
    const empty = tool({ name: "write", toolCallId: "w4", args: { path: "out://c.md" }, running: true });
    const out = renderItems([empty] as ChatItem[], "", []);
    expect(hasToolRow(out)).toBe(true);
    expect(hasReplyCard(out)).toBe(false);
  });

  // Concise live view drops process rows; a reply card is output, so it must survive
  test("concise mode keeps the reply card and drops the surrounding rows", () => {
    const user: ChatItem = { role: "user", text: "go" };
    const read = tool({ name: "read", toolCallId: "r9", args: { path: "/x" } });
    const reply = tool({ name: "write", toolCallId: "w5", args: { path: "out://d.md" }, replies: ["hi"] });
    const out = renderItems([user, read, reply] as ChatItem[], "", [], undefined, { hideProcessFrom: 0 });
    expect(hasReplyCard(out)).toBe(true);
    expect(hasToolRow(out)).toBe(false);
  });
});

describe("sealing a run keeps reply cards out of the loop group", () => {
  const { sealRunItems } = require("../ui-src/store/run-seal.ts");

  test("a reply row sits outside the sealed group, above the final output", () => {
    const reply = { role: "tool", name: "write", text: "write", toolCallId: "w1", args: { path: "out://a.md" }, replies: ["hi"] };
    const other = { role: "tool", name: "bash", text: "bash", toolCallId: "b1", args: {} };
    const final = { role: "assistant", text: "done", turnFinal: true };
    const s = { items: [reply, other, final], turnItemStart: 0, turnStartAt: Date.now() } as never;
    sealRunItems(s);
    const items = (s as { items: Array<{ role: string; items?: unknown[] }> }).items;
    expect(items.map((i) => i.role)).toEqual(["loop", "tool", "assistant"]);
    expect(items[0].items?.length).toBe(1);
    expect(items[1]).toMatchObject({ toolCallId: "w1" });
  });
});
