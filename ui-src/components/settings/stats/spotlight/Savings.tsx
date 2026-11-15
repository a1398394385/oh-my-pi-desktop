/**
 * The saving seen two ways: its time series (what the cuts removed and what
 * stayed removed per bucket) and the per-tool breakdown of the gross that
 * explains which cuts produced it.
 */
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ChartSeries, Legend, TimeChart } from "../charts";
import { formatInteger } from "../data/formatters";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import type { SpotlightDashboardStats, TimeRange } from "../types";
import { Card, type Column, EmptyState, Segmented, Table } from "../ui";
import { foldTools, formatShare, formatSignedCompact, formatSignedCost, OTHER_TOOLS, toolIcon } from "./meta";

type SavingsUnit = "tokens" | "usd";

export interface SavingsProps {
  stats: SpotlightDashboardStats;
  range: TimeRange;
  stale: boolean;
}

/** Gross saved and the net after fetch-backs, per bucket; the range's axis is filled so quiet buckets still show. */
export function SavingsOverTime({ stats, range, stale }: SavingsProps) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<SavingsUnit>("tokens");
  const meta = rangeMeta(range);
  const usd = unit === "usd";

  const unitOptions = useMemo(
    () => [
      { value: "tokens" as const, label: t("settingsPage.stats.spotlight.savings.unitTokens") },
      { value: "usd" as const, label: t("settingsPage.stats.spotlight.savings.unitUsd") },
    ],
    [t],
  );

  const chart = useMemo(() => {
    const buckets = bucketAxis(
      range,
      stats.series.map((bucket) => bucket.timestamp),
      meta.bucketMs,
    );
    const saved = densify(stats.series, buckets, (bucket) => (usd ? bucket.savedUsd : bucket.savedTokens));
    const net = densify(stats.series, buckets, (bucket) => (usd ? bucket.netUsd : bucket.netTokens));
    // The payload has no per-bucket dollar value for recoveries, so the $ view has no fetched-back row.
    const recovered = usd ? null : densify(stats.series, buckets, (bucket) => bucket.recoveredTokens);
    const series: ChartSeries[] = [
      {
        key: "saved",
        label: t("settingsPage.stats.spotlight.savings.saved"),
        color: "var(--chart-primary)",
        kind: "bars",
        values: saved,
      },
      {
        key: "net",
        label: t("settingsPage.stats.spotlight.savings.net"),
        color: "var(--green)",
        kind: "line",
        tooltip: false,
        // Chart has no negative domain; a bucket whose fetch-backs exceed its saving is tooltip-only.
        values: net.map((value) => (value < 0 ? null : value)),
      },
    ];
    return { buckets, series, net, recovered };
  }, [stats.series, range, meta.bucketMs, usd, t]);

  const format = usd ? formatSignedCost : formatSignedCompact;

  return (
    <Card
      index={1}
      title={t("settingsPage.stats.spotlight.savings.overTimeTitle")}
      description={t("settingsPage.stats.spotlight.savings.overTimeDesc")}
      actions={
        <Segmented
          size="sm"
          aria-label={t("settingsPage.stats.spotlight.savings.unitLabel")}
          options={unitOptions}
          value={unit}
          onChange={setUnit}
        />
      }
      stale={stale}
      footer={usd ? t("settingsPage.stats.spotlight.savings.footerUsd") : t("settingsPage.stats.spotlight.savings.footerTokens")}
    >
      <Legend items={chart.series.map((series) => ({ key: series.key, label: series.label, color: series.color }))} />
      <TimeChart
        buckets={chart.buckets}
        bucketMs={meta.bucketMs}
        series={chart.series}
        stacked={false}
        height={300}
        format={format}
        formatTooltip={format}
        showTotal={false}
        tooltipExtra={(index) => (
          <>
            {chart.recovered !== null && (
              <div className="chart-tooltip-row">
                <span className="chart-tooltip-label">{t("settingsPage.stats.spotlight.savings.recovered")}</span>
                <span className="chart-tooltip-value">{formatSignedCompact(chart.recovered[index] ?? 0)}</span>
              </div>
            )}
            <div className="chart-tooltip-row">
              <span className="chart-tooltip-label">{t("settingsPage.stats.spotlight.savings.net")}</span>
              <span className="chart-tooltip-value">{format(chart.net[index] ?? 0)}</span>
            </div>
          </>
        )}
        emptyLabel={t("settingsPage.stats.spotlight.savings.empty")}
      />
    </Card>
  );
}

/** One row of the per-tool list: a tool, or the folded rest summed into `other`. */
interface ToolNetRow {
  key: string;
  tool: string;
  savedTokens: number;
  excess: number | null;
  thin: boolean;
  title?: string;
}

/** Gross saving per tool, the fetch-backs beyond the holdout baseline, and what is left. */
export function WhereSavingsWent({ stats, stale }: Omit<SavingsProps, "range">) {
  const { t } = useTranslation();
  const { gross, adjusted } = stats;
  const rows = useMemo((): ToolNetRow[] => {
    const adjustedByTool = new Map(adjusted.byTool.map((row) => [row.tool, row]));
    const { listed, rest } = foldTools(gross.byTool);
    const out: ToolNetRow[] = listed.map((row) => {
      const adjustedRow = adjustedByTool.get(row.tool);
      return {
        key: row.tool,
        tool: row.tool,
        savedTokens: row.savedTokens,
        excess: adjustedRow?.excessTokens.value ?? null,
        thin: adjustedRow !== undefined && adjustedRow.holdouts < adjusted.minHoldouts,
      };
    });
    if (rest.length > 0) {
      let saved = 0;
      let excess: number | null = null;
      let thin = false;
      for (const row of rest) {
        saved += row.savedTokens;
        const own = adjustedByTool.get(row.tool);
        const value = own?.excessTokens.value;
        if (value !== null && value !== undefined) excess = (excess ?? 0) + value;
        if (own !== undefined && own.holdouts < adjusted.minHoldouts) thin = true;
      }
      out.push({
        key: OTHER_TOOLS,
        tool: t("settingsPage.stats.spotlight.savings.otherTools"),
        savedTokens: saved,
        excess,
        thin,
        title: `${t("settingsPage.stats.spotlight.savings.otherTitle", { count: rest.length })}: ${rest
          .map((row) => row.tool)
          .join(", ")}`,
      });
    }
    return out;
  }, [gross.byTool, adjusted.byTool, adjusted.minHoldouts, t]);

  const columns = useMemo((): Column<ToolNetRow>[] => {
    const thinTitle = (tool: string) =>
      t("settingsPage.stats.spotlight.savings.thinTitle", { tool, min: formatInteger(adjusted.minHoldouts) });
    return [
      {
        key: "tool",
        header: t("settingsPage.stats.spotlight.savings.colTool"),
        render: (row) => {
          const Icon = toolIcon(row.key);
          return (
            <span className="row" title={row.title}>
              <Icon size={13} aria-hidden="true" />
              <span className="truncate">{row.tool}</span>
              {row.thin && (
                <span title={thinTitle(row.tool)}>
                  <TriangleAlert size={11} />
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "saved",
        header: t("settingsPage.stats.spotlight.savings.colSaved"),
        align: "right",
        sort: (row) => row.savedTokens,
        render: (row) => formatSignedCompact(row.savedTokens),
      },
      {
        key: "share",
        header: t("settingsPage.stats.spotlight.savings.colShare"),
        align: "right",
        render: (row) => formatShare(gross.savedTokens > 0 ? row.savedTokens / gross.savedTokens : null),
      },
      {
        key: "net",
        header: t("settingsPage.stats.spotlight.savings.colNet"),
        align: "right",
        render: (row) =>
          row.excess === null ? "–" : formatSignedCompact(row.savedTokens - row.excess),
      },
    ];
  }, [gross.savedTokens, adjusted.minHoldouts, t]);

  return (
    <Card
      index={2}
      title={t("settingsPage.stats.spotlight.savings.whereTitle")}
      description={t("settingsPage.stats.spotlight.savings.whereDesc")}
      stale={stale}
      flush
      footer={t("settingsPage.stats.spotlight.savings.whereFooter", {
        min: formatInteger(adjusted.minHoldouts),
      })}
    >
      <Table
        rows={rows}
        rowKey={(row) => row.key}
        columns={columns}
        dense
        empty={<EmptyState title={t("settingsPage.stats.spotlight.savings.emptyTools")} />}
      />
    </Card>
  );
}
