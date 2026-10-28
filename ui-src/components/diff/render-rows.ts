// Row model of the lightweight diff renderer (components/diff/LightweightDiff).
// Split out of the component so the selection / comment / fold rules stay pure
// and testable without React: parse -> rows -> draw items.

// Render line cap: the host truncates file_diff responses at 500k chars;
// oversized diffs draw only the first MAX lines plus a trailing omission
// notice, preventing a single huge file diff from stalling rendering
export const MAX_RENDER_LINES = 4000;

const HUNK_RE = /^@@(?:\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?)?/;
const META_RE = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/;
const NOTE_RE = /^\\ /;
// Line-number format of the base edit tool's details.diff (same as the TUI):
// "sign + line number + |/│ + text", where the sign is space (context) /
// - (old) / + (new); the separator may also be the full-width │. Not a unified
// diff — no hunk headers
const LN_RE = /^([-+\s])\s*(\d+)[|│](.*)$/;

export interface DiffRow {
  kind: "note" | "added" | "removed" | "context";
  text: string;
  // Which side of the patch the row belongs to; selection and comments only
  // address new-side line numbers, so removed rows are never addressable
  side?: "old" | "new";
  // Number shown in the gutter: new number for added/context rows, old number
  // for removed rows (unchanged from the pre-selection renderer)
  no?: number;
  oldNo?: number;
  newNo?: number;
}

export interface DiffComment {
  line: number;
  body: string;
}

export interface ParsedDiff {
  rows: DiffRow[];
  omitted: number;
}

// Parse unified diff text into row structures: body lines are classified by
// their +/-/space prefix while old/new line numbers are tracked from hunk
// headers; file headers and hunk headers are skipped for rendering (line
// numbers still align at hunk headers; truncated hunks are tolerated).
function parseUnifiedDiff(diff: string | null | undefined): ParsedDiff {
  const lines = String(diff ?? "").split("\n");
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let omitted = 0;
  let inHunk = false; // Same filter as ZCode: before entering a hunk only hunk headers count; once inside, @@/file headers are all skipped
  for (let i = 0; i < lines.length; i++) {
    if (rows.length >= MAX_RENDER_LINES) {
      omitted = lines.length - i;
      break;
    }
    const raw = lines[i];
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1] || 1);
      newLine = Number(hunk[3] || 1);
      inHunk = true;
      continue;
    }
    if (!inHunk || META_RE.test(raw)) continue;
    if (NOTE_RE.test(raw)) {
      rows.push({ kind: "note", text: raw });
    } else if (raw.startsWith("+")) {
      rows.push({ kind: "added", text: raw.slice(1), side: "new", no: newLine++ });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "removed", text: raw.slice(1), side: "old", no: oldLine++ });
    } else {
      // Space-prefixed context line; a fully empty line falls back to context (git bodies never emit blank lines)
      rows.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, side: "new", no: newLine, oldNo: oldLine, newNo: newLine });
      newLine++;
      oldLine++;
    }
  }
  return { rows, omitted };
}

// Parse the base's line-number diff (edit tool details.diff): each line carries its own old/new line number, no hunk-header alignment needed
function parseLnDiff(diff: string | null | undefined): ParsedDiff {
  const lines = String(diff ?? "").split("\n");
  const rows: DiffRow[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (rows.length >= MAX_RENDER_LINES) {
      omitted = lines.length - i;
      break;
    }
    const m = LN_RE.exec(lines[i]);
    if (!m) continue;
    const no = Number(m[2]);
    if (m[1] === "-") rows.push({ kind: "removed", text: m[3], side: "old", no });
    else if (m[1] === "+") rows.push({ kind: "added", text: m[3], side: "new", no });
    // The line-number format carries a single number; treat context as new side
    else rows.push({ kind: "context", text: m[3], side: "new", no });
  }
  return { rows, omitted };
}

// Unified entry point: unified diff first; falls back to line-number parsing when there is no hunk body (base line-number format)
export function parseDiff(diff: string | null | undefined): ParsedDiff {
  const unified = parseUnifiedDiff(diff);
  if (unified.rows.length > 0) return unified;
  return parseLnDiff(diff);
}

// New-side line number of a row, or null when the row cannot be addressed by
// the new side (removed rows and patch notes)
export function newLineOf(row: DiffRow): number | null {
  if (row.side !== "new") return null;
  return row.newNo ?? row.no ?? null;
}

// Only added rows are worth picking: the host cuts a patch by new-side line
// number, and a context row carries no change of its own. Picking any added
// line still stages its whole -/+ block (host/git-patch.ts), so a replaced
// line is never staged half-way.
export function isSelectableRow(row: DiffRow): boolean {
  return row.kind === "added" && newLineOf(row) !== null;
}

export type DiffRenderItem =
  | { kind: "row"; index: number; row: DiffRow }
  | { kind: "comment"; body: string };

// Flatten rows plus their comments into draw order: comments are inserted
// directly below the new-side line they annotate (several in input order).
// Folded output is empty — the caller draws the summary row instead.
export function buildRenderItems(rows: readonly DiffRow[], comments: readonly DiffComment[], folded: boolean): DiffRenderItem[] {
  if (folded) return [];
  const byLine = new Map<number, string[]>();
  for (const c of comments) {
    const list = byLine.get(c.line);
    if (list) list.push(c.body);
    else byLine.set(c.line, [c.body]);
  }
  const items: DiffRenderItem[] = [];
  rows.forEach((row, index) => {
    items.push({ kind: "row", index, row });
    const line = newLineOf(row);
    const bodies = line === null ? undefined : byLine.get(line);
    if (bodies) for (const body of bodies) items.push({ kind: "comment", body });
  });
  return items;
}
