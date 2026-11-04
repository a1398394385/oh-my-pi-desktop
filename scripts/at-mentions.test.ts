// @path stripping for user bubbles: hide exactly what the base auto-read, keep everything
// else (Chinese text glued to the @ never triggers a read, so its token must stay visible).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/at-mentions.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { atMentions } from "../ui-src/lib/at-mentions.ts";

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
