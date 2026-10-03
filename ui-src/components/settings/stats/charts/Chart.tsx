import { Fragment, type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCompact } from "../data/formatters";
import type { ChartKind, ChartSeries, ReferenceLine } from "./types";
import { useWidth } from "./useWidth";

export interface ChartProps {
  slots: number;
  tickLabel: (index: number) => string;
  tooltipTitle?: (index: number) => string;
  series: readonly ChartSeries[];
  kind?: ChartKind;
  stacked?: boolean;
  height?: number;
  format?: (value: number) => string;
  formatRight?: (value: number) => string;
  formatTooltip?: (value: number) => string;
  yMax?: number;
  yMaxRight?: number;
  hidden?: ReadonlySet<string>;
  showTotal?: boolean;
  references?: readonly ReferenceLine[];
  onSelect?: (index: number) => void;
  emptyLabel?: ReactNode;
  tooltipExtra?: (index: number) => ReactNode;
}

const PAD_TOP = 10;
const PAD_BOTTOM = 24;
const MIN_TICK_SPACING = 68;
const Y_TICKS = 4;

export function Chart({
  slots,
  tickLabel,
  tooltipTitle,
  series,
  kind = "bars",
  stacked = true,
  height = 220,
  format = formatCompact,
  formatRight,
  formatTooltip,
  yMax,
  yMaxRight,
  hidden,
  showTotal,
  references,
  onSelect,
  emptyLabel,
  tooltipExtra,
}: ChartProps) {
  const { t } = useTranslation();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const patternId = useId().replace(/:/g, "");

  const visible = useMemo(() => series.filter((s) => !hidden?.has(s.key)), [series, hidden]);

  const layout = useMemo(() => {
    const left = visible.filter((s) => s.axis !== "right");
    const right = visible.filter((s) => s.axis === "right");
    const stackable = (s: ChartSeries) => stacked && (s.kind ?? kind) !== "line";

    const bases = new Map<string, number[]>();
    const tops = Array.from({ length: slots }, () => 0);
    let leftMax = 0;
    for (const s of left) {
      if (stackable(s)) {
        const base = tops.slice();
        bases.set(s.key, base);
        for (let i = 0; i < slots; i++) tops[i] += s.values[i] ?? 0;
      } else {
        for (let i = 0; i < slots; i++) leftMax = Math.max(leftMax, s.values[i] ?? 0);
      }
    }
    for (const top of tops) leftMax = Math.max(leftMax, top);
    let rightMax = 0;
    for (const s of right) for (let i = 0; i < slots; i++) rightMax = Math.max(rightMax, s.values[i] ?? 0);
    for (const r of references ?? []) {
      if (r.axis === "right") rightMax = Math.max(rightMax, r.value);
      else leftMax = Math.max(leftMax, r.value);
    }

    const leftScale = niceScale(yMax ?? leftMax);
    const rightScale = right.length > 0 ? niceScale(yMaxRight ?? rightMax) : null;
    const empty = visible.every((s) => s.values.every((v) => !v));
    return { left, right, bases, stackable, leftScale, rightScale, empty };
  }, [visible, slots, stacked, kind, yMax, yMaxRight, references]);

  const leftLabels = layout.leftScale.ticks.map((t) => format(t));
  const rightLabels = layout.rightScale?.ticks.map((t) => (formatRight ?? format)(t)) ?? [];
  const padLeft = Math.max(28, labelWidth(leftLabels) + 12);
  const padRight = layout.rightScale ? Math.max(28, labelWidth(rightLabels) + 12) : 8;
  const plotW = Math.max(0, width - padLeft - padRight);
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const slotW = slots > 0 ? plotW / slots : 0;
  const yLeft = (v: number) => PAD_TOP + plotH - (v / layout.leftScale.max) * plotH;
  const yRight = (v: number) => PAD_TOP + plotH - (v / (layout.rightScale?.max ?? 1)) * plotH;
  const cx = (i: number) => padLeft + (i + 0.5) * slotW;

  const barSeries = visible.filter((s) => (s.kind ?? kind) === "bars");
  const groupedBars = barSeries.filter((s) => !layout.stackable(s) || s.axis === "right");
  const barW = Math.max(1, Math.min(56, slotW * (slotW > 6 ? 0.72 : 0.9)));
  const tickEvery = Math.max(1, Math.ceil(slots / Math.max(1, Math.floor(plotW / MIN_TICK_SPACING))));

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const i = Math.floor((event.clientX - box.left) / (box.width / slots));
    setHover(i >= 0 && i < slots ? i : null);
  };

  const hoverRows =
    hover === null
      ? []
      : visible
          .filter((s) => s.tooltip !== false)
          .map((s) => ({ s, v: s.values[hover] }))
          .filter(
            (row): row is { s: ChartSeries; v: number } =>
              row.v !== null && row.v !== undefined && (row.v !== 0 || visible.length === 1),
          )
          .sort((a, b) => (visible.length > 1 ? b.v - a.v : 0));
  const total = hoverRows.filter((r) => r.s.axis !== "right").reduce((sum, r) => sum + r.v, 0);
  const withTotal = showTotal ?? (stacked && layout.left.length > 1);

  return (
    <div className="chart" ref={ref} data-hovering={hover !== null} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          <defs>
            {visible
              .filter((s) => s.pattern === "hatch")
              .map((s) => (
                <pattern
                  key={s.key}
                  id={`${patternId}-${cssId(s.key)}`}
                  width="5"
                  height="5"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="5" height="5" fill={s.color} fillOpacity="0.14" />
                  <rect width="1.6" height="5" fill={s.color} />
                </pattern>
              ))}
          </defs>

          <g className="chart-grid">
            {layout.leftScale.ticks.map((t) => (
              <line key={t} x1={padLeft} x2={padLeft + plotW} y1={yLeft(t)} y2={yLeft(t)} />
            ))}
          </g>
          <g className="chart-axis">
            {layout.leftScale.ticks.map((t, i) => (
              <text key={t} x={padLeft - 8} y={yLeft(t)} dy="0.32em" textAnchor="end">
                {leftLabels[i]}
              </text>
            ))}
            {layout.rightScale?.ticks.map((t, i) => (
              <text key={t} x={padLeft + plotW + 8} y={yRight(t)} dy="0.32em" textAnchor="start">
                {rightLabels[i]}
              </text>
            ))}
            {Array.from({ length: slots }, (_, i) =>
              i % tickEvery === 0 ? (
                <text key={i} x={cx(i)} y={height - 6} textAnchor="middle">
                  {tickLabel(i)}
                </text>
              ) : null,
            )}
          </g>

          {hover !== null && (
            <rect className="chart-cursor" x={padLeft + hover * slotW} y={PAD_TOP} width={slotW} height={plotH} />
          )}

          {visible
            .filter((s) => (s.kind ?? kind) === "area")
            .map((s) => {
              const y = s.axis === "right" ? yRight : yLeft;
              const base = layout.bases.get(s.key);
              const top = (i: number) => (base?.[i] ?? 0) + (s.values[i] ?? 0);
              const line = pathThrough(slots, cx, (i) => y(top(i)));
              const floor = Array.from({ length: slots }, (_, j) => slots - 1 - j)
                .map((i) => `L${cx(i).toFixed(1)},${y(base?.[i] ?? 0).toFixed(1)}`)
                .join("");
              const fill = s.pattern === "hatch" ? `url(#${patternId}-${cssId(s.key)})` : s.color;
              return (
                <g key={s.key}>
                  <path d={`${line}${floor}Z`} fill={fill} fillOpacity={s.pattern ? 1 : 0.2} />
                  <path className="chart-line" d={line} stroke={s.color} />
                </g>
              );
            })}

          {barSeries.map((s) => {
            const y = s.axis === "right" ? yRight : yLeft;
            const base = layout.bases.get(s.key);
            const group = groupedBars.indexOf(s);
            const subW = group >= 0 ? barW / groupedBars.length : barW;
            const fill = s.pattern === "hatch" ? `url(#${patternId}-${cssId(s.key)})` : s.color;
            return (
              <g key={s.key}>
                {s.values.map((v, i) => {
                  if (!v) return null;
                  const b = group >= 0 ? 0 : (base?.[i] ?? 0);
                  const y0 = y(b);
                  const y1 = y(b + v);
                  const x = cx(i) - barW / 2 + (group >= 0 ? group * subW : 0);
                  return (
                    <rect
                      key={i}
                      className="chart-bar"
                      data-hover={hover === i}
                      x={x}
                      y={Math.min(y0, y1)}
                      width={Math.max(1, subW - (group >= 0 && groupedBars.length > 1 ? 1 : 0))}
                      height={Math.max(v > 0 ? 1 : 0, Math.abs(y0 - y1))}
                      fill={fill}
                    />
                  );
                })}
              </g>
            );
          })}

          {visible
            .filter((s) => (s.kind ?? kind) === "line")
            .map((s) => {
              const y = s.axis === "right" ? yRight : yLeft;
              const at = (i: number) => {
                const v = s.values[i];
                return v === null || v === undefined ? null : y(v);
              };
              return (
                <g key={s.key}>
                  <path
                    className="chart-line"
                    d={pathThrough(slots, cx, at)}
                    stroke={s.color}
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                  />
                  {s.values.map((_, i) => {
                    const yi = at(i);
                    if (
                      yi === null ||
                      (i > 0 && at(i - 1) !== null) ||
                      (i < slots - 1 && at(i + 1) !== null)
                    ) {
                      return null;
                    }
                    return <circle key={i} cx={cx(i)} cy={yi} r={2.5} fill={s.color} />;
                  })}
                </g>
              );
            })}

          {references?.map((r) => {
            const y = r.axis === "right" ? yRight(r.value) : yLeft(r.value);
            return (
              <g key={`${r.axis ?? "left"}:${r.value}`} className="chart-axis">
                <line
                  x1={padLeft}
                  x2={padLeft + plotW}
                  y1={y}
                  y2={y}
                  stroke="var(--line-4)"
                  strokeDasharray="3 3"
                />
                {r.label && (
                  <text x={padLeft + plotW - 4} y={y - 5} textAnchor="end">
                    {r.label}
                  </text>
                )}
              </g>
            );
          })}

          <line className="chart-baseline" x1={padLeft} x2={padLeft + plotW} y1={yLeft(0)} y2={yLeft(0)} />

          <rect
            x={padLeft}
            y={PAD_TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onClick={onSelect && hover !== null ? () => onSelect(hover) : undefined}
            style={{ cursor: onSelect ? "pointer" : "crosshair" }}
          />
        </svg>
      )}

      {layout.empty && <div className="chart-empty">{emptyLabel ?? t("settingsPage.stats.charts.emptyState")}</div>}

      {hover !== null && !layout.empty && (
        <div
          className="chart-tooltip"
          style={
            cx(hover) > width / 2
              ? { right: width - cx(hover) + Math.min(slotW / 2, 24) + 8, top: PAD_TOP }
              : { left: cx(hover) + Math.min(slotW / 2, 24) + 8, top: PAD_TOP }
          }
        >
          <div className="chart-tooltip-title">{(tooltipTitle ?? tickLabel)(hover)}</div>
          {hoverRows.map(({ s, v }) => (
            <div key={s.key} className="chart-tooltip-row">
              <span className="swatch" style={{ background: s.color }} />
              <span className="chart-tooltip-label">{s.label}</span>
              <span className="chart-tooltip-value">
                {s.axis === "right" ? (formatRight ?? format)(v) : (formatTooltip ?? format)(v)}
              </span>
            </div>
          ))}
          {withTotal && hoverRows.length > 1 && (
            <div className="chart-tooltip-row chart-tooltip-total">
              <span className="chart-tooltip-label">{t("settingsPage.stats.charts.total")}</span>
              <span className="chart-tooltip-value">{(formatTooltip ?? format)(total)}</span>
            </div>
          )}
          {tooltipExtra && <Fragment>{tooltipExtra(hover)}</Fragment>}
        </div>
      )}
    </div>
  );
}

export function niceScale(max: number): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0] };
  const rough = max / Y_TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { max: top, ticks };
}

function labelWidth(labels: readonly string[]): number {
  return labels.reduce((w, label) => Math.max(w, label.length * 6.3), 0);
}

function pathThrough(slots: number, x: (i: number) => number, y: (i: number) => number | null): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < slots; i++) {
    const yi = y(i);
    if (yi === null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${yi.toFixed(1)}`;
    pen = true;
  }
  return d;
}

function cssId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}
