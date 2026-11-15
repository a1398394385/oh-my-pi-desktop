// conversation_quote wire format: the annotation prefix builder and the split used
// by display paths (UserMsg/QueueCard/rail/find) and the prompt_dropped rollback.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/conversation-quote.test.ts
import { describe, expect, test } from "bun:test";
import { buildQuotePrefix, splitQuote, stripQuote } from "../ui-src/lib/conversation-quote.ts";

describe("conversation quote", () => {
  test("builds the fixed prefix with a blank line before the body", () => {
    expect(buildQuotePrefix([{ text: "当前", comment: "注释测试" }])).toBe(
      '<conversation_quote>\n[{"text":"当前","comment":"注释测试"}]\n</conversation_quote>\n\n',
    );
    expect(splitQuote(buildQuotePrefix([{ text: "当前", comment: "注释测试" }]) + "继续")).toEqual({
      body: "继续",
      notes: [{ text: "当前", comment: "注释测试" }],
      sessions: [],
    });
  });

  test("round-trips a file-pane note (path + line span) so an edit can restore it", () => {
    const notes = [{ text: "选中行", comment: "", file: "/x/a.ts", lines: "12-18" }];
    expect(splitQuote(buildQuotePrefix(notes) + "看这段").notes).toEqual(notes);
  });

  test("keeps an empty comment and round-trips the optional agent tag", () => {
    const notes = [{ text: "a", comment: "" }, { text: "b", comment: "c", agent: "reviewer" }];
    expect(splitQuote(buildQuotePrefix(notes) + "hi").notes).toEqual(notes);
  });

  test("passes plain prompts through and builds nothing without notes", () => {
    expect(stripQuote("plain")).toBe("plain");
    expect(splitQuote("plain")).toEqual({ body: "plain", notes: [], sessions: [] });
    expect(buildQuotePrefix([])).toBe("");
  });

  test("cuts the host's attachment framing, so its @ mentions never become chips", () => {
    const prompt =
      '<attached-file name="a.ts">\nexport const a = 1;\n</attached-file>\n\n看这个\n\n' +
      '<attached-session title="sess-1" path="/tmp/sess-1.jsonl">\n\n### user\n@cli 里\n\n</attached-session>';
    expect(splitQuote(prompt)).toEqual({
      body: "看这个",
      notes: [],
      sessions: [{ title: "sess-1", path: "/tmp/sess-1.jsonl" }],
    });
  });

  test("drops an unterminated attachment tail (truncated message)", () => {
    expect(stripQuote("hi\n\n<attached-session title=\"t\" path=\"/p\">\n\n### user\npartial")).toBe("hi");
    // Sidebar previews truncate at 80 chars, cutting the header before its `>`
    expect(stripQuote('sum\n\n<attached-session title="2026-11-13T07-59-53-693Z_01a1')).toBe("sum");
  });
});
