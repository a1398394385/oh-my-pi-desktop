/**
 * A cut keeps paying: every later request of the session would have re-read it,
 * so the saving compounds. This card sizes that carry and shows it accumulating
 * across the range next to the saving the cuts removed outright.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Chart, type ChartSeries } from "../charts";
import { formatCompact, formatInteger } from "../data/formatters";
import { formatBucket, formatTick } from "../data/range";
import type { SpotlightDashboardStats } from "../types";
import { Card, EmptyState, Stat, StatGrid } from "../ui";
import { formatShare, formatSignedCost } from "./meta";

export interface CompoundingProps {
  stats: SpotlightDashboardStats;
  /** The route's live flag; the curve reads the payload, so this card fetches nothing on it. */
  active: boolean;
  stale: boolean;
}

export function Compounding({ stats, stale }: CompoundingProps) {
  const { t } = useTranslation();
  const { compounding, gross, series } = stats;
  // `range` is not part of this card's props; the payload's buckets are already range-sized.
  const step = series.length > 1 ? series[1].timestamp - series[0].timestamp : 0;
  const bucketMs = step > 0 ? step : 86_400_000;
  const carryRaw = gross.savedTokens > 0 ? compounding.avoidedTokens / gross.savedTokens : null;
  const carry = carryRaw !== null && Number.isFinite(carryRaw) ? carryRaw : null;

  const chart = useMemo(() => {
    let removedRun = 0;
    let avoidedRun = 0;
    const removed: number[] = [];
    const avoided: number[] = [];
    for (const bucket of series) {
      removedRun += bucket.savedTokens;
      removed.push(removedRun);
      // No per-bucket carry is recorded; scale each bucket by the range's average carry.
      if (carry === null) continue;
      avoidedRun += bucket.savedTokens * carry;
      avoided.push(avoidedRun);
    }
    const chartSeries: ChartSeries[] = [
      {
        key: "removed",
        label: t("settingsPage.stats.spotlight.compounding.chartRemoved"),
        color: "var(--chart-primary)",
        kind: "area",
        values: removed,
      },
    ];
    if (carry !== null) {
      chartSeries.push({
        key: "avoided",
        label: t("settingsPage.stats.spotlight.compounding.chartAvoided"),
        color: "var(--chart-secondary)",
        kind: "line",
        values: avoided,
      });
    }
    return chartSeries;
  }, [series, carry, t]);

  return (
    <Card
      index={3}
      title={t("settingsPage.stats.spotlight.compounding.title")}
      description={t("settingsPage.stats.spotlight.compounding.desc")}
      stale={stale}
      footer={t("settingsPage.stats.spotlight.compounding.footer", {
        carry: carry === null ? "–" : `${carry.toFixed(1)}×`,
      })}
    >
      <div className="grid">
        <StatGrid min={170}>
          <Stat
            label={t("settingsPage.stats.spotlight.compounding.avoided")}
            value={formatCompact(compounding.avoidedTokens)}
            hint={t("settingsPage.stats.spotlight.compounding.avoidedHint", {
              tokens: formatCompact(compounding.recoveredCarriedTokens),
            })}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.compounding.share")}
            value={formatShare(compounding.avoidedShare)}
            hint={t("settingsPage.stats.spotlight.compounding.shareHint")}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.compounding.carry")}
            title={t("settingsPage.stats.spotlight.compounding.carryTitle")}
            value={carry === null ? "–" : `${carry.toFixed(1)}×`}
            hint={t("settingsPage.stats.spotlight.compounding.carryHint")}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.compounding.netUsd")}
            value={formatSignedCost(compounding.netUsd)}
            hint={t("settingsPage.stats.spotlight.compounding.netUsdHint")}
          />
        </StatGrid>

        {/* shortcut: Chart has no negative domain, so an early bucket whose cuts showed more than plain dips under the baseline. */}
        {series.length === 0 ? (
          <EmptyState title={t("settingsPage.stats.spotlight.compounding.empty")} />
        ) : (
          <Chart
            slots={series.length}
            tickLabel={(index) => formatTick(series[index].timestamp, bucketMs)}
            tooltipTitle={(index) => formatBucket(series[index].timestamp, bucketMs)}
            series={chart}
            stacked={false}
            height={220}
            format={formatCompact}
            formatTooltip={formatInteger}
            showTotal={false}
            emptyLabel={t("settingsPage.stats.spotlight.compounding.empty")}
          />
        )}
      </div>
    </Card>
  );
}
