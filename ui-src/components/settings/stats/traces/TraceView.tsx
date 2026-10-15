import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSessionTrace } from "../api";
import { useQuery } from "../data/query";
import type { TraceSpan, TraceSpanKind, TraceTrack } from "../types";
import { Card, ChartSkeleton, PageHeader, QueryView, SearchInput, Segmented } from "../ui";
import { AggregatesPanel } from "./AggregatesPanel";
import { Minimap } from "./Minimap";
import { SpanDrawer } from "./SpanDrawer";
import { SummaryStrip } from "./SummaryStrip";
import { TimelineCanvas, type TimelineViewport } from "./TimelineCanvas";
import { TranscriptList } from "./TranscriptList";
import { CATEGORY_VARS } from "./trace-colors";
import { type AxisMode, buildScale } from "./time-scale";

export interface TraceViewProps {
  file: string;
  active: boolean;
  onBack: () => void;
}

const MODE_VALUES: AxisMode[] = ["time", "turns", "calls"];

const LEGEND_KINDS: TraceSpanKind[] = ["turn", "model", "tool", "subagent", "background"];

export function TraceView({ file, active, onBack }: TraceViewProps) {
  const { t } = useTranslation();
  const query = useQuery(["trace", file], () => getSessionTrace(file), { pollMs: 15000, enabled: active });
  const trace = query.stale ? null : query.data;

  const [mode, setMode] = useState<AxisMode>("time");
  const [compressIdle, setCompressIdle] = useState(true);
  const [selection, setSelection] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [viewport, setViewport] = useState<TimelineViewport | null>(null);

  const tracks = useMemo(() => trace?.tracks ?? [], [trace]);
  const scale = useMemo(() => buildScale(tracks, mode, compressIdle), [tracks, mode, compressIdle]);
  const scaleRef = useRef(scale);

  const modeOptions = useMemo(
    () =>
      MODE_VALUES.map((value) => ({
        value,
        label: t(`settingsPage.stats.traceView.mode.${value}`),
        title: t(`settingsPage.stats.traceView.mode.${value}Title`),
      })),
    [t],
  );
  const legendItems = useMemo(
    () => LEGEND_KINDS.map((kind) => ({ kind, label: t(`settingsPage.stats.traceView.legend.${kind}`) })),
    [t],
  );

  const lastFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!trace) return;
    if (lastFileRef.current === trace.file) return;
    lastFileRef.current = trace.file;
    setSelection(null);
    setSearch("");
    setViewport(null);
    const deep = new Set<string>();
    for (const track of trace.tracks) {
      const depth = track.id === "main" ? 0 : track.id.split("/").length;
      if (depth >= 1) deep.add(track.id);
    }
    setCollapsed(deep);
  }, [trace]);

  useEffect(() => {
    const prev = scaleRef.current;
    scaleRef.current = scale;
    setViewport(current => {
      if (!current) return current;
      const t0 = prev.toT(current.u0);
      const t1 = prev.toT(current.u1);
      const u0 = scale.toU(t0);
      const u1 = scale.toU(t1);
      return u1 - u0 > 0 ? { u0, u1 } : null;
    });
  }, [scale]);

  const effectiveViewport: TimelineViewport = viewport ?? { u0: scale.domain[0], u1: scale.domain[1] };

  const allSpans = useMemo(() => {
    const spans: Array<{ span: TraceSpan; track: TraceTrack }> = [];
    for (const track of tracks) {
      for (const span of track.spans) spans.push({ span, track });
    }
    spans.sort((a, b) => a.span.start - b.span.start);
    return spans;
  }, [tracks]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    return allSpans.filter(({ span }) => `${span.label} ${span.detail ?? ""}`.toLowerCase().includes(needle));
  }, [allSpans, search]);

  const centerOnSpan = useCallback(
    (span: TraceSpan) => {
      const u = scale.toU(span.start);
      const uEnd = scale.toU(span.end);
      setViewport(current => {
        const vp = current ?? { u0: scale.domain[0], u1: scale.domain[1] };
        if (u >= vp.u0 && uEnd <= vp.u1) return current;
        const window = vp.u1 - vp.u0;
        const mid = (u + uEnd) / 2;
        const [d0, d1] = scale.domain;
        let u0 = mid - window / 2;
        if (u0 < d0) u0 = d0;
        if (u0 + window > d1) u0 = Math.max(d0, d1 - window);
        return { u0, u1: u0 + window };
      });
    },
    [scale],
  );

  const selectAndReveal = useCallback(
    (spanId: string) => {
      setSelection(spanId);
      const found = allSpans.find(({ span }) => span.id === spanId);
      if (found) centerOnSpan(found.span);
    },
    [allSpans, centerOnSpan],
  );

  const selectAndOpen = useCallback((spanId: string | null) => {
    setSelection(spanId);
    setDrawerOpen(spanId !== null);
  }, []);

  const cycleMatch = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (((matchIndex + direction) % matches.length) + matches.length) % matches.length;
      setMatchIndex(next);
      selectAndReveal(matches[next].span.id);
    },
    [matches, matchIndex, selectAndReveal],
  );

  const toggleCollapse = useCallback((trackId: string) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  const selected = useMemo(() => {
    if (!selection) return null;
    return allSpans.find(({ span }) => span.id === selection) ?? null;
  }, [selection, allSpans]);

  const openChildTrack = useCallback(
    (childTrackId: string) => {
      const child = tracks.find(track => track.id === childTrackId);
      const first = child?.spans[0];
      setCollapsed(current => {
        const next = new Set(current);
        let cursor = child;
        while (cursor?.parentId) {
          next.delete(cursor.parentId);
          cursor = tracks.find(track => track.id === cursor?.parentId);
        }
        return next;
      });
      if (first) selectAndReveal(first.id);
    },
    [tracks, selectAndReveal],
  );

  const collapseAll = useCallback(
    (collapse: boolean) => {
      if (!collapse) {
        setCollapsed(new Set());
        return;
      }
      const all = new Set<string>();
      for (const track of tracks) {
        if (track.id !== "main") all.add(track.id);
      }
      setCollapsed(all);
    },
    [tracks],
  );

  const traceStart = trace?.startedAt ?? 0;
  const traceQuery = { ...query, data: trace };

  return (
    <div className="stack traces-view">
      <div>
        <button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t("settingsPage.stats.traceView.back")}
        </button>
      </div>
      <PageHeader
        title={<span className="traces-title truncate">{trace?.title ?? file.split("/").pop()}</span>}
        description={trace?.cwd ? <span className="mono">{trace.cwd}</span> : undefined}
        actions={
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-icon="true"
            onClick={query.refetch}
            aria-label={t("settingsPage.stats.traceView.refreshTrace")}
            title={t("settingsPage.stats.traceView.refreshTrace")}
          >
            <RefreshCw size={14} className={query.refreshing ? "traces-spin" : undefined} />
          </button>
        }
      />

      <QueryView query={traceQuery} skeleton={<ChartSkeleton height={420} />}>
        {loaded => (
          <>
            <SummaryStrip summary={loaded.summary} />

            <Card
              index={1}
              title={t("settingsPage.stats.traceView.timelineTitle")}
              description={t("settingsPage.stats.traceView.timelineHint")}
              actions={
                <>
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={() => collapseAll(false)}
                  >
                    {t("settingsPage.stats.traceView.expandAll")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={() => collapseAll(true)}
                  >
                    {t("settingsPage.stats.traceView.collapseAll")}
                  </button>
                </>
              }
            >
              <div className="stack">
                <div className="traces-toolbar">
                  <Segmented
                    options={modeOptions}
                    value={mode}
                    onChange={setMode}
                    size="sm"
                    aria-label={t("settingsPage.stats.traceView.axisMode")}
                  />
                  {mode === "time" && (
                    <label className="traces-check">
                      <input
                        type="checkbox"
                        checked={compressIdle}
                        onChange={event => setCompressIdle(event.target.checked)}
                      />
                      {t("settingsPage.stats.traceView.compressIdle")}
                    </label>
                  )}
                  <div className="traces-search">
                    <SearchInput
                      value={search}
                      onChange={value => {
                        setSearch(value);
                        setMatchIndex(0);
                      }}
                      placeholder={t("settingsPage.stats.traceView.searchSpans")}
                      width={200}
                    />
                    {search.trim() && (
                      <>
                        <span className="num muted traces-match-count">
                          {matches.length === 0
                            ? "0"
                            : `${(matchIndex % Math.max(matches.length, 1)) + 1}/${matches.length}`}
                        </span>
                        <button
                          type="button"
                          className="btn"
                          data-variant="ghost"
                          data-size="sm"
                          data-icon="true"
                          onClick={() => cycleMatch(-1)}
                          aria-label={t("settingsPage.stats.traceView.prevMatch")}
                          disabled={matches.length === 0}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn"
                          data-variant="ghost"
                          data-size="sm"
                          data-icon="true"
                          onClick={() => cycleMatch(1)}
                          aria-label={t("settingsPage.stats.traceView.nextMatch")}
                          disabled={matches.length === 0}
                        >
                          <ChevronRight size={14} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="traces-legend">
                    {legendItems.map(item => (
                      <span key={item.kind} className="traces-legend-item">
                        <span
                          className="swatch"
                          style={{ background: `var(${CATEGORY_VARS[item.kind]})` }}
                        />
                        {item.label}
                      </span>
                    ))}
                  </div>
                </div>
                <Minimap
                  tracks={tracks}
                  scale={scale}
                  viewport={effectiveViewport}
                  onViewportChange={setViewport}
                />
                <TimelineCanvas
                  tracks={tracks}
                  scale={scale}
                  viewport={effectiveViewport}
                  onViewportChange={setViewport}
                  selection={selection}
                  onSelect={selectAndOpen}
                  search={search}
                  collapsed={collapsed}
                  onToggleCollapse={toggleCollapse}
                  traceStart={traceStart}
                />
              </div>
            </Card>

            <Card
              index={2}
              title={t("settingsPage.stats.traceView.transcriptTitle")}
              description={t("settingsPage.stats.traceView.transcriptDesc")}
              flush
            >
              <TranscriptList
                tracks={tracks}
                selection={selection}
                onSelect={spanId => {
                  selectAndReveal(spanId);
                  setDrawerOpen(true);
                }}
                search={search}
                traceStart={traceStart}
              />
            </Card>
            <AggregatesPanel toolStats={loaded.summary.toolStats} index={3} />
          </>
        )}
      </QueryView>

      <SpanDrawer
        span={drawerOpen ? (selected?.span ?? null) : null}
        track={selected?.track ?? null}
        onClose={() => setDrawerOpen(false)}
        onOpenChildTrack={openChildTrack}
      />
    </div>
  );
}
