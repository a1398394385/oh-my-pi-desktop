// Aligned rows for the Git page's compare view, modelled on the TUI diff pane
// (packages/tui/src/apps/git/diff-pane.ts): a removed/added block is paired row
// by row so one row holds the old and the new text side by side, and a block's
// surplus keeps its own side empty.
//
// The document also carries the three views the shared row model supports —
// `split`, `inline`, `hunks`; `inline`/`hunks` expand a paired row into two
// lines.
//
// The host asks git for a huge context, so one hunk normally covers the whole
// file and every unchanged line arrives as context. Lines missing between hunks
// (truncated patch, or a diff produced with the default context) are filled from
// the two texts, so row numbers and the single scrolling grid never drift.
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER_RE = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/;

export type DiffKind = "context" | "change" | "add" | "del";

export interface DiffRow {
  kind: DiffKind;
  /** 1-based line in the old version; absent when the row only exists on the new side. */
  oldNo?: number;
  newNo?: number;
  oldText: string;
  newText: string;
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@` exactly as the patch spells it. */
  header: string;
  rows: DiffRow[];
}

export interface DiffDocument {
  rows: DiffRow[];
  hunks: DiffHunk[];
}

/** One line of the single-column views, tagged with which side it shows. */
export interface InlineLine {
  side: "old" | "new" | "both";
  oldNo?: number;
  newNo?: number;
  text: string;
  /** Index of the row this line came from: a paired change yields two lines that
   *  share one row index, which is how the minimap finds the row to scroll to. */
  rowIndex: number;
}

/** Source lines without a phantom trailing row: a file ending in a newline has
 *  no extra empty line (same rule as the TUI document builder). */
export const splitLines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

export function compareDocument(patch: string, oldText: string, newText: string): DiffDocument {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const rows: DiffRow[] = [];
  const hunks: DiffHunk[] = [];
  const dropped: DiffRow[] = [];
  const added: DiffRow[] = [];
  let own: DiffHunk | null = null;
  let oldNo = 1;
  let newNo = 1;

  const push = (row: DiffRow): void => {
    rows.push(row);
    own?.rows.push(row);
  };

  // Pairing happens per block, not per file: git only reports a block as the
  // run of "-" lines followed by the run of "+" lines, and zipping those runs is
  // what puts a rewritten line opposite its new version instead of stacking them.
  const flush = (): void => {
    const paired = Math.min(dropped.length, added.length);
    for (let i = 0; i < paired; i++) {
      push({
        kind: "change",
        oldNo: dropped[i].oldNo,
        newNo: added[i].newNo,
        oldText: dropped[i].oldText,
        newText: added[i].newText,
      });
    }
    for (let i = paired; i < dropped.length; i++) push(dropped[i]);
    for (let i = paired; i < added.length; i++) push(added[i]);
    dropped.length = 0;
    added.length = 0;
  };

  const fillGap = (untilOld: number, untilNew: number): void => {
    // Bounded by the texts too: a patch that names a line the text does not have
    // (stale patch, or a test's short fixture) must not invent blank rows.
    while (oldNo < untilOld && newNo < untilNew && oldNo <= oldLines.length && newNo <= newLines.length) {
      push({
        kind: "context",
        oldNo,
        newNo,
        oldText: oldLines[oldNo - 1] ?? "",
        newText: newLines[newNo - 1] ?? "",
      });
      oldNo++;
      newNo++;
    }
  };

  for (const raw of patch.split("\n")) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      flush();
      // A hunk starting at line 0 ("new file") means that side has no lines at
      // all; keeping the 0 would emit a phantom trailing row below.
      const startOld = Math.max(1, Number(hunk[1]));
      const startNew = Math.max(1, Number(hunk[2]));
      fillGap(startOld, startNew);
      oldNo = startOld;
      newNo = startNew;
      own = { header: raw, rows: [] };
      hunks.push(own);
      continue;
    }
    if (FILE_HEADER_RE.test(raw)) {
      flush();
      own = null;
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) {
      dropped.push({ kind: "del", oldNo: oldNo++, oldText: raw.slice(1), newText: "" });
      continue;
    }
    if (raw.startsWith("+")) {
      added.push({ kind: "add", newNo: newNo++, oldText: "", newText: raw.slice(1) });
      continue;
    }
    if (!raw.startsWith(" ")) continue; // outside any hunk
    flush();
    const text = raw.slice(1);
    push({ kind: "context", oldNo, newNo, oldText: text, newText: text });
    oldNo++;
    newNo++;
  }
  flush();

  // A patch that stops early (truncated) still knows where it stopped, so the
  // rest of both versions is filled in from the texts themselves.
  while (oldNo <= oldLines.length && newNo <= newLines.length) {
    push({
      kind: "context",
      oldNo,
      newNo,
      oldText: oldLines[oldNo - 1] ?? "",
      newText: newLines[newNo - 1] ?? "",
    });
    oldNo++;
    newNo++;
  }
  for (; oldNo <= oldLines.length; oldNo++) {
    push({ kind: "del", oldNo, oldText: oldLines[oldNo - 1] ?? "", newText: "" });
  }
  for (; newNo <= newLines.length; newNo++) {
    push({ kind: "add", newNo, oldText: "", newText: newLines[newNo - 1] ?? "" });
  }
  return { rows, hunks };
}

/**
 * Expands aligned rows into the single-column views: a paired change becomes the
 * old line then the new line, context shows both numbers, one-sided rows keep
 * only their own side. Same breakdown as the TUI `inline` view.
 */
export function inlineLines(rows: readonly DiffRow[]): InlineLine[] {
  const out: InlineLine[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.kind === "change") {
      out.push({ side: "old", oldNo: row.oldNo, text: row.oldText, rowIndex });
      out.push({ side: "new", newNo: row.newNo, text: row.newText, rowIndex });
      continue;
    }
    if (row.kind === "del") {
      out.push({ side: "old", oldNo: row.oldNo, text: row.oldText, rowIndex });
      continue;
    }
    if (row.kind === "add") {
      out.push({ side: "new", newNo: row.newNo, text: row.newText, rowIndex });
      continue;
    }
    out.push({ side: "both", oldNo: row.oldNo, newNo: row.newNo, text: row.newText, rowIndex });
  }
  return out;
}

/** A run of changed rows plus its surrounding context, or the unchanged rows
 *  between two such runs (rendered as one fold row). */
export interface HunkSection {
  kind: "block" | "gap";
  /** Index of the section's first row in the source rows. */
  start: number;
  rows: DiffRow[];
  /** Synthesised `@@ -a,b +c,d @@`; only blocks have one. */
  header?: string;
}

/** `@@` header for a synthesised block: first number seen on each side plus how
 *  many rows of the block exist on that side. */
function blockHeader(block: readonly DiffRow[]): string {
  const oldNos = block.filter((r) => r.oldNo !== undefined).length;
  const newNos = block.filter((r) => r.newNo !== undefined).length;
  const oldStart = block.find((r) => r.oldNo !== undefined)?.oldNo ?? 0;
  const newStart = block.find((r) => r.newNo !== undefined)?.newNo ?? 0;
  return `@@ -${oldStart},${oldNos} +${newStart},${newNos} @@`;
}

/**
 * Splits aligned rows into change blocks (each changed run plus `context`
 * unchanged rows on both sides, nearby runs merged) and the gaps between them.
 * The host asks for a full-context patch, so a document normally arrives as one
 * huge hunk — folding has to re-cut it here.
 */
export function hunkSections(rows: readonly DiffRow[], context = 5): HunkSection[] {
  const changed: number[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].kind !== "context") changed.push(i);
  if (changed.length === 0) return [{ kind: "block", start: 0, rows: [...rows], header: "" }];

  const ranges: { from: number; to: number }[] = [];
  let from = Math.max(0, changed[0] - context);
  let to = Math.min(rows.length - 1, changed[0] + context);
  for (const i of changed.slice(1)) {
    const nextFrom = Math.max(0, i - context);
    const nextTo = Math.min(rows.length - 1, i + context);
    // Touching ranges belong to one block: no gap row to fold between them.
    if (nextFrom <= to + 1) {
      to = Math.max(to, nextTo);
      continue;
    }
    ranges.push({ from, to });
    from = nextFrom;
    to = nextTo;
  }
  ranges.push({ from, to });

  const out: HunkSection[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.from > cursor) out.push({ kind: "gap", start: cursor, rows: rows.slice(cursor, range.from) });
    const block = rows.slice(range.from, range.to + 1);
    out.push({ kind: "block", start: range.from, rows: block, header: blockHeader(block) });
    cursor = range.to + 1;
  }
  if (cursor < rows.length) out.push({ kind: "gap", start: cursor, rows: rows.slice(cursor) });
  return out;
}
