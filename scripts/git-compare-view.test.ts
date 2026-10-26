// The compare view's line list and minimap segments
// (ui-src/components/main/git/compare-view.ts). Both are derived from the row
// model, so the cases pinned here are the shapes the renderer depends on: each
// mode's line count, what a folded gap contributes, and the colour bucket a run
// of changes falls into.
// Run: bun test scripts/git-compare-view.test.ts
import { describe, expect, test } from "bun:test";
import { buildCompareLines, mapSegments, type CompareLine } from "../ui-src/components/main/git/compare-view";
import { hunkSections, type DiffRow } from "../ui-src/components/main/git/diff-rows";

const context = (oldNo: number, newNo = oldNo): DiffRow => ({ kind: "context", oldNo, newNo, oldText: "c", newText: "c" });
const add = (newNo: number): DiffRow => ({ kind: "add", newNo, oldText: "", newText: "a" });
const del = (oldNo: number): DiffRow => ({ kind: "del", oldNo, oldText: "d", newText: "" });
const change = (oldNo: number, newNo = oldNo): DiffRow => ({ kind: "change", oldNo, newNo, oldText: "o", newText: "n" });

describe("buildCompareLines", () => {
  test("split renders one line per row", () => {
    const rows = [context(1), change(2), context(3)];
    expect(buildCompareLines("split", rows, hunkSections(rows), new Set())).toHaveLength(3);
  });

  test("inline renders one line per side of a paired change", () => {
    const rows = [context(1), change(2), context(3)];
    expect(buildCompareLines("inline", rows, hunkSections(rows), new Set())).toHaveLength(4);
  });

  test("hunks folds an unchanged run into one control line", () => {
    // A change on row 10 keeps 5 rows of context on each side: row 0..3 and
    // 15..18 fold into one control line each.
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => context(i + 1)),
      change(10),
      ...Array.from({ length: 9 }, (_, i) => context(i + 11)),
    ];
    const sections = hunkSections(rows, 5);
    const folded = buildCompareLines("hunks", rows, sections, new Set());
    const folds = folded.filter((line) => line.type === "fold");
    expect(folds).toHaveLength(2);
    expect(folds.map((line) => (line.type === "fold" ? line.count : 0))).toEqual([4, 4]);
    // 2 fold controls + 1 header + 12 lines of the block (10 context rows, and
    // the change expands into its old then new line).
    expect(folded).toHaveLength(2 + 1 + 12);
  });

  test("an open gap adds its rows under the control line", () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => context(i + 1)), change(10)];
    const sections = hunkSections(rows, 5);
    const open: CompareLine[] = buildCompareLines("hunks", rows, sections, new Set([0]));
    const fold = open[0];
    expect(fold.type === "fold" && fold.open).toBe(true);
    // The control line, the 4 rows it was hiding, a header, then the 7 lines of
    // the block (5 context rows + the change's old and new line).
    expect(open).toHaveLength(1 + 4 + 1 + 7);
  });
});

describe("mapSegments", () => {
  const tone = (rows: DiffRow[]) => mapSegments(buildCompareLines("split", rows, hunkSections(rows), new Set()));

  test("a run of additions is solid green", () => {
    expect(tone([add(1), add(2), context(3)])).toEqual([{ startLine: 0, lines: 2, tone: "add" }]);
  });

  test("a run of removals is solid red", () => {
    expect(tone([del(1), del(2)])).toEqual([{ startLine: 0, lines: 2, tone: "del" }]);
  });

  test("a net-addition run is light green, a net-removal run light red", () => {
    expect(tone([add(1), change(2)]).map((s) => s.tone)).toEqual(["add-soft"]);
    expect(tone([del(1), change(2)]).map((s) => s.tone)).toEqual(["del-soft"]);
  });

  test("a one-for-one replacement is mixed", () => {
    expect(tone([change(1)]).map((s) => s.tone)).toEqual(["mixed"]);
  });

  test("unchanged rows split segments and never carry a segment", () => {
    expect(tone([context(1), add(2), context(3), del(4)])).toEqual([
      { startLine: 1, lines: 1, tone: "add" },
      { startLine: 3, lines: 1, tone: "del" },
    ]);
  });

  test("the inline view counts one side per line", () => {
    const rows = [change(1)];
    const segments = mapSegments(buildCompareLines("inline", rows, hunkSections(rows), new Set()));
    expect(segments).toEqual([{ startLine: 0, lines: 2, tone: "mixed" }]);
  });
});
