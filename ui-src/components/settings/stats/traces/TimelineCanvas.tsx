import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TraceSpan, TraceSpanKind, TraceTrack } from "../types";
import type { TraceScale } from "./time-scale";
import { useTraceTheme } from "./trace-colors";
import type { TimelineViewport } from "./Minimap";
export type { TimelineViewport } from "./Minimap";
import {
  buildLayout,
  draw,
  renderTooltip,
  type Hit,
  type HoverState,
  type TooltipLabels,
  GUTTER_W,
  HEADER_H,
  LANE_H,
  MIN_WINDOW_U,
} from "./timeline-draw";

export interface TimelineCanvasProps {
  tracks: TraceTrack[];
  scale: TraceScale;
  viewport: TimelineViewport;
  onViewportChange: (viewport: TimelineViewport) => void;
  selection: string | null;
  onSelect: (spanId: string | null) => void;
  search: string;
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (trackId: string) => void;
  traceStart: number;
}

export function TimelineCanvas({
  tracks,
  scale,
  viewport,
  onViewportChange,
  selection,
  onSelect,
  search,
  collapsed,
  onToggleCollapse,
  traceStart,
}: TimelineCanvasProps) {
  const { t } = useTranslation();
  const colors = useTraceTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const [hover, setHover] = useState<HoverState | null>(null);
  const hitsRef = useRef<Hit[]>([]);
  const dragRef = useRef<{ pointerId: number; lastX: number; moved: boolean } | null>(null);
  const hoverXRef = useRef<number | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const laneLabels = useMemo<Record<TraceSpanKind, string>>(
    () => ({
      turn: t("settingsPage.stats.traceView.timeline.laneInput"),
      model: t("settingsPage.stats.traceView.timeline.laneModel"),
      tool: t("settingsPage.stats.traceView.timeline.laneTools"),
      subagent: t("settingsPage.stats.traceView.timeline.laneAgents"),
      background: t("settingsPage.stats.traceView.timeline.laneBackground"),
    }),
    [t],
  );
  const tooltipLabels = useMemo<TooltipLabels>(
    () => ({
      unterminated: t("settingsPage.stats.traceView.tooltip.unterminated"),
      tok: t("settingsPage.stats.traceView.tooltip.tok"),
      error: t("settingsPage.stats.traceView.tooltip.error"),
    }),
    [t],
  );

  const layout = useMemo(() => buildLayout(tracks, collapsed, laneLabels), [tracks, collapsed, laneLabels]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.max(100, Math.floor(entries[0].contentRect.width - GUTTER_W));
      setCanvasWidth(width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const clampViewport = useCallback(
    (u0: number, u1: number): TimelineViewport => {
      const [d0, d1] = scale.domain;
      let span = Math.max(MIN_WINDOW_U, u1 - u0);
      span = Math.min(span, d1 - d0 || MIN_WINDOW_U);
      let start = u0;
      if (start < d0) start = d0;
      if (start + span > d1) start = d1 - span;
      return { u0: start, u1: start + span };
    },
    [scale],
  );

  const applyViewport = useCallback(
    (next: TimelineViewport) => {
      viewportRef.current = next;
      onViewportChange(next);
    },
    [onViewportChange],
  );

  const zoomAt = useCallback(
    (factor: number, anchorPx: number | null) => {
      const width = canvasWidth;
      const { u0, u1 } = viewportRef.current;
      const span = u1 - u0;
      const anchorFrac = anchorPx === null ? 0.5 : Math.min(1, Math.max(0, anchorPx / width));
      const anchorU = u0 + span * anchorFrac;
      const nextSpan = span * factor;
      applyViewport(clampViewport(anchorU - nextSpan * anchorFrac, anchorU + nextSpan * (1 - anchorFrac)));
    },
    [canvasWidth, applyViewport, clampViewport],
  );

  const panBy = useCallback(
    (deltaU: number) => {
      const { u0, u1 } = viewportRef.current;
      applyViewport(clampViewport(u0 + deltaU, u1 + deltaU));
    },
    [applyViewport, clampViewport],
  );

  const zoomToSpan = useCallback(
    (span: TraceSpan) => {
      const s = scale.toU(span.start);
      const e = scale.toU(span.end);
      const pad = Math.max((e - s) * 0.1, MIN_WINDOW_U / 2);
      applyViewport(clampViewport(s - pad, e + pad));
    },
    [scale, applyViewport, clampViewport],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      hoverXRef.current = x;
      setHover(null);
      const width = canvas.clientWidth || 1;
      const spanU = () => viewportRef.current.u1 - viewportRef.current.u0;
      if (event.shiftKey) {
        const deltaPx = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        panBy((deltaPx / width) * spanU());
        return;
      }
      if (event.deltaX !== 0) panBy((event.deltaX / width) * spanU());
      if (event.deltaY !== 0) zoomAt(1.0015 ** event.deltaY, x);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [zoomAt, panBy]);

  const hitAt = useCallback((clientX: number, clientY: number): Hit | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const hits = hitsRef.current;
    for (let i = hits.length - 1; i >= 0; i--) {
      const hit = hits[i];
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) return hit;
    }
    return null;
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, moved: false };
    event.currentTarget.focus();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    hoverXRef.current = event.clientX - rect.left;
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const deltaX = event.clientX - drag.lastX;
      if (Math.abs(deltaX) > 0) {
        if (Math.abs(deltaX) > 2) drag.moved = true;
        drag.lastX = event.clientX;
        const span = viewportRef.current.u1 - viewportRef.current.u0;
        panBy((-deltaX / (canvasWidth || 1)) * span);
      }
      setHover(null);
      return;
    }
    const hit = hitAt(event.clientX, event.clientY);
    setHover(hit ? { hit, clientX: event.clientX, clientY: event.clientY } : null);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) return;
    const hit = hitAt(event.clientX, event.clientY);
    if (hit?.kind === "span") onSelect(hit.span.id);
    else onSelect(null);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(event.clientX, event.clientY);
    if (hit?.kind === "span") zoomToSpan(hit.span);
  };

  const selectSibling = useCallback(
    (direction: 1 | -1) => {
      if (!selection) return;
      for (const lane of layout.lanes) {
        const index = lane.spans.findIndex((span) => span.id === selection);
        if (index === -1) continue;
        const next = lane.spans[index + direction];
        if (!next) return;
        onSelect(next.id);
        const u = scale.toU(next.start);
        if (u < viewport.u0 || u > viewport.u1) {
          const span = viewport.u1 - viewport.u0;
          onViewportChange(clampViewport(u - span / 2, u + span / 2));
        }
        return;
      }
    },
    [selection, layout, onSelect, scale, viewport, onViewportChange, clampViewport],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const span = viewport.u1 - viewport.u0;
    switch (event.key) {
      case "w":
      case "W":
        zoomAt(1 / 1.3, hoverXRef.current);
        break;
      case "s":
      case "S":
        zoomAt(1.3, hoverXRef.current);
        break;
      case "a":
      case "A":
        panBy(-span * 0.2);
        break;
      case "d":
      case "D":
        panBy(span * 0.2);
        break;
      case "0":
        onViewportChange({ u0: scale.domain[0], u1: scale.domain[1] });
        break;
      case "f":
      case "F": {
        if (!selection) break;
        const selected = tracks.flatMap((track) => track.spans).find((s) => s.id === selection);
        if (selected) zoomToSpan(selected);
        break;
      }
      case "Escape":
        onSelect(null);
        break;
      case ",":
        selectSibling(-1);
        break;
      case ".":
        selectSibling(1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  useEffect(() => {
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const raf = requestAnimationFrame(() => {
      draw(canvas, layout, scale, viewport, colors, {
        width: canvasWidth,
        selection,
        hoverId: hover?.hit.kind === "span" ? hover.hit.span.id : null,
        search,
        hits: hitsRef,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [layout, scale, viewport, colors, canvasWidth, selection, hover, search]);

  const tooltip = hover ? renderTooltip(hover, traceStart, tooltipLabels) : null;

  return (
    <div ref={containerRef} className="traces-timeline">
      <div style={{ width: GUTTER_W, flexShrink: 0, position: "relative", height: layout.totalHeight }}>
        {layout.blocks.map((block) => (
          <div key={block.track.id}>
            <div
              style={{
                position: "absolute",
                top: block.headerY,
                left: 4 + block.depth * 14,
                right: 8,
                height: HEADER_H,
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
              }}
            >
              {block.hasChildren ? (
                <button
                  type="button"
                  onClick={() => onToggleCollapse(block.track.id)}
                  aria-label={
                    collapsed.has(block.track.id)
                      ? t("settingsPage.stats.traceView.timeline.expandTrack", { label: block.track.label })
                      : t("settingsPage.stats.traceView.timeline.collapseTrack", { label: block.track.label })
                  }
                  className="traces-chevron"
                >
                  {collapsed.has(block.track.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : (
                <span style={{ width: 12, flexShrink: 0 }} />
              )}
              <span className="traces-gutter-track truncate" style={{ minWidth: 0 }}>
                {block.track.label}
              </span>
              {block.track.model && (
                <span className="traces-gutter-model mono truncate" style={{ flexShrink: 1, minWidth: 0 }}>
                  {block.track.model}
                </span>
              )}
            </div>
            {block.lanes.map((lane) => (
              <div
                key={`${lane.track.id}:${lane.kind}`}
                className="traces-gutter-lane"
                style={{ top: lane.y, left: 20 + block.depth * 14, lineHeight: `${LANE_H}px` }}
              >
                {lane.label}
              </div>
            ))}
          </div>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        className="traces-canvas"
        width={Math.floor(canvasWidth * devicePixelRatio)}
        height={Math.floor(layout.totalHeight * devicePixelRatio)}
        style={{ width: canvasWidth, height: layout.totalHeight }}
        tabIndex={0}
        role="application"
        aria-label={t("settingsPage.stats.traceView.timelineAriaLabel")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          hoverXRef.current = null;
          setHover(null);
        }}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      />

      {tooltip && createPortal(tooltip, document.body)}
    </div>
  );
}
