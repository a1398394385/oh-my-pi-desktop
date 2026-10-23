// The Git page's compare view aligns old and new rows from the patch
// (ui-src/components/main/git/diff-rows.ts), the same pairing the TUI diff pane
// uses. A wrong pairing is invisible in a screenshot but shows the wrong text
// beside a changed line, so the rules are pinned here: replacement blocks pair
// row by row, a block's surplus keeps one side empty, gaps between hunks and a
// truncated tail are filled from the two texts.
// Run: bun test scripts/diff-rows.test.ts
import { describe, expect, test } from "bun:test";
import { compareDocument, hunkSections, inlineLines } from "../ui-src/components/main/git/diff-rows";

/** Rows only: the hunk grouping has its own test below. */
const compareRows = (patch: string, oldText: string, newText: string): ReturnType<typeof compareDocument>["rows"] =>
  compareDocument(patch, oldText, newText).rows;

describe("compareRows", () => {
  test("a replacement block pairs old and new rows instead of stacking them", () => {
    const rows = compareRows(
      ["@@ -1,4 +1,4 @@", " one", "-two", "+TWO", " three", " four"].join("\n"),
      "one\ntwo\nthree\nfour",
      "one\nTWO\nthree\nfour",
    );
    expect(rows.map((r) => r.kind)).toEqual(["context", "change", "context", "context"]);
    expect(rows[1]).toMatchObject({ oldNo: 2, newNo: 2, oldText: "two", newText: "TWO" });
  });

  test("a block with more removals than additions leaves the new side empty", () => {
    const rows = compareRows(
      ["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+A"].join("\n"),
      "a\nb\nc",
      "A",
    );
    expect(rows.map((r) => r.kind)).toEqual(["change", "del", "del"]);
    expect(rows[1]).toMatchObject({ oldNo: 2, oldText: "b", newText: "" });
    expect(rows[1]?.newNo).toBeUndefined();
  });

  test("a block with more additions than removals leaves the old side empty", () => {
    const rows = compareRows(
      ["@@ -1,1 +1,3 @@", "-a", "+b", "+c", "+d"].join("\n"),
      "a",
      "b\nc\nd",
    );
    expect(rows.map((r) => r.kind)).toEqual(["change", "add", "add"]);
    expect(rows[2]).toMatchObject({ newNo: 3, newText: "d", oldText: "" });
    expect(rows[2]?.oldNo).toBeUndefined();
  });

  test("lines between two hunks are filled from the texts so numbers stay aligned", () => {
    const oldText = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Q"].join("\n");
    const newText = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "R"].join("\n");
    const rows = compareRows(
      ["@@ -1,2 +1,2 @@", " 1", "-2", "+TWO", "@@ -10,1 +10,1 @@", "-Q", "+R"].join("\n"),
      oldText,
      newText,
    );
    // 1 (context), 2 (change), 3..9 (filled), Q (change)
    expect(rows).toHaveLength(10);
    expect(rows[2]).toMatchObject({ kind: "context", oldNo: 3, newNo: 3, oldText: "3" });
    expect(rows[9]).toMatchObject({ kind: "change", oldNo: 10, newNo: 10 });
  });

  test("a new file is all additions on the right side", () => {
    const rows = compareRows(["@@ -0,0 +1,3 @@", "+a", "+b", "+c"].join("\n"), "", "a\nb\nc");
    expect(rows.map((r) => r.kind)).toEqual(["add", "add", "add"]);
    expect(rows.map((r) => r.newNo)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.oldNo === undefined)).toBe(true);
  });

  test("a truncated patch keeps the rest of both versions aligned as context", () => {
    const rows = compareRows(["@@ -1,2 +1,2 @@", "-a", "+A"].join("\n"), "a\nb\nc\nd\ne", "A\nb\nc\nd\ne");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ kind: "change", oldNo: 1, newNo: 1 });
    expect(rows[4]).toMatchObject({ kind: "context", oldNo: 5, newNo: 5, oldText: "e" });
  });

  test("the no-newline marker and file headers are ignored", () => {
    const rows = compareRows(
      [
        "diff --git a/a.ts b/a.ts",
        "index 111..222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ].join("\n"),
      "old",
      "new",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "change", oldText: "old", newText: "new" });
  });

  test("hunks keep their header and own rows", () => {
    const doc = compareDocument(
      [
        "diff --git a/a.ts b/a.ts",
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "+TWO",
        "@@ -10,1 +10,1 @@",
        "-Q",
        "+R",
      ].join("\n"),
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nQ",
      "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nR",
    );
    expect(doc.hunks).toHaveLength(2);
    expect(doc.hunks[0].header).toBe("@@ -1,2 +1,2 @@");
    // The gap between the hunks belongs to the block above it.
    expect(doc.hunks[0].rows.map((r) => r.kind)).toEqual([
      "context", "change", "context", "context", "context", "context", "context", "context", "context",
    ]);
    expect(doc.hunks[1].rows.map((r) => r.oldNo)).toEqual([10]);
  });

  test("inline view expands a paired change into an old then a new line", () => {
    const rows = compareRows(
      ["@@ -1,3 +1,3 @@", " keep", "-before", "+after", " tail"].join("\n"),
      "keep\nbefore\ntail",
      "keep\nafter\ntail",
    );
    expect(inlineLines(rows)).toEqual([
      { side: "both", oldNo: 1, newNo: 1, text: "keep", rowIndex: 0 },
      { side: "old", oldNo: 2, text: "before", rowIndex: 1 },
      { side: "new", newNo: 2, text: "after", rowIndex: 1 },
      { side: "both", oldNo: 3, newNo: 3, text: "tail", rowIndex: 2 },
    ]);
  });

  test("a trailing newline does not add a phantom line", () => {
    const rows = compareRows("", "a\nb\n", "a\nb\n");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.newNo)).toEqual([1, 2]);
  });

  test("an identical file with no patch rows out as context", () => {
    const rows = compareRows("", "a\nb", "a\nb");
    expect(rows.map((r) => r.kind)).toEqual(["context", "context"]);
    expect(rows[1]).toMatchObject({ oldNo: 2, newNo: 2, oldText: "b", newText: "b" });
  });
});

describe("hunkSections", () => {
  /** `n` unchanged lines: enough to shape the gaps the fold rows stand for. */
  const context = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ kind: "context" as const, oldNo: from + i, newNo: from + i, oldText: "", newText: "" }));
  const change = (oldNo: number, newNo: number) => ({ kind: "change" as const, oldNo, newNo, oldText: "a", newText: "b" });

  test("two distant changes become two blocks with one gap between them", () => {
    // 1..20 context, change at 21, 22..51 context, change at 52, 53..60 context.
    const rows = [
      ...context(1, 20),
      change(21, 21),
      ...context(22, 51),
      change(52, 52),
      ...context(53, 60),
    ];
    const sections = hunkSections(rows, 5);
    // Unchanged rows outside the context fringes fold as well, at both ends.
    expect(sections.map((s) => s.kind)).toEqual(["gap", "block", "gap", "block", "gap"]);
    expect(sections[0].rows).toHaveLength(15);
    // 5 rows of context on each side of the two changes.
    expect(sections[1].rows).toHaveLength(11);
    // 26..45: the two 5-row context fringes are inside the blocks.
    expect(sections[2].rows).toHaveLength(20);
    expect(sections[2].start).toBe(26);
    expect(sections[3].rows).toHaveLength(11);
    expect(sections[4].rows).toHaveLength(3);
  });

  test("context is clipped at the row boundaries", () => {
    const rows = [change(1, 1), ...context(2, 4)];
    const sections = hunkSections(rows, 5);
    expect(sections).toHaveLength(1);
    expect(sections[0].start).toBe(0);
    expect(sections[0].rows).toHaveLength(4);
  });

  test("changes closer than twice the context merge into one block", () => {
    const rows = [...context(1, 3), change(4, 4), ...context(5, 12), change(13, 13), ...context(14, 20)];
    const sections = hunkSections(rows, 5);
    expect(sections.map((s) => s.kind)).toEqual(["block", "gap"]);
    expect(sections[0].rows).toHaveLength(18);
    expect(sections[1].rows).toHaveLength(2);
  });

  test("the synthesised header counts each side of the block", () => {
    const rows = [...context(1, 2), change(3, 3), ...context(4, 9)];
    // The block covers 8 of the 9 rows: the last one falls outside the context.
    expect(hunkSections(rows, 5)[0].header).toBe("@@ -1,8 +1,8 @@");
  });

  test("a new file has no old side to count", () => {
    const rows = [1, 2, 3].map((newNo) => ({ kind: "add" as const, newNo, oldText: "", newText: "x" }));
    expect(hunkSections(rows, 5)[0].header).toBe("@@ -0,0 +1,3 @@");
  });

  test("a file with no changes stays one headerless block", () => {
    const sections = hunkSections(context(1, 4), 5);
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("block");
    expect(sections[0].header).toBe("");
    expect(sections[0].rows).toHaveLength(4);
  });
});
