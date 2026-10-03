import type React from "react";
import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceMarker, TraceSpan, TraceSpanKind, TraceTrack } from "../types";
import { buildTicks, formatOffset, type TraceScale } from "./time-scale";
import type { TraceTheme } from "./trace-colors";
import type { TimelineViewport } from "./Minimap";

export const RULER_H = 28;
export const HEADER_H = 22;
export const LANE_H = 18;
export const LANE_GAP = 3;
export const TRACK_GAP = 14;
export const GUTTER_W = 200;
export const MIN_WINDOW_U = 10;
export const MIN_SPAN_PX = 2;
export const HIT_SLOP_PX = 4;
export const LABEL_MIN_PX = 56;
export const SPAN_RADIUS = 3;

export const LANE_ORDER: TraceSpanKind[] = ["turn", "model", "tool", "subagent", "background"];

export interface LaneRow {
  track: TraceTrack;
  kind: TraceSpanKind;
  label: string;
  y: number;
  spans: TraceSpan[];
}

export interface TrackBlock {
  track: TraceTrack;
  depth: number;
  hasChildren: boolean;
  headerY: number;
  lanes: LaneRow[];
  y0: number;
  y1: number;
}

export interface TimelineLayout {
  blocks: TrackBlock[];
  lanes: LaneRow[];
  totalHeight: number;
}

export interface SpanHit {
  kind: "span";
  x: number;
  y: number;
  w: number;
  h: number;
  span: TraceSpan;
  track: TraceTrack;
}

export interface MarkerHit {
  kind: "marker";
  x: number;
  y: number;
  w: number;
  h: number;
  marker: TraceMarker;
  track: TraceTrack;
}

export type Hit = SpanHit | MarkerHit;

export interface HoverState {
  hit: Hit;
  clientX: number;
  clientY: number;
}

export interface DrawOptions {
  width: number;
  selection: string | null;
  hoverId: string | null;
  search: string;
  hits: React.MutableRefObject<Hit[]>;
}

export function buildLayout(
  tracks: TraceTrack[],
  collapsed: ReadonlySet<string>,
  laneLabels: Record<TraceSpanKind, string>,
): TimelineLayout {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const hasChildren = new Set<string>();
  for (const track of tracks) {
    if (track.parentId) hasChildren.add(track.parentId);
  }

  const isHidden = (track: TraceTrack): boolean => {
    let parentId = track.parentId;
    while (parentId) {
      if (collapsed.has(parentId)) return true;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return false;
  };

  const blocks: TrackBlock[] = [];
  const lanes: LaneRow[] = [];
  let y = RULER_H + 6;
  for (const track of tracks) {
    if (isHidden(track)) continue;
    const depth = track.id === "main" ? 0 : track.id.split("/").length;
    const block: TrackBlock = {
      track,
      depth,
      hasChildren: hasChildren.has(track.id),
      headerY: y,
      lanes: [],
      y0: y,
      y1: y,
    };
    y += HEADER_H;
    for (const kind of LANE_ORDER) {
      const label = laneLabels[kind];
      const spans = track.spans.filter((span) => span.kind === kind);
      const isCore = kind === "turn" || kind === "model" || kind === "tool";
      if (spans.length === 0 && !(track.id === "main" && isCore)) continue;
      const lane: LaneRow = { track, kind, label, y, spans };
      block.lanes.push(lane);
      lanes.push(lane);
      y += LANE_H + LANE_GAP;
    }
    block.y1 = y - LANE_GAP;
    blocks.push(block);
    y += TRACK_GAP;
  }
  return { blocks, lanes, totalHeight: Math.max(y, RULER_H + 48) };
}

function spanPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  if (w >= SPAN_RADIUS * 2 + 1) ctx.roundRect(x, y, w, h, SPAN_RADIUS);
  else ctx.rect(x, y, w, h);
}

export function draw(
  canvas: HTMLCanvasElement,
  layout: TimelineLayout,
  scale: TraceScale,
  viewport: TimelineViewport,
  colors: TraceTheme,
  options: DrawOptions,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, selection, hoverId, search, hits } = options;
  const height = layout.totalHeight;
  const dpr = devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const { u0, u1 } = viewport;
  const uSpan = Math.max(u1 - u0, 1e-9);
  const toX = (u: number) => ((u - u0) / uSpan) * width;
  const needle = search.trim().toLowerCase();
  const nextHits: Hit[] = [];

  for (const block of layout.blocks) {
    const turnSpans = block.track.spans.filter((span) => span.kind === "turn");
    for (let i = 0; i < turnSpans.length; i++) {
      const bandStart = toX(scale.toU(turnSpans[i].start));
      const bandEnd = i + 1 < turnSpans.length ? toX(scale.toU(turnSpans[i + 1].start)) : width;
      if (bandEnd < 0 || bandStart > width) continue;
      if (i % 2 === 1) {
        ctx.fillStyle = colors.turnBand;
        ctx.fillRect(
          Math.max(0, bandStart),
          block.y0,
          Math.min(width, bandEnd) - Math.max(0, bandStart),
          block.y1 - block.y0,
        );
      }
      if (bandStart >= 0 && bandStart <= width) {
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(bandStart) + 0.5, block.y0);
        ctx.lineTo(Math.round(bandStart) + 0.5, block.y1);
        ctx.stroke();
      }
    }
  }

  for (const gap of scale.gaps) {
    const x = toX(gap.uMid);
    if (x < -24 || x > width + 24) continue;
    ctx.save();
    ctx.strokeStyle = colors.grid;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = colors.tick;
    ctx.font = `9px ${colors.fontMono}`;
    ctx.textAlign = "center";
    ctx.fillText(`⋯ ${formatDurationMs(gap.t1 - gap.t0)}`, x, RULER_H - 4);
    ctx.textAlign = "left";
  }

  ctx.font = `9px ${colors.fontMono}`;
  for (const tick of buildTicks(scale, u0, u1, width)) {
    const x = Math.round(toX(tick.u)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    if (tick.major) {
      ctx.moveTo(x, 4);
      ctx.lineTo(x, height);
    } else {
      ctx.moveTo(x, RULER_H - 8);
      ctx.lineTo(x, RULER_H);
    }
    ctx.stroke();
    ctx.fillStyle = colors.tick;
    if (tick.major) {
      ctx.fillText(tick.label, x + 4, 11);
    } else {
      ctx.globalAlpha = 0.75;
      ctx.fillText(tick.label, x + 3, RULER_H - 10);
      ctx.globalAlpha = 1;
    }
  }
  ctx.strokeStyle = colors.grid;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H + 0.5);
  ctx.lineTo(width, RULER_H + 0.5);
  ctx.stroke();

  for (const lane of layout.lanes) {
    const isTurnLane = lane.kind === "turn";
    for (const span of lane.spans) {
      const uStart = scale.toU(span.start);
      if (uStart > u1) break;
      const uEnd = scale.toU(span.end);
      if (uEnd < u0) continue;
      const x = toX(uStart);
      const w = Math.max(MIN_SPAN_PX, toX(uEnd) - x);
      const y = lane.y;
      const matches = needle === "" || `${span.label} ${span.detail ?? ""}`.toLowerCase().includes(needle);
      const color = colors.category[span.kind];

      ctx.globalAlpha = matches ? 1 : 0.3;
      if (isTurnLane) {
        ctx.fillStyle = color;
        ctx.globalAlpha = (matches ? 1 : 0.3) * 0.23;
        spanPath(ctx, x, y, w, LANE_H);
        ctx.fill();
        ctx.globalAlpha = matches ? 1 : 0.3;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 2, LANE_H);
      } else {
        ctx.fillStyle = color;
        spanPath(ctx, x, y, w, LANE_H);
        ctx.fill();
      }
      if (span.isError) {
        ctx.fillStyle = colors.errorSoft;
        spanPath(ctx, x, y, w, LANE_H);
        ctx.fill();
        ctx.fillStyle = colors.error;
        ctx.fillRect(x, y, 2, LANE_H);
      }
      if (span.kind === "model" && typeof span.ttft === "number" && span.ttft > 0 && w > 20) {
        const ttftX = toX(scale.toU(span.start + span.ttft));
        if (ttftX > x + 1 && ttftX < x + w - 1) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(ttftX, y + 3, 1, LANE_H - 6);
        }
      }
      if (span.unterminated) {
        ctx.save();
        ctx.strokeStyle = colors.tick;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x + w - 0.5, y);
        ctx.lineTo(x + w - 0.5, y + LANE_H);
        ctx.stroke();
        ctx.restore();
      }
      if (hoverId === span.id) {
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        spanPath(ctx, x, y, w, LANE_H);
        ctx.fill();
      }
      if (selection === span.id) {
        ctx.strokeStyle = colors.selection;
        ctx.lineWidth = 1.5;
        spanPath(ctx, x - 1, y - 1, w + 2, LANE_H + 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      if (w > LABEL_MIN_PX) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 3, y, w - 6, LANE_H);
        ctx.clip();
        ctx.fillStyle = isTurnLane ? colors.tick : colors.spanText;
        ctx.font = `10px ${colors.fontSans}`;
        ctx.fillText(span.label, x + 5, y + LANE_H - 5);
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      const hitW = Math.max(w, HIT_SLOP_PX);
      nextHits.push({ kind: "span", x: x - (hitW - w) / 2, y, w: hitW, h: LANE_H, span, track: lane.track });
    }
  }

  for (const block of layout.blocks) {
    for (const marker of block.track.markers) {
      const x = toX(scale.toU(marker.time));
      if (x < -6 || x > width + 6) continue;
      const cy = block.headerY + HEADER_H / 2;
      ctx.fillStyle = colors.marker;
      ctx.beginPath();
      ctx.moveTo(x, cy - 4);
      ctx.lineTo(x + 4, cy);
      ctx.lineTo(x, cy + 4);
      ctx.lineTo(x - 4, cy);
      ctx.closePath();
      ctx.fill();
      nextHits.push({ kind: "marker", x: x - 5, y: cy - 5, w: 10, h: 10, marker, track: block.track });
    }
  }

  hits.current = nextHits;
}

export interface TooltipLabels {
  unterminated: string;
  tok: string;
  error: string;
}

export function renderTooltip(hover: HoverState, traceStart: number, labels: TooltipLabels): React.ReactElement {
  const left = Math.min(hover.clientX + 14, window.innerWidth - 320);
  const top = hover.clientY + 16 > window.innerHeight - 140 ? hover.clientY - 120 : hover.clientY + 16;
  const style: React.CSSProperties = { left, top };

  if (hover.hit.kind === "marker") {
    const { marker } = hover.hit;
    return (
      <div className="traces-tooltip" style={style}>
        <div className="traces-tooltip-title">{marker.label}</div>
        <div className="muted num">
          {new Date(marker.time).toLocaleTimeString()} ({formatOffset(marker.time - traceStart)})
        </div>
      </div>
    );
  }

  const { span } = hover.hit;
  return (
    <div className="traces-tooltip" style={style}>
      <div className="traces-tooltip-title truncate">{span.label}</div>
      <div className="muted num">
        {formatDurationMs(span.end - span.start)} · {new Date(span.start).toLocaleTimeString()} (
        {formatOffset(span.start - traceStart)}){span.unterminated ? ` · ${labels.unterminated}` : ""}
      </div>
      {span.kind === "model" && (
        <div className="muted num">
          {span.tokens !== undefined && <>{formatInteger(span.tokens)}{labels.tok}</>}
          {span.cost !== undefined && <> · ${span.cost.toFixed(4)}</>}
          {span.ttft !== undefined && <> · TTFT {formatDurationMs(span.ttft)}</>}
          {span.isError && <> · {labels.error}</>}
        </div>
      )}
      {span.kind === "subagent" && span.model && <div className="muted num">{span.model}</div>}
      {span.detail && <div className="traces-tooltip-detail">{span.detail}</div>}
    </div>
  );
}
