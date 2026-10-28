// Pure-function tests for host/git-patch.ts: no git, no temp dir. The oracle
// test covers behaviour against real git.
import { describe, expect, test } from "bun:test";
import { selectLines, partial, fileHeader } from "../host/git-patch.ts";

const PATCH = [
  "diff --git a/f.txt b/f.txt",
  "index 1111111..2222222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,5 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "-four",
  "+FOUR",
  " five",
  "",
].join("\n");

/** Patch lines without the three-line file header. */
const body = (out: string | null) => (out ?? "").split("\n").slice(3);

describe("selectLines", () => {
  test("keeps the chosen change and turns the other deletion back into context", () => {
    const out = selectLines(PATCH, new Set([2]), false);
    expect(out).not.toBeNull();
    expect(out!.startsWith(fileHeader(PATCH))).toBe(true);
    expect(body(out)).toEqual([
      "@@ -1,5 +1,5 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      " four", // unselected deletion became context
      " five",
      "",
    ]);
  });

  test("scattered lines in separate hunks are both kept", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,2 @@",
      " j",
      "-k",
      "+K",
      "",
    ].join("\n");
    expect(body(selectLines(patch, new Set([2, 11]), false))).toEqual([
      "@@ -1,2 +1,2 @@", " a", "-b", "+B",
      "@@ -10,2 +10,2 @@", " j", "-k", "+K",
      "",
    ]);
  });

  test("reverse keeps the chosen edit verbatim and demotes the unselected addition", () => {
    // Unstaging: --reverse removes FOUR from the index and restores four.
    expect(body(selectLines(PATCH, new Set([4]), true))).toEqual([
      "@@ -1,5 +1,5 @@",
      " one",
      " TWO", // unselected addition stays as context
      " three",
      "-four",
      "+FOUR",
      " five",
      "",
    ]);
  });

  test("nothing chosen yields null", () => {
    expect(selectLines(PATCH, new Set(), false)).toBeNull();
    expect(selectLines(PATCH, new Set([1, 99]), false)).toBeNull(); // context and absent lines are not changes
  });

  test("an added file is not selectable", () => {
    const patch = ["diff --git a/n.txt b/n.txt", "new file mode 100644", "--- /dev/null", "+++ b/n.txt", "@@ -0,0 +1,2 @@", "+a", "+b", ""].join("\n");
    expect(partial(patch)).toBe(false);
    expect(selectLines(patch, new Set([1]), false)).toBeNull();
    expect(fileHeader(patch)).toBe("diff --git a/n.txt b/n.txt\n--- a/n.txt\n+++ b/n.txt\n");
  });

  test("a rename is not selectable", () => {
    const patch = ["diff --git a/x.txt b/y.txt", "similarity index 90%", "rename from x.txt", "rename to y.txt", "--- a/x.txt", "+++ b/y.txt", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n");
    expect(partial(patch)).toBe(false);
  });

  test("a binary patch is not selectable", () => {
    const patch = ["diff --git a/x.png b/x.png", "index 1..2 100644", "Binary files a/x.png and b/x.png differ", ""].join("\n");
    expect(partial(patch)).toBe(false);
  });

  test("a content line that looks like a file header stays content", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+++ plus plus", // an added line whose text starts with "++"
      "",
    ].join("\n");
    expect(partial(patch)).toBe(true);
    expect(body(selectLines(patch, new Set([2]), false))).toEqual([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+++ plus plus",
      "",
    ]);
  });

  test("a no-newline marker dies with the line it belongs to", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,4 +1,4 @@",
      " a",
      "-x",
      "+X",
      " mid",
      "-b",
      "+B",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    // Selecting line 2 keeps "-x/+X" and drops "+B"; its marker goes with it.
    expect(body(selectLines(patch, new Set([2]), false))).toEqual([
      "@@ -1,4 +1,4 @@",
      " a",
      "-x",
      "+X",
      " mid",
      " b",
      "",
    ]);
  });
});
