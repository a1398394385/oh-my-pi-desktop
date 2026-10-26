// Grouping rules of the Git page's working-changes column
// (ui-src/components/main/git/worktree-rows.ts). The interesting cases are the
// ones git status really produces: a partially staged file (index + worktree
// changes) must appear in BOTH halves so each side opens its own compare pair,
// and an unmerged entry must not be folded into either half.
// Run: bun test scripts/git-page-rows.test.ts
import { describe, expect, test } from "bun:test";
import type { GitStatusFile } from "../ui-src/types/frames";
import { worktreeRows, worktreeStatusLetter } from "../ui-src/components/main/git/worktree-rows";

const file = (code: string, path: string, conflict = false): GitStatusFile => {
  const [x, y] = code;
  return {
    code,
    path,
    staged: x === " " || x === "?" ? "" : x,
    unstaged: y === " " ? "" : y,
    conflict,
  };
};

describe("worktreeRows", () => {
  test("partially staged file lists on both halves", () => {
    const groups = worktreeRows([file("MM", "both.ts")]);
    expect(groups.staged.map((r) => r.file.path)).toEqual(["both.ts"]);
    expect(groups.unstaged.map((r) => r.file.path)).toEqual(["both.ts"]);
  });

  test("worktree-only, index-only and untracked rows land on one half each", () => {
    const groups = worktreeRows([file(" M", "wt.ts"), file("M ", "idx.ts"), file("??", "new.ts")]);
    expect(groups.staged.map((r) => r.file.path)).toEqual(["idx.ts"]);
    expect(groups.unstaged.map((r) => r.file.path)).toEqual(["new.ts", "wt.ts"]);
  });

  test("conflicts get their own group and never appear twice", () => {
    const groups = worktreeRows([file("UU", "conflict.ts", true)]);
    expect(groups.conflict.map((r) => r.file.path)).toEqual(["conflict.ts"]);
    expect(groups.staged).toHaveLength(0);
    // "UU" carries no worktree marker, so it stays out of the unstaged half too
    expect(groups.unstaged).toHaveLength(0);
  });

  test("each group is sorted by path", () => {
    const groups = worktreeRows([file(" M", "b.ts"), file(" M", "a.ts"), file(" M", "c.ts")]);
    expect(groups.unstaged.map((r) => r.file.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("worktreeStatusLetter", () => {
  test("untracked reads U, otherwise the first non-blank column", () => {
    expect(worktreeStatusLetter(file("??", "x"))).toBe("U");
    expect(worktreeStatusLetter(file(" M", "x"))).toBe("M");
    expect(worktreeStatusLetter(file("A ", "x"))).toBe("A");
    expect(worktreeStatusLetter(file(" D", "x"))).toBe("D");
  });
});
