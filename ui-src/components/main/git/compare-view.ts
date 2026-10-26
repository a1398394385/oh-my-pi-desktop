// Flattens the compare view's row model into the exact lines one mode renders,
// and derives the minimap's change segments from those lines. Pure functions: a
// wrong flattening or a wrong segment is invisible in a screenshot but scrolls
// the wrong place, so both are pinned by scripts/git-compare-view.test.ts.
//
// A line's index in the built list is the only coordinate shared by the DOM
// (`data-gp-line`) and the minimap, which is why every mode goes through
// `buildCompareLines` instead of rendering rows directly.
import { inlineLines, type DiffRow, type HunkSection, type InlineLine } from "./diff-rows";

export type CompareMode = "split" | "inline" | "hunks";

export type CompareLine =
  | { type: "split"; row: DiffRow }
  | { type: "inline"; line: InlineLine }
  | { type: "header"; text: string }
  | { type: "fold"; gap: number; count: number; open: boolean };

/** Inline lines of a block; their source row index shifts by the block's start. */
const sectionInline = (section: HunkSection): CompareLine[] =>
  inlineLines(section.rows).map((line) => ({
    type: "inline" as const,
    line: { ...line, rowIndex: line.rowIndex + section.start },
  }));

export function buildCompareLines(
  mode: CompareMode,
  rows: readonly DiffRow[],
  sections: readonly HunkSection[],
  openGaps: ReadonlySet<number>,
): CompareLine[] {
  if (mode === "split") return rows.map((row) => ({ type: "split", row }));
  if (mode === "inline") return inlineLines(rows).map((line) => ({ type: "inline", line }));
  const out: CompareLine[] = [];
  let gap = 0;
  for (const section of sections) {
    if (section.kind === "block") {
      // A headerless block is a file with no changes: nothing to label.
      if (section.header) out.push({ type: "header", text: section.header });
      out.push(...sectionInline(section));
      continue;
    }
    const open = openGaps.has(gap);
    out.push({ type: "fold", gap, count: section.rows.length, open });
    // An open fold keeps the fold row (it becomes the collapse control) and adds
    // the rows it was hiding underneath it.
    if (open) out.push(...sectionInline(section));
    gap++;
  }
  return out;
}

export type MapTone = "add" | "add-soft" | "del" | "del-soft" | "mixed";

export interface MapSegment {
  /** First line (index into the rendered lines) of the segment. */
  startLine: number;
  lines: number;
  tone: MapTone;
}

const toneOf = (adds: number, dels: number): MapTone => {
  if (dels === 0) return "add";
  if (adds === 0) return "del";
  if (adds > dels) return "add-soft";
  if (dels > adds) return "del-soft";
  return "mixed";
};

/** Adds/removals a line stands for; headers and fold controls stand for none. */
const contribution = (line: CompareLine): { adds: number; dels: number } => {
  if (line.type === "split") {
    const kind = line.row.kind;
    return {
      adds: kind === "add" || kind === "change" ? 1 : 0,
      dels: kind === "del" || kind === "change" ? 1 : 0,
    };
  }
  if (line.type === "inline") {
    return { adds: line.line.side === "new" ? 1 : 0, dels: line.line.side === "old" ? 1 : 0 };
  }
  return { adds: 0, dels: 0 };
};

/** Runs of consecutive changed lines, one segment each, in rendered order. */
export function mapSegments(lines: readonly CompareLine[]): MapSegment[] {
  const out: MapSegment[] = [];
  let run: { start: number; lines: number; adds: number; dels: number } | null = null;
  const flush = () => {
    if (!run) return;
    out.push({ startLine: run.start, lines: run.lines, tone: toneOf(run.adds, run.dels) });
    run = null;
  };
  for (const [index, line] of lines.entries()) {
    const { adds, dels } = contribution(line);
    if (adds === 0 && dels === 0) {
      flush();
      continue;
    }
    if (!run) run = { start: index, lines: 0, adds: 0, dels: 0 };
    run.lines += 1;
    run.adds += adds;
    run.dels += dels;
  }
  flush();
  return out;
}
