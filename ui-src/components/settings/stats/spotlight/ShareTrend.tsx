/**
 * Does shaping actually move the needle? The tool-output share of context for
 * shaped sessions against the rest of history, so the experiment's effect is
 * visible over time rather than only in the savings totals.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Chart, Legend, type ChartSeries, type ReferenceLine } from "../charts";
import { formatPercent } from "../data/formatters";
import { bucketAxis, formatBucket, formatTick, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import type { SpotlightDashboardStats, SpotlightSharePoint, TimeRange } from "../types";
import { Card } from "../ui";
import { formatShare } from "./meta";

/** Trailing buckets in each rolling share. */
const ROLLING_WINDOW = 7;

type ShareGroup = SpotlightSharePoint["group"];

const GROUPS: readonly { group: ShareGroup; color: string }[] = [
  { group: "shaped", color: "var(--chart-primary)" },
  { group: "outside", color: "var(--faint)" },
];

export interface ShareTrendProps {
  stats: SpotlightDashboardStats;
  range: TimeRange;
  stale: boolean;
}

export function ShareTrend({ stats, range, stale }: ShareTrendProps) {
  const { t } = useTranslation();
  const meta = rangeMeta(range);
  const { share, experimentStart } = stats;

  const chart = useMemo(() => {
    const buckets = bucketAxis(
      range,
      share.map((point) => point.timestamp),
      meta.bucketMs,
    );
    const series: ChartSeries[] = [];
    const legend: { key: string; label: string; color: string; value: string }[] = [];
    let outsideShare: number | null = null;
    for (const { group, color } of GROUPS) {
      const points = share.filter((point) => point.group === group);
      if (points.length === 0) continue;
      const label =
        group === "shaped"
          ? t("settingsPage.stats.spotlight.share.groupShaped")
          : t("settingsPage.stats.spotlight.share.groupOutside");
      const tool = densify(points, buckets, (point) => point.toolTokens);
      const context = densify(points, buckets, (point) => point.contextTokens);
      let toolSum = 0;
      let contextSum = 0;
      const rolling = buckets.map((_, index) => {
        let toolWindow = 0;
        let contextWindow = 0;
        for (let i = Math.max(0, index - ROLLING_WINDOW + 1); i <= index; i++) {
          toolWindow += tool[i];
          contextWindow += context[i];
        }
        toolSum += tool[index];
        contextSum += context[index];
        return contextWindow > 0 ? toolWindow / contextWindow : null;
      });
      if (contextSum === 0) continue;
      series.push(
        {
          key: `${group}:raw`,
          label: t("settingsPage.stats.spotlight.share.rawLabel", { group: label }),
          color,
          kind: "line",
          dashed: true,
          values: buckets.map((_, index) => (context[index] > 0 ? tool[index] / context[index] : null)),
        },
        {
          key: `${group}:rolling`,
          label: t("settingsPage.stats.spotlight.share.rollingLabel", { group: label }),
          color,
          kind: "line",
          values: rolling,
        },
      );
      const overall = toolSum / contextSum;
      if (group === "outside") outsideShare = overall;
      legend.push({ key: group, label, color, value: formatShare(overall) });
    }
    // Mark the experiment's first bucket on the axis; the range may not reach it.
    const start =
      experimentStart === null ? null : Math.floor(experimentStart / meta.bucketMs) * meta.bucketMs;
    return {
      buckets,
      series,
      legend,
      startIndex: start === null ? -1 : buckets.indexOf(start),
      references:
        outsideShare === null
          ? []
          : ([{ value: outsideShare, label: t("settingsPage.stats.spotlight.share.outsideBaseline") }] as ReferenceLine[]),
    };
  }, [share, experimentStart, range, meta.bucketMs, t]);

  return (
    <Card
      index={4}
      title={t("settingsPage.stats.spotlight.share.title")}
      description={
        experimentStart !== null && chart.startIndex < 0
          ? t("settingsPage.stats.spotlight.share.descSince", {
              date: formatBucket(experimentStart, 86_400_000),
            })
          : t("settingsPage.stats.spotlight.share.desc")
      }
      actions={chart.legend.length > 0 ? <Legend items={chart.legend} /> : undefined}
      stale={stale}
      footer={t("settingsPage.stats.spotlight.share.footer", { window: ROLLING_WINDOW })}
    >
      <Chart
        slots={chart.buckets.length}
        tickLabel={(index) =>
          `${formatTick(chart.buckets[index], meta.bucketMs)}${index === chart.startIndex ? " ▸" : ""}`
        }
        tooltipTitle={(index) => formatBucket(chart.buckets[index], meta.bucketMs)}
        series={chart.series}
        stacked={false}
        height={260}
        format={(value) => formatPercent(value, 0)}
        formatTooltip={(value) => formatPercent(value)}
        showTotal={false}
        references={chart.references}
        emptyLabel={t("settingsPage.stats.spotlight.share.empty")}
      />
    </Card>
  );
}
