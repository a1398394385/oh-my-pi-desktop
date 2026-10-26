// `**…<url>**` followed by a non-space char (typically CJK punctuation) must stay a bold
// span: GFM's extended autolink otherwise swallows the closing `**` into the URL path, so
// the stars render literally in chat (a bold lead-in + fullwidth paren right after the URL
// was the reported shape). The fix wraps bare URLs inside such a span in an angle-bracket
// autolink, which ends the link hard.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/md-strong-autolink.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { fixStrongAutolink } from "../ui-src/components/chat/strong-autolink";

const urlA = "http://127.0.0.1:8901/prototypes/cull-layers.html";
const urlB = "http://x.com/a";

describe("fixStrongAutolink", () => {
  test("url inside bold immediately followed by CJK punctuation gets a hard boundary", () => {
    expect(fixStrongAutolink(`**打开 ${urlA}**（顶部 4 个 tab）`)).toBe(`**打开 <${urlA}>**（顶部 4 个 tab）`);
    expect(fixStrongAutolink(`**${urlB}**。看这里`)).toBe(`**<${urlB}>**。看这里`);
  });

  test("bold that already parses is left alone", () => {
    for (const text of [
      "**加粗** 正常",
      "**加粗**（x）",
      "**a** and **b**（x",
      `**见 ${urlB}**`,
      `inline 代码与 URL：\`**${urlB}**（y）\``,
      `**见 ${urlB} 结束**（x`,
    ]) {
      expect(fixStrongAutolink(text)).toBe(text);
    }
  });

  test("inline code spans and fenced code blocks stay verbatim", () => {
    const inline = `文本 \`**打开 ${urlB}**（y）\` 结束`;
    expect(fixStrongAutolink(inline)).toBe(inline);
    const fenced = ["```md", `**打开 ${urlB}**（y）`, "```"].join("\n");
    expect(fixStrongAutolink(fenced)).toBe(fenced);
  });
});
