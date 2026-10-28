// Row rules of the lightweight diff renderer
// (ui-src/components/diff/render-rows.ts): new-side addressing for line
// selection and comments, comment insertion order, and the folded (empty)
// draw list. Pure functions only — no React.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/lightweight-diff-rows.test.ts
import { describe, expect, test } from "bun:test";
import {
  buildRenderItems,
  isSelectableRow,
  MAX_RENDER_LINES,
  newLineOf,
  parseDiff,
  type DiffComment,
} from "../ui-src/components/diff/render-rows";

const UNIFIED = [
  "diff --git a/x.ts b/x.ts",
  "index 111..222 100644",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,4 @@",
  " a",
  "+b",
  " c",
  "-d",
].join("\n");

describe("parseDiff", () => {
  test("unified rows carry both sides and drop protocol headers", () => {
    const { rows, omitted } = parseDiff(UNIFIED);
    expect(omitted).toBe(0);
    expect(rows.map((r) => r.kind)).toEqual(["context", "added", "context", "removed"]);
    expect(rows.map((r) => r.no)).toEqual([1, 2, 3, 3]);
    expect(rows[0]).toMatchObject({ oldNo: 1, newNo: 1, text: "a" });
    // The single gutter number stays the pre-selection one: new side for added/context, old side for removed
    expect(rows.map(newLineOf)).toEqual([1, 2, 3, null]);
  });

  test("line-number format still parses as one row per line", () => {
    const { rows } = parseDiff(["  10|keep", "+ 11|added", "- 9|gone"].join("\n"));
    expect(rows.map((r) => r.kind)).toEqual(["context", "added", "removed"]);
    expect(rows.map((r) => r.no)).toEqual([10, 11, 9]);
    expect(rows.map(newLineOf)).toEqual([10, 11, null]);
  });

  test("empty input renders nothing", () => {
    expect(parseDiff("")).toEqual({ rows: [], omitted: 0 });
    expect(parseDiff(null)).toEqual({ rows: [], omitted: 0 });
  });

  test("render cap truncates and reports the remainder", () => {
    const lines = ["@@ -1,4000 +1,4001 @@", ...Array.from({ length: MAX_RENDER_LINES + 3 }, () => " x")];
    const { rows, omitted } = parseDiff(lines.join("\n"));
    expect(rows.length).toBe(MAX_RENDER_LINES);
    // hunk header + 4000 body lines consumed; the last 3 body lines are dropped
    expect(omitted).toBe(3);
  });
});

describe("selectable rows", () => {
  test("only added rows are pickable; context, removed and note rows are not", () => {
    const { rows } = parseDiff(UNIFIED);
    // The host cuts a patch by new-side line number and a context row carries
    // no change of its own, so picking one would only ever fail host-side.
    expect(rows.map(isSelectableRow)).toEqual([false, true, false, false]);
  });
});

describe("buildRenderItems", () => {
  const { rows } = parseDiff(UNIFIED);
  const comment = (line: number, body: string): DiffComment => ({ line, body });

  test("comments land directly below their new-side line, in input order", () => {
    const items = buildRenderItems(rows, [comment(2, "first"), comment(2, "second"), comment(3, "ctx")], false);
    expect(items.map((it) => (it.kind === "row" ? it.row.kind : "note:" + it.body))).toEqual([
      "context",
      "added",
      "note:first",
      "note:second",
      "context",
      "note:ctx",
      "removed",
    ]);
    // Token indices stay row-aligned: comments never consume a row index
    expect(items.filter((it) => it.kind === "row").map((it) => (it.kind === "row" ? it.index : -1))).toEqual([0, 1, 2, 3]);
  });

  test("comments on removed-side or missing lines are not drawn", () => {
    // line 9 is a removed-side comment target; line 99 does not exist
    const items = buildRenderItems(rows, [comment(9, "old"), comment(99, "ghost")], false);
    expect(items.every((it) => it.kind === "row")).toBe(true);
  });

  test("folded draw list is empty", () => {
    expect(buildRenderItems(rows, [comment(2, "x")], true)).toEqual([]);
  });
});
