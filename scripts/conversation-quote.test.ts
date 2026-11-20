// conversation_quote wire format: the annotation prefix builder and the split used
// by display paths (UserMsg/QueueCard/rail/find) and the prompt_dropped rollback.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/conversation-quote.test.ts
import { describe, expect, test } from "bun:test";
import { buildQuotePrefix, splitQuote, stripQuote } from "../ui-src/lib/conversation-quote.ts";

describe("conversation quote", () => {
  test("builds the fixed prefix with a blank line before the body", () => {
    expect(buildQuotePrefix([{ text: "当前", comment: "注释测试" }])).toBe(
      '<conversation_quote>[{"text":"当前","comment":"注释测试"}]</conversation_quote>\n\n',
    );
    expect(splitQuote(buildQuotePrefix([{ text: "当前", comment: "注释测试" }]) + "继续")).toEqual({
      body: "继续",
      notes: [{ text: "当前", comment: "注释测试" }],
      sessions: [],
      files: [],
    });
  });

  test("parses the pre-existing newline-wrapped form and a hand-typed copy", () => {
    // Messages sent before the tags lost their line breaks are already stored this way.
    const legacy = '<conversation_quote>\n[{"text":"旧","comment":"旧注释"}]\n</conversation_quote>\n\n继续';
    expect(splitQuote(legacy)).toEqual({
      body: "继续",
      notes: [{ text: "旧", comment: "旧注释" }],
      sessions: [],
      files: [],
    });
    // Typed by hand (no separators at all) still renders as the same chip.
    expect(splitQuote('<conversation_quote>[{"text":"手打","comment":""}]</conversation_quote>').notes).toEqual([
      { text: "手打", comment: "" },
    ]);
  });

  test("round-trips a file-pane note (path + line span) so an edit can restore it", () => {
    const notes = [{ text: "选中行", comment: "", file: "/x/a.ts", lines: "12-18" }];
    expect(splitQuote(buildQuotePrefix(notes) + "看这段").notes).toEqual(notes);
  });

  test("keeps an empty comment and round-trips the optional agent tag", () => {
    const notes = [{ text: "a", comment: "" }, { text: "b", comment: "c", agent: "reviewer" }];
    expect(splitQuote(buildQuotePrefix(notes) + "hi").notes).toEqual(notes);
  });

  test("parses a comment-only prompt (no body, blank line trimmed)", () => {
    // A comment-only send is the whole prompt: the trailing blank line of the prefix is
    // the end of the text, so the block must still be recognized or the bubble shows it raw.
    expect(splitQuote(buildQuotePrefix([{ text: "选中", comment: "评论" }]))).toEqual({
      body: "",
      notes: [{ text: "选中", comment: "评论" }],
      sessions: [],
      files: [],
    });
  });

  test("passes plain prompts through and builds nothing without notes", () => {
    expect(stripQuote("plain")).toBe("plain");
    expect(splitQuote("plain")).toEqual({ body: "plain", notes: [], sessions: [], files: [] });
    expect(buildQuotePrefix([])).toBe("");
  });

  test("cuts the host's attachment framing and keeps what the bubble needs to redraw", () => {
    const prompt =
      '<attached-file name="a.ts">\nexport const a = 1;\n</attached-file>\n\n看这个\n\n' +
      '<attached-session title="sess-1" path="/tmp/sess-1.jsonl">\n\n### user\n@cli 里\n\n</attached-session>';
    expect(splitQuote(prompt)).toEqual({
      body: "看这个",
      notes: [],
      sessions: [{ title: "sess-1", path: "/tmp/sess-1.jsonl" }],
      files: ["a.ts"],
    });
  });

  test("finds the quote block when the host prepended a text attachment", () => {
    // Host order: <attached-file> blocks go before the prompt, and the prompt itself
    // starts with the quote prefix — the prefix is only first after that framing is cut.
    const prompt =
      '<attached-file name="a.ts">\nexport const a = 1;\n</attached-file>\n\n' +
      buildQuotePrefix([{ text: "当前", comment: "注释测试" }]) +
      "继续";
    expect(splitQuote(prompt)).toEqual({
      body: "继续",
      notes: [{ text: "当前", comment: "注释测试" }],
      sessions: [],
      files: ["a.ts"],
    });
  });


  test("keeps a note whose own text quotes the attachment tags", () => {
    // A user annotating this very module writes `<attached-file>` inside the note; the
    // framing cut must only fire on line starts, or the quote block is eaten with it.
    const prompt =
      buildQuotePrefix([{ text: "a", comment: "为什么要用 <attached-file>?" }]) +
      '<attached-file name="x.ts">\nbody\n</attached-file>\n\n' +
      "看这个";
    expect(splitQuote(prompt)).toEqual({
      body: "看这个",
      notes: [{ text: "a", comment: "为什么要用 <attached-file>?" }],
      sessions: [],
      files: ["x.ts"],
    });
  });


  test("drops an unterminated attachment tail (truncated message)", () => {
    expect(stripQuote("hi\n\n<attached-session title=\"t\" path=\"/p\">\n\n### user\npartial")).toBe("hi");
    // Sidebar previews truncate at 80 chars, cutting the header before its `>`
    expect(stripQuote('sum\n\n<attached-session title="2026-11-13T07-59-53-693Z_01a1')).toBe("sum");
  });
});
