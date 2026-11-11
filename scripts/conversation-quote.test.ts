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
    });
  });

  test("keeps an empty comment and round-trips the optional agent tag", () => {
    const notes = [{ text: "a", comment: "" }, { text: "b", comment: "c", agent: "reviewer" }];
    expect(splitQuote(buildQuotePrefix(notes) + "hi").notes).toEqual(notes);
  });

  test("passes plain prompts through and builds nothing without notes", () => {
    expect(stripQuote("plain")).toBe("plain");
    expect(splitQuote("plain")).toEqual({ body: "plain", notes: [] });
    expect(buildQuotePrefix([])).toBe("");
  });
});
