// commentsMarkdown is the prompt an agent receives for review comments: its shape has to
// stay byte-identical to MyGit's commentsMarkdown (review.go), so a prompt written here and
// one copied there read the same.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/git-comments.test.ts
import { describe, expect, test } from "bun:test";
import { commentsMarkdown } from "../ui-src/components/main/git/comments";
import type { ReviewComment } from "../ui-src/components/main/git/comments";

const HEAD = "# Address these Review Comments\n";

describe("commentsMarkdown", () => {
  test("a single comment: heading, fenced code, body", () => {
    const one: ReviewComment = {
      path: "src/app.ts",
      lines: "12-14",
      code: ["const a = 1;", "const b = 2;"],
      body: "Use the shared helper here.",
    };
    expect(commentsMarkdown([one])).toBe(
      HEAD + "\n## 1. src/app.ts:12-14\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nUse the shared helper here.\n",
    );
  });

  test("comments are numbered in order and each carries its own section", () => {
    const out = commentsMarkdown([
      { path: "a/b.py", lines: "3", code: ["x = 1"], body: "rename" },
      { path: "c.md", lines: "1-2", code: ["# t", ""], body: "tidy" },
    ]);
    expect(out).toBe(
      HEAD +
        "\n## 1. a/b.py:3\n\n```py\nx = 1\n```\n\nrename\n" +
        "\n## 2. c.md:1-2\n\n```md\n# t\n\n```\n\ntidy\n",
    );
  });

  test("a commit rev is shown short, while a range rev names no single commit", () => {
    const out = commentsMarkdown([
      { path: "a.go", rev: "abcdef1234567890", lines: "7", code: ["y"], body: "b" },
      { path: "a.go", rev: "abc..def", lines: "8", code: ["z"], body: "c" },
    ]);
    expect(out).toContain("## 1. a.go:7 (commit abcdef12)");
    expect(out).toContain("## 2. a.go:8\n");
  });

  test("the removed side is named", () => {
    const out = commentsMarkdown([{ path: "a.ts", oldSide: true, lines: "5", code: ["gone()"], body: "why remove?" }]);
    expect(out).toContain("## 1. a.ts:5 (removed lines)\n");
  });

  test("a path without an extension opens a bare fence", () => {
    const out = commentsMarkdown([{ path: "Makefile", lines: "2", code: ["all:"], body: "b" }]);
    expect(out).toContain("## 1. Makefile:2\n\n```\nall:\n```\n\nb\n");
  });

  test("no comments = the heading alone", () => {
    expect(commentsMarkdown([])).toBe(HEAD);
  });
});
