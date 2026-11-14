// @path stripping for user bubbles: hide exactly what the base auto-read, keep everything
// else (Chinese text glued to the @ never triggers a read, so its token must stay visible).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/at-mentions.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { atMentions, splitRefs } from "../ui-src/lib/at-mentions.ts";

describe("atMentions", () => {
  test("strips a standalone mention line and keeps the prose", () => {
    const r = atMentions("看一下这个\n@/x/report.md");
    expect(r.paths).toEqual(["/x/report.md"]);
    expect(r.text).toBe("看一下这个");
  });

  test("strips an inline mention without leaving a double space", () => {
    const r = atMentions("看下 @/x/report.md 然后总结");
    expect(r.paths).toEqual(["/x/report.md"]);
    expect(r.text).toBe("看下 然后总结".replace("  ", " "));
  });

  test("quoted path with spaces", () => {
    const r = atMentions('总结 @"My Notes.md"');
    expect(r.paths).toEqual(["My Notes.md"]);
    expect(r.text).toBe("总结");
  });

  test("a mention glued to Chinese text does not match (the base would not read it either)", () => {
    const r = atMentions("看一下@/x/a.md");
    expect(r.paths).toEqual([]);
    expect(r.text).toBe("看一下@/x/a.md");
  });

  test("known paths from the host limit what gets hidden", () => {
    const r = atMentions("说 @/a.md 和 @/b.md", ["/a.md"]);
    expect(r.paths).toEqual(["/a.md"]);
    expect(r.text).toBe("说 和 @/b.md");
  });
});

describe("splitRefs (editor backfill)", () => {
  // Chips must serialize back to the exact bytes: rebuilding an editor from a sent prompt
  // and sending it again has to reproduce the same reference tokens.
  const roundTrip = (text: string) =>
    splitRefs(text)
      .map((seg) => ("text" in seg ? seg.text : seg.token))
      .join("");

  test("splits a file mention and its token owns the trailing space", () => {
    expect(splitRefs("看下 @/x/a.md 然后")).toEqual([
      { text: "看下 " },
      { kind: "file", path: "/x/a.md", token: "@/x/a.md " },
      { text: "然后" },
    ]);
    expect(roundTrip("看下 @/x/a.md 然后")).toBe("看下 @/x/a.md 然后");
  });

  test("quoted paths and session references keep their token", () => {
    expect(splitRefs('@"My Notes.md"')).toEqual([{ kind: "file", path: "My Notes.md", token: '@"My Notes.md"' }]);
    expect(splitRefs("@session:/p/s.jsonl 继续")).toEqual([
      { kind: "session", path: "/p/s.jsonl", token: "@session:/p/s.jsonl " },
      { text: "继续" },
    ]);
    expect(splitRefs('@session:"/p/a b.jsonl"')).toEqual([
      { kind: "session", path: "/p/a b.jsonl", token: '@session:"/p/a b.jsonl"' },
    ]);
  });

  test("leaves text with no references untouched", () => {
    expect(splitRefs("普通文字\n两行")).toEqual([{ text: "普通文字\n两行" }]);
    expect(splitRefs("看一下@/x/a.md")).toEqual([{ text: "看一下@/x/a.md" }]);
  });
});
