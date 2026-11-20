// Right column of the context viewer: entry header, metadata rows, and the
// paged body with source markers (ported from omp-studio's ContextEntryPane).
import { useEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "../../store/index";
import { t } from "../../i18n";
import Icon from "../../Icon";
import type { ContextViewEntrySummary, ContextViewSourceMarker } from "../../types/frames";
import { CATEGORY_GROUP, CATEGORY_TINT, compactTokens, entryTokenLabel, formatEntryTime } from "./contextViewMath";

export function ContextEntryPane({
  entry,
  body,
  sourceMarkers = [],
  totalChars,
  nextBody,
  entryTruncated,
  bodyState,
  onMore,
  onOpenSource,
  focusRequested = false,
  hidden = false,
  onBack,
}: {
  entry?: ContextViewEntrySummary | undefined;
  body: string;
  sourceMarkers?: readonly ContextViewSourceMarker[];
  totalChars: number;
  nextBody?: number | undefined;
  entryTruncated: boolean;
  bodyState: "idle" | "loading" | "error";
  onMore(): void;
  onOpenSource?: (marker: ContextViewSourceMarker) => void;
  focusRequested?: boolean;
  hidden?: boolean;
  onBack?: (() => void) | undefined;
}) {
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const zh = lang === "zh-CN";
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusRequested) {
      focused.current = undefined;
      return;
    }
    if (!entry || bodyState === "loading" || focused.current === entry.id) return;
    focused.current = entry.id;
    bodyRef.current?.focus({ preventScroll: true });
  }, [entry, bodyState, focusRequested]);
  if (!entry)
    return (
      <section className="cv-right" hidden={hidden} aria-label={t("contextViewer.a11y.content")}>
        <div className="cv-empty-pane">
          <p>{t("contextViewer.entry.placeholder")}</p>
          <p className="cv-note">{t("contextViewer.entry.placeholderHint")}</p>
        </div>
      </section>
    );
  const group = entry.thinkingGroup;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const marker of sourceMarkers) {
    if (marker.start < cursor || marker.end > body.length) continue;
    const text = body.slice(marker.start, marker.end);
    content.push(body.slice(cursor, marker.start));
    const shared = {
      className: "cv-source-mark",
      "data-context-group": CATEGORY_GROUP[marker.category],
      style: { borderColor: CATEGORY_TINT[marker.category] },
    };
    content.push(
      marker.entryId && onOpenSource ? (
        <button
          key={`${marker.start}:${marker.end}`}
          type="button"
          {...shared}
          aria-label={`${t("contextViewer.entry.openSource")}: ${text}`}
          title={t("contextViewer.entry.openSource")}
          onClick={() => onOpenSource(marker)}
        >
          {text}
        </button>
      ) : (
        <span key={`${marker.start}:${marker.end}`} {...shared} title={t("contextViewer.entry.sourceUnavailable")}>
          {text}
        </span>
      ),
    );
    cursor = marker.end;
  }
  content.push(body.slice(cursor));
  return (
    <section className="cv-right" hidden={hidden} aria-label={t("contextViewer.a11y.content")}>
      <header className="cv-entry-bar">
        {onBack ? (
          <button type="button" className="icon-btn cv-back" aria-label={t("contextViewer.back")} title={t("contextViewer.back")} onClick={onBack}>
            <Icon name="chevronLeft" size={15} />
          </button>
        ) : null}
        <h3>{entry.label}</h3>
        <div className="cv-chips">
          {group ? (
            <span className="cv-chip">{t("contextViewer.entry.groupChip", { tokens: `${compactTokens(group.tokens)} tokens` })}</span>
          ) : (
            <span className="cv-chip">{entryTokenLabel(entry, zh)}</span>
          )}
          {entry.interrupted ? <span className="cv-chip amber">{t("contextViewer.entry.interrupted")}</span> : null}
          {entryTruncated ? <span className="cv-chip amber">{t("contextViewer.entry.truncated")}</span> : null}
        </div>
      </header>
      <dl className="cv-meta">
        {entry.path ? (
          <div>
            <dt>{t("contextViewer.entry.path")}</dt>
            <dd>{entry.path}</dd>
          </div>
        ) : null}
        {entry.info ? (
          <div>
            <dt>{t("contextViewer.entry.source")}</dt>
            <dd>{entry.info}</dd>
          </div>
        ) : null}
        {entry.callId ? (
          <div>
            <dt>{t("contextViewer.entry.callId")}</dt>
            <dd><code>{entry.callId}</code></dd>
          </div>
        ) : null}
        {entry.timestamp === undefined ? null : (
          <div>
            <dt>{t("contextViewer.entry.time")}</dt>
            <dd>{formatEntryTime(entry.timestamp, zh ? "zh-CN" : "en-US")}</dd>
          </div>
        )}
      </dl>
      {group ? <p className="cv-note cv-shared">{t("contextViewer.entry.sharedGroup")}</p> : null}
      <pre ref={bodyRef} className="cv-body-scroll" tabIndex={0}>{content}</pre>
      <footer className="cv-entry-foot">
        <span>{t("contextViewer.entry.progress", { shown: body.length.toLocaleString(), total: totalChars.toLocaleString() })}</span>
        {bodyState === "loading" ? <span className="cv-loading">{t("contextViewer.list.loading")}</span> : null}
        {nextBody === undefined ? null : (
          <button type="button" className="cv-btn" disabled={bodyState === "loading"} onClick={onMore}>
            {t("contextViewer.entry.loadMore")}
          </button>
        )}
      </footer>
    </section>
  );
}
