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
// Optional layers, all driven by props and inert by default: new-side line
// selection (stage/discard a line), per-line comments drawn as note rows below
// the line, and a folded single-row summary. Row/comment/fold rules live in
// render-rows.ts so they stay testable without React.
import { useMemo } from "react";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens.jsx";
import { useTranslation } from "react-i18next";
import { buildRenderItems, isSelectableRow, newLineOf, parseDiff, type DiffComment } from "./render-rows.js";

export type { DiffComment, DiffRow, ParsedDiff } from "./render-rows.js";
export { isSelectableRow } from "./render-rows.js";
export { parseDiff } from "./render-rows.js";

interface LightweightDiffProps {
  diff?: string | null;
  lang?: string | null;
  className?: string;
  selectable?: boolean;
  // New-side line numbers (1-based)
  selected?: ReadonlySet<number>;
  // extend = shift-click range selection
  onToggleLine?: (newNo: number, extend: boolean) => void;
  comments?: readonly DiffComment[];
  onAddComment?: (newNo: number) => void;
  folded?: boolean;
  foldedSummary?: React.ReactNode;
  onFoldToggle?: () => void;
}

const NO_COMMENTS: readonly DiffComment[] = [];

export default function LightweightDiff({
  diff,
  lang = null,
  className = "",
  selectable = false,
  selected,
  onToggleLine,
  comments = NO_COMMENTS,
  onAddComment,
  folded = false,
  foldedSummary,
  onFoldToggle,
}: LightweightDiffProps) {
  const { t } = useTranslation();
  const { rows, omitted } = useMemo(() => parseDiff(diff), [diff]);
  // Tokenize the whole content (line texts joined in order) in one pass and paste back by line index; empty lang or oversized content renders as plain text.
  // Comment rows are not part of this join, so token line indices stay aligned with row indices.
  const code = useMemo(() => rows.map((r) => r.text).join("\n"), [rows]);
  const tokens = useCodeTokens(code, lang);
  const items = useMemo(() => buildRenderItems(rows, comments, folded), [rows, comments, folded]);
  if (folded) {
    return (
      <div className={"ldiff" + (className ? " " + className : "")}>
        <div
          className="ldiff-fold"
          role={onFoldToggle ? "button" : undefined}
          tabIndex={onFoldToggle ? 0 : undefined}
          onClick={onFoldToggle}
          onKeyDown={(e) => {
            if (!onFoldToggle || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            onFoldToggle();
          }}
        >
          {foldedSummary}
        </div>
      </div>
    );
  }
  return (
    <div className={"ldiff" + (className ? " " + className : "")}>
      <div className="ldiff-scroll">
        {items.map((item, i) => {
          if (item.kind === "comment") {
            return (
              <div key={"c" + i} className="ldiff-note">
                {item.body}
              </div>
            );
          }
          const { row, index } = item;
          const newNo = newLineOf(row);
          const pickable = selectable && isSelectableRow(row);
          const showAdd = onAddComment !== undefined && newNo !== null;
          const isSel = newNo !== null && selectable && selected?.has(newNo) === true;
          return (
            <div
              key={i}
              className={"ldiff-row ldiff-" + row.kind + (pickable ? " ldiff-pick" : "") + (isSel ? " ldiff-row-sel" : "")}
              onClick={pickable && newNo !== null ? (e) => onToggleLine?.(newNo, e.shiftKey) : undefined}
            >
              <span className="ldiff-gutter" aria-hidden={showAdd ? undefined : true}>
                {showAdd && (
                  <button
                    type="button"
                    className="ldiff-add"
                    aria-label="+"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddComment?.(newNo);
                    }}
                  >
                    +
                  </button>
                )}
                {row.no}
              </span>
              <code className="ldiff-code">
                {tokens?.[index] ? <CodeTokens line={tokens[index]} /> : row.text || " "}
              </code>
            </div>
          );
        })}
        {omitted > 0 && <div className="py-[4px] px-[12px] text-faint">{t("chat.diffOmitted", { count: omitted })}</div>}
      </div>
    </div>
  );
}
