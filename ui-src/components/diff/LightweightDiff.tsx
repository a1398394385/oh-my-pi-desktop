// In-house lightweight diff renderer: ported from ZCode
// packages/ui/src/components/ui/lightweight-diff-preview.tsx (pure CSS line
// parsing, no third-party deps). Additions/removals are conveyed only via line
// background color-mix + an inset status bar at line start + line-number gutter
// coloring; the unified diff +/-/space markers are not shown.
// Syntax highlighting is ported from ZCode highlighted-lightweight-diff-preview:
// the whole content is tokenized in one pass (same as ZCode, so cross-line
// syntax state stays consistent), and token spans are pasted back per line;
// line background colors remain owned by this component's CSS.
// Line filtering matches ZCode collectPlainTextPreviewLines: file headers
// (diff --git/index/---/+++ etc.) and hunk headers (@@) are never rendered —
// only hunk bodies are drawn, so previews do not expose protocol headers.
import { useMemo } from "react";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens.jsx";
import { useTranslation } from "react-i18next";

// Render line cap: the host truncates file_diff responses at 500k chars;
// oversized diffs draw only the first MAX lines plus a trailing omission
// notice, preventing a single huge file diff from stalling rendering
const MAX_RENDER_LINES = 4000;

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
  no?: number;
  oldNo?: number;
}

interface ParsedDiff {
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
      rows.push({ kind: "added", text: raw.slice(1), no: newLine++ });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "removed", text: raw.slice(1), no: oldLine++ });
    } else {
      // Space-prefixed context line; a fully empty line falls back to context (git bodies never emit blank lines)
      rows.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, no: newLine++, oldNo: oldLine++ });
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
    if (m[1] === "-") rows.push({ kind: "removed", text: m[3], no });
    else if (m[1] === "+") rows.push({ kind: "added", text: m[3], no });
    else rows.push({ kind: "context", text: m[3], no });
  }
  return { rows, omitted };
}

// Unified entry point: unified diff first; falls back to line-number parsing when there is no hunk body (base line-number format)
export function parseDiff(diff: string | null | undefined): ParsedDiff {
  const unified = parseUnifiedDiff(diff);
  if (unified.rows.length > 0) return unified;
  return parseLnDiff(diff);
}

interface LightweightDiffProps {
  diff?: string | null;
  lang?: string | null;
  className?: string;
}

export default function LightweightDiff({ diff, lang = null, className = "" }: LightweightDiffProps) {
  const { t } = useTranslation();
  const { rows, omitted } = useMemo(() => parseDiff(diff), [diff]);
  // Tokenize the whole content (line texts joined in order) in one pass and paste back by line index; empty lang or oversized content renders as plain text
  const code = useMemo(() => rows.map((r) => r.text).join("\n"), [rows]);
  const tokens = useCodeTokens(code, lang);
  return (
    <div className={"ldiff" + (className ? " " + className : "")}>
      <div className="ldiff-scroll">
        {rows.map((row, i) => (
          <div key={i} className={"ldiff-row ldiff-" + row.kind}>
            {"no" in row || "oldNo" in row ? (
              <span className="ldiff-gutter" aria-hidden="true">{row.no}</span>
            ) : (
              <span className="ldiff-gutter" aria-hidden="true" />
            )}
            <code className="ldiff-code">
              {tokens?.[i] ? <CodeTokens line={tokens[i]} /> : row.text || " "}
            </code>
          </div>
        ))}
        {omitted > 0 && <div className="py-[4px] px-[12px] text-faint">{t("chat.diffOmitted", { count: omitted })}</div>}
      </div>
    </div>
  );
}
