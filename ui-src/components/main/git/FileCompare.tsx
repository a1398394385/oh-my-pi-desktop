// Side-by-side view of one file's two versions, used by the Git page when a
// changed file is clicked in either the side panel's lists. Both halves come from
// one host round trip (git_file_versions), which also returns a full-context
// patch: the patch is the only source of truth for alignment (see diff-rows.ts),
// so a changed line sits opposite its replacement.
//
// ONE scroller and one offset, like the TUI diff pane: `split` is a grid row
// whose two text columns are equal `1fr` tracks, so both halves share the single
// vertical offset and cannot drift. Two scrollers mirrored through scroll events
// always lagged or dropped the echo of a wheel burst — there is no event path
// that makes that reliable.
//
// Three views share one line list (compare-view.ts): `split` pairs rows side by
// side, `inline` expands a paired row into its old then new line, `hunks` does
// the same but cuts the full-context patch into change blocks and folds the
// unchanged rows between them. Each line carries one gutter, so a long line can
// be ellipsised without pushing the numbers away.
//
// The minimap bar on the right edge is the scroller's replacement (the native one
// is hidden): it marks the change runs of the rendered view and clicking one
// jumps to it. Its viewport box is written through a ref inside a rAF — the view
// can hold 4000 rows and a state update per scroll event would re-render them all.
//
// Rows are capped like the chat diff view: a 500k-character side would mount
// tens of thousands of nodes and stall the page.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { CodeTokens, useCodeTokens } from "../../../lib/CodeTokens.jsx";
import { langOfPath, type HighlightToken } from "../../../lib/highlighter";
import { fetchGitFileVersions } from "../../../store/git-graph";
import type { FileVersionsFrame } from "../../../types/frames";
import { buildCompareLines, mapSegments, type CompareLine, type CompareMode } from "./compare-view";
import { compareDocument, hunkSections, splitLines, type DiffRow, type InlineLine } from "./diff-rows";

const MAX_RENDER_LINES = 4000;

/** Same order as the TUI's 2–4 segments (the whole-file view is gone). */
const MODES = [
  { id: "split", label: "gitPage.viewSplit" },
  { id: "inline", label: "gitPage.viewInline" },
  { id: "hunks", label: "gitPage.viewHunks" },
] as const;

/** What the compare view is showing and where it came from. */
export interface CompareTarget {
  cwd: string;
  path: string;
  /** Commit whose own change is shown; empty = index/worktree read. */
  oid?: string;
  oldPath?: string;
  /** oid empty: true = index change (HEAD vs index), false = worktree change (index vs disk). */
  staged?: boolean;
  /** Which list the view was opened from, so the side panel keeps showing it. */
  origin: "commit" | "worktree";
}

function CodeLine({ tokens, index, text }: { tokens: HighlightToken[][] | null; index: number | undefined; text: string }) {
  if (index === undefined) return <>{text}</>;
  const line = tokens?.[index - 1];
  return line ? <CodeTokens line={line} /> : <>{text}</>;
}

export default function FileCompare({ target, onClose }: { target: CompareTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const [frame, setFrame] = useState<FileVersionsFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CompareMode>("split");
  /** Folds the user opened in `hunks`; per file, so a new file starts collapsed. */
  const [openGaps, setOpenGaps] = useState<ReadonlySet<number>>(() => new Set());
  const scroller = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLDivElement | null>(null);
  const scrollRaf = useRef(0);

  useEffect(() => {
    let alive = true;
    setFrame(null);
    setError(null);
    setOpenGaps(new Set());
    fetchGitFileVersions({
      cwd: target.cwd,
      path: target.path,
      oid: target.oid,
      oldPath: target.oldPath,
      staged: target.staged,
    })
      .then((f) => {
        if (!alive) return;
        if (!f.ok) setError(f.error ?? t("gitPage.failed"));
        else setFrame(f);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [target.cwd, target.path, target.oid, target.oldPath, target.staged, t]);

  const lang = langOfPath(target.path);
  const oldText = frame?.oldText ?? "";
  const newText = frame?.newText ?? "";
  const doc = useMemo(() => compareDocument(frame?.patch ?? "", oldText, newText), [frame, oldText, newText]);
  const oldTokens = useCodeTokens(oldText, lang);
  const newTokens = useCodeTokens(newText, lang);

  const shownRows = useMemo(() => doc.rows.slice(0, MAX_RENDER_LINES), [doc]);
  const sections = useMemo(() => hunkSections(shownRows), [shownRows]);
  const lines = useMemo(
    () => buildCompareLines(mode, shownRows, sections, openGaps),
    [mode, shownRows, sections, openGaps],
  );
  const segments = useMemo(() => mapSegments(lines), [lines]);

  /** Viewport box of the minimap, in map coordinates (same height as the scroller). */
  const updateThumb = () => {
    const el = scroller.current;
    const box = thumb.current;
    if (!el || !box) return;
    const visible = el.clientHeight;
    const total = el.scrollHeight;
    if (visible === 0 || total === 0) {
      box.style.height = "0px";
      return;
    }
    box.style.height = `${Math.max(8, Math.min(visible, (visible / total) * visible))}px`;
    box.style.top = `${(el.scrollTop / total) * visible}px`;
  };

  // Every rebuild (file load, mode switch, fold toggle) changes the content
  // height the box is derived from.
  useEffect(() => {
    updateThumb();
  }, [lines]);

  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  const onScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      updateThumb();
    });
  };

  // The minimap IS the scrollbar, so pressing anywhere on the bar grabs it and a
  // press off the box first centres the box on the cursor (native track click).
  const mapDrag = useRef<{ startY: number; startTop: number } | null>(null);

  const onMapPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!el || e.button !== 0) return;
    // A change segment is a jump target, not a grip.
    if ((e.target as HTMLElement).closest(".gp-cmp-map-seg")) return;
    const box = e.currentTarget.getBoundingClientRect();
    const grip = thumb.current?.getBoundingClientRect();
    const onThumb = !!grip && e.clientY >= grip.top && e.clientY <= grip.bottom;
    if (!onThumb) el.scrollTop = ((e.clientY - box.top - (grip?.height ?? 0) / 2) / box.height) * el.scrollHeight;
    mapDrag.current = { startY: e.clientY, startTop: el.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    updateThumb();
  };

  const onMapPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    const drag = mapDrag.current;
    if (!el || !drag) return;
    el.scrollTop = drag.startTop + ((e.clientY - drag.startY) / e.currentTarget.getBoundingClientRect().height) * el.scrollHeight;
  };

  const endMapDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!mapDrag.current) return;
    mapDrag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  /** Puts `lineIndex` at the top of the scroller, without touching ancestors. */
  const jumpTo = (lineIndex: number) => {
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>(`[data-gp-line="${lineIndex}"]`);
    if (!el || !row) return;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  };

  const switchMode = (next: CompareMode) => {
    setMode(next);
    // The TUI resets both offsets when the view changes; a stale offset in a
    // different row count lands somewhere arbitrary.
    if (scroller.current) {
      scroller.current.scrollTop = 0;
      scroller.current.scrollLeft = 0;
    }
  };

  const toggleGap = (gap: number) =>
    setOpenGaps((prev) => {
      const next = new Set(prev);
      if (!next.delete(gap)) next.add(gap);
      return next;
    });

  const shortOid = target.oid ? target.oid.slice(0, 7) : "";
  const oldLabel = target.oid
    ? `${shortOid}^`
    : target.staged
      ? "HEAD"
      : t("gitPage.indexSide");
  const newLabel = target.oid
    ? shortOid
    : target.staged
      ? t("gitPage.indexSide")
      : t("gitPage.worktreeSide");

  const splitRow = (row: DiffRow, lineIndex: number) => (
    <div key={lineIndex} className="gp-cmp-row gp-cmp-row-split" data-gp-line={lineIndex}>
      <span className="gp-cmp-gutter" aria-hidden="true">{row.oldNo ?? ""}</span>
      <code
        className={"gp-cmp-code" + (row.kind === "del" || row.kind === "change" ? " gp-cmp-old" : "")}
        title={row.oldText}
      >
        <CodeLine tokens={oldTokens} index={row.oldNo} text={row.oldText} />
      </code>
      <span className="gp-cmp-gutter" aria-hidden="true">{row.newNo ?? ""}</span>
      <code
        className={"gp-cmp-code" + (row.kind === "add" || row.kind === "change" ? " gp-cmp-new" : "")}
        title={row.newText}
      >
        <CodeLine tokens={newTokens} index={row.newNo} text={row.newText} />
      </code>
    </div>
  );

  const inlineRow = (line: InlineLine, lineIndex: number) => {
    // One gutter per line: the old side shows its old number, the new side its new
    // one, a context line the new one (both numbers differ only inside a change).
    const no = line.side === "old" ? line.oldNo : line.side === "new" ? line.newNo : (line.newNo ?? line.oldNo);
    return (
      <div key={lineIndex} className="gp-cmp-row gp-cmp-row-inline" data-gp-line={lineIndex}>
        <span className="gp-cmp-gutter" aria-hidden="true">{no ?? ""}</span>
        <code
          className={"gp-cmp-code" + (line.side === "old" ? " gp-cmp-old" : line.side === "new" ? " gp-cmp-new" : "")}
          title={line.text}
        >
          {line.side === "old"
            ? <CodeLine tokens={oldTokens} index={line.oldNo} text={line.text} />
            : <CodeLine tokens={newTokens} index={line.newNo} text={line.text} />}
        </code>
      </div>
    );
  };

  const renderLine = (line: CompareLine, lineIndex: number) => {
    if (line.type === "split") return splitRow(line.row, lineIndex);
    if (line.type === "inline") return inlineRow(line.line, lineIndex);
    if (line.type === "header") {
      return <div key={lineIndex} className="gp-cmp-hunk" data-gp-line={lineIndex}>{line.text}</div>;
    }
    return (
      <button
        key={lineIndex}
        type="button"
        className="gp-cmp-fold"
        data-gp-line={lineIndex}
        onClick={() => toggleGap(line.gap)}
      >
        {line.open
          ? t("gitPage.compareCollapse")
          : t("gitPage.compareFolded", { n: line.count })}
      </button>
    );
  };

  const total = Math.max(1, lines.length);

  return (
    <div className="gp-compare">
      <div className="gp-compare-bar">
        <Icon name="file" size={13} style={{ color: "var(--faint)" }} />
        <span className="gp-compare-path" title={target.path}>{target.path}</span>
        <span className="sp" />
        {frame?.truncated && <span className="gp-cmp-note">{t("gitPage.compareTruncated")}</span>}
        <div className="gp-cmp-modes" role="group" aria-label={t("gitPage.viewMode")}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={"gp-cmp-mode" + (mode === m.id ? " on" : "")}
              aria-pressed={mode === m.id}
              onClick={() => switchMode(m.id)}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" title={t("gitPage.compareClose")} onClick={onClose}>
          <Icon name="xmark" size={15} />
        </button>
      </div>
      {error ? (
        <div className="gp-empty gp-error">{error}</div>
      ) : !frame ? (
        <div className="gp-empty">{t("common.loading")}</div>
      ) : frame.binary ? (
        <div className="gp-empty">{t("gitPage.fileBinary")}</div>
      ) : (
        <div className="gp-compare-body">
          <div className="gp-cmp-main">
            {mode === "split" && (
              <div className="gp-cmp-heads">
                <div className="gp-cmp-head">
                  <span className="gp-cmp-side-label">{oldLabel}</span>
                  <span className="gp-cmp-side-count">{t("gitPage.compareLines", { n: splitLines(oldText).length })}</span>
                </div>
                <div className="gp-cmp-head">
                  <span className="gp-cmp-side-label">{newLabel}</span>
                  <span className="gp-cmp-side-count">{t("gitPage.compareLines", { n: splitLines(newText).length })}</span>
                </div>
              </div>
            )}
            <div className="gp-cmp-scroll" ref={scroller} onScroll={onScroll}>
              {lines.map(renderLine)}
              {doc.rows.length > MAX_RENDER_LINES && (
                <div className="gp-cmp-more">
                  {t("gitPage.compareOmitted", { n: doc.rows.length - MAX_RENDER_LINES })}
                </div>
              )}
            </div>
          </div>
          <div
            className="gp-cmp-map"
            title={t("gitPage.minimap")}
            onPointerDown={onMapPointerDown}
            onPointerMove={onMapPointerMove}
            onPointerUp={endMapDrag}
            onPointerCancel={endMapDrag}
          >
            {segments.map((seg) => (
              <button
                key={seg.startLine}
                type="button"
                className={"gp-cmp-map-seg " + seg.tone}
                aria-label={t("gitPage.minimap")}
                style={{
                  top: `${(seg.startLine / total) * 100}%`,
                  height: `${(seg.lines / total) * 100}%`,
                }}
                onClick={() => jumpTo(seg.startLine)}
              />
            ))}
            <div className="gp-cmp-map-thumb" ref={thumb} />
          </div>
        </div>
      )}
    </div>
  );
}
