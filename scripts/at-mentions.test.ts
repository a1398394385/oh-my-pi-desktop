// @path stripping for user bubbles: hide exactly what the base auto-read, keep everything
// else (Chinese text glued to the @ never triggers a read, so its token must stay visible).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/at-mentions.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { atMentions, elementLabel, isDirToken, splitRefs } from "../ui-src/lib/at-mentions.ts";

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

  test("an empty known list keeps every @token as prose (the base read nothing)", () => {
    const r = atMentions("从 @etower/shared 导入，再跑 @etower/core", []);
    expect(r.paths).toEqual([]);
    expect(r.text).toBe("从 @etower/shared 导入，再跑 @etower/core");
  });

  test("an inline-code mention resolves without the closing backtick", () => {
    const r = atMentions("改 `@src/a.ts` 里的判断", ["src/a.ts"]);
    expect(r.paths).toEqual(["src/a.ts"]);
  });

  test("strips /skill: invocations and keeps the prose between them apart", () => {
    const r = atMentions("/skill:frontend-design /skill:modern-web-guidance 这两个 skill 优化一下");
    expect(r.skills).toEqual(["frontend-design", "modern-web-guidance"]);
    expect(r.text).toBe("这两个 skill 优化一下");
  });

  test("an inline skill token leaves the words on both sides separated", () => {
    const r = atMentions("看下 /skill:repo-review 然后总结");
    expect(r.skills).toEqual(["repo-review"]);
    expect(r.text).toBe("看下 然后总结");
  });

  test("namespaced skill names stay whole", () => {
    const r = atMentions("/skill:acme/review 看看");
    expect(r.skills).toEqual(["acme/review"]);
    expect(r.text).toBe("看看");
  });

  test("a draft owned by another sigil keeps its /skill: tokens literal", () => {
    expect(atMentions("/compact /skill:x").skills).toEqual([]);
    expect(atMentions("! ls /skill:x").skills).toEqual([]);
    expect(atMentions("$ ls /skill:x").skills).toEqual([]);
  });
});

describe("picked-element blocks", () => {
  // AgentBrowserView.pickedText writes the header lines + fenced html as one block; the
  // bubble shows it as a single chip and the markup never leaks into the skill / @ passes.
  const prompt = [
    "改成这样",
    "",
    "[element] div#hero.row 1200×400",
    "color: rgb(0, 0, 0)",
    "url: https://x.test/",
    "```html",
    '<div id="hero">/skill:fake @not-a-file</div>',
    "```",
    "",
    "谢谢",
  ].join("\n");

  test("strips the whole block and leaves the prose around it", () => {
    const r = atMentions(prompt);
    expect(r.elements.length).toBe(1);
    expect(r.text).toBe("改成这样\n\n谢谢");
    expect(r.skills).toEqual([]);
    expect(r.paths).toEqual([]);
  });

  test("chip label is the selector without the box size", () => {
    expect(elementLabel(atMentions(prompt).elements[0])).toBe("div#hero.row");
  });

  test("a marked block is recognised mid-line", () => {
    const r = atMentions("改一下 x[element] div#a 10×10\n```html\n<div>a</div>\n```\n[/element] 谢谢");
    expect(r.elements.length).toBe(1);
    expect(r.text).toBe("改一下 x 谢谢");
  });

  test("a legacy block stays line-anchored (no marker, prose could forge it)", () => {
    expect(atMentions("改一下 x[element] div#a 10×10\n```html\n<div>a</div>\n```").elements).toEqual([]);
  });

  test("chip label skips the closing marker", () => {
    const marked = atMentions("x\n[element] div#a 10×10\n```html\n<div>a</div>\n```\n[/element]").elements[0];
    expect(elementLabel(marked)).toBe("div#a");
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

  // A picked-element block is one chip: the header lines and the fenced html must not be
  // split by the @ and / tokens the markup contains.
  const element = [
    "[element] span#picked 426×18",
    "color: rgb(127, 209, 255)",
    "background: rgba(0, 0, 0, 0)",
    "font: 12px ui-monospace, Menlo, monospace",
    "url: file:///x/icon-candidates.html",
    "```html",
    '<span id="picked">@not-a-file /not-a-cmd</span>',
    "```",
  ].join("\n");

  test("an element block stays whole and its html tokens never split it", () => {
    expect(splitRefs(element)).toEqual([{ kind: "element", token: element }]);
    expect(roundTrip(element)).toBe(element);
  });

  test("an element block survives next to file references", () => {
    expect(splitRefs(`看图 @/a.ts\n\n${element}\n\n继续 @/b.ts`)).toEqual([
      { text: "看图 " },
      { kind: "file", path: "/a.ts", token: "@/a.ts" },
      { text: "\n\n" },
      { kind: "element", token: element },
      { text: "\n\n继续 " },
      { kind: "file", path: "/b.ts", token: "@/b.ts" },
    ]);
  });

  // Marked blocks (current pickedText writes `[/element]`) are found anywhere, so a chip
  // the user moved mid-line comes back as a chip on edit.
  test("a marked block mid-line round-trips as one chip", () => {
    const marked = `${element}\n[/element]`;
    const text = `前面${marked}后面`;
    expect(splitRefs(text)).toEqual([{ text: "前面" }, { kind: "element", token: marked }, { text: "后面" }]);
    expect(roundTrip(text)).toBe(text);
  });
});

describe("isDirToken (file chip icon)", () => {
  // insertFile writes a trailing slash for directories and a trailing space for files
  test("directories end with a slash, files with a space", () => {
    expect(isDirToken("@docs/")).toBe(true);
    expect(isDirToken("@src/components/")).toBe(true);
    expect(isDirToken('@"a b/"')).toBe(true);
    expect(isDirToken("@src/a.ts ")).toBe(false);
    expect(isDirToken("@src/a.ts")).toBe(false);
  });
});
