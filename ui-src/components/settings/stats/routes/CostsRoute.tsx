import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { t as ti } from "../../../../i18n";
import { getCostDashboardStats } from "../api";
import { Chart, type ChartSeries, Legend, ShareBar, useHiddenSeries } from "../charts";
import { buildModelColorLookup, modelKey, OTHER_COLOR, SERIES_COLORS } from "../data/colors";
import { formatCost, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import { buildCostSummary, type CostComponents, type CostModelRow, type CostSummaryView } from "../data/view-models";
import type { CostDashboardStats, TimeRange } from "../types";
import {
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  LabelCell,
  MeterCell,
  PageHeader,
  QueryView,
  Segmented,
  Skeleton,
  Stat,
  StatGrid,
  Swatch,
  Table,
  TableSkeleton,
} from "../ui";

export interface CostsRouteProps {
  active: boolean;
  range: TimeRange;
}

type SplitMode = "model" | "component";

const MODEL_LIMIT = 6;
const DAY_MS = 86_400_000;

// Labels come from i18n at call time; only stable key + color stay module-level.
const COMPONENTS = [
  { key: "costInput", color: "#5b8cff" },
  { key: "costOutput", color: "var(--chart-secondary)" },
  { key: "costCacheRead", color: "var(--chart-primary)" },
  { key: "costCacheWrite", color: "#f5b54a" },
] as const satisfies readonly { key: keyof CostComponents; color: string }[];

const COMPONENT_LABEL_KEYS: Record<keyof CostComponents, string> = {
  costInput: "settingsPage.stats.costs.componentInput",
  costOutput: "settingsPage.stats.costs.componentOutput",
  costCacheRead: "settingsPage.stats.costs.componentCacheRead",
  costCacheWrite: "settingsPage.stats.costs.componentCacheWrite",
};

function componentLabel(key: keyof CostComponents): string {
  return ti(COMPONENT_LABEL_KEYS[key]);
}

const UTC_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const UTC_DAY_LONG = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function CostsRoute({ active, range }: CostsRouteProps) {
  const { t } = useTranslation();
  const query = useQuery(["costs", range], () => getCostDashboardStats(range), { enabled: active });
  const meta = rangeMeta(range);
  const [split, setSplit] = useState<SplitMode>("model");
  const [hidden, toggleSeries] = useHiddenSeries();
  const view = useMemo(() => (query.data ? buildCostsView(query.data, range) : null), [query.data, range]);
  const isEmpty = (data: CostDashboardStats) => data.costSeries.length === 0;
  const splitOptions = useMemo(
    () => [
      { value: "model" as const, label: t("settingsPage.stats.costs.splitByModel") },
      { value: "component" as const, label: t("settingsPage.stats.costs.splitByComponent") },
    ],
    [t],
  );
  const empty = (
    <EmptyState title={t("settingsPage.stats.costs.emptyTitle")} hint={t("settingsPage.stats.costs.emptyHint")} />
  );

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.costs.title")}
        description={t("settingsPage.stats.costs.desc", { window: meta.windowLabel })}
      />

      <QueryView
        query={query}
        skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}
        isEmpty={isEmpty}
        empty={empty}
      >
        {() => view && <CostStats view={view} stale={query.stale} />}
      </QueryView>

      <div className="grid grid-main-side">
        <Card
          index={1}
          title={t("settingsPage.stats.costs.dailyTitle")}
          description={
            split === "model"
              ? t("settingsPage.stats.costs.dailyDescModel")
              : t("settingsPage.stats.costs.dailyDescComponent")
          }
          actions={
            <Segmented
              size="sm"
              options={splitOptions}
              value={split}
              onChange={setSplit}
              aria-label={t("settingsPage.stats.costs.splitByAria")}
            />
          }
          stale={query.stale}
        >
          <QueryView query={query} skeleton={<ChartSkeleton height={280} />} isEmpty={isEmpty} empty={empty}>
            {() => {
              if (!view) return null;
              const series = split === "model" ? view.modelSeries : view.componentSeries;
              return (
                <div className="stack" style={{ gap: 12 }}>
                  <Chart
                    slots={view.buckets.length}
                    tickLabel={i => UTC_DAY.format(view.buckets[i])}
                    tooltipTitle={i => UTC_DAY_LONG.format(view.buckets[i])}
                    series={series}
                    hidden={hidden}
                    height={280}
                    format={v => formatCost(v, Number.isInteger(v) ? 0 : 2)}
                    formatTooltip={v => formatCost(v)}
                    emptyLabel={t("settingsPage.stats.costs.chartEmpty")}
                    tooltipExtra={i =>
                      view.unpricedPerDay[i] > 0 ? (
                        <div className="chart-tooltip-row chart-tooltip-total">
                          <span className="chart-tooltip-label">{t("settingsPage.stats.costs.unpricedRequests")}</span>
                          <span className="chart-tooltip-value">
                            {formatInteger(view.unpricedPerDay[i])}
                          </span>
                        </div>
                      ) : null
                    }
                  />
                  <Legend
                    items={series.map(s => ({
                      key: s.key,
                      label: s.label,
                      color: s.color,
                      value: formatCost(sum(s.values)),
                    }))}
                    hidden={hidden}
                    onToggle={toggleSeries}
                  />
                </div>
              );
            }}
          </QueryView>
        </Card>

        <Card
          index={2}
          title={t("settingsPage.stats.costs.breakdownTitle")}
          description={t("settingsPage.stats.costs.breakdownDesc")}
          stale={query.stale}
        >
          <QueryView query={query} skeleton={<ChartSkeleton height={280} />} isEmpty={isEmpty} empty={empty}>
            {() => view && <ComponentBreakdown summary={view.summary} />}
          </QueryView>
        </Card>
      </div>

      <Card
        index={3}
        title={t("settingsPage.stats.costs.byModelTitle")}
        description={t("settingsPage.stats.costs.byModelDesc")}
        stale={query.stale}
        flush
      >
        <QueryView query={query} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={empty}>
          {() =>
            view && (
              <Table
                rows={view.summary.models}
                rowKey={row => row.key}
                columns={buildCostColumns(view)}
                initialSort={{ key: "cost", dir: "desc" }}
                limit={20}
              />
            )
          }
        </QueryView>
      </Card>
    </div>
  );
}

interface CostsView {
  summary: CostSummaryView;
  swatches: Map<string, string>;
  buckets: number[];
  dailyTotals: number[];
  unpricedPerDay: number[];
  modelSeries: ChartSeries[];
  componentSeries: ChartSeries[];
  maxModelCost: number;
}

function buildCostsView(data: CostDashboardStats, range: TimeRange): CostsView {
  const points = data.costSeries;
  const summary = buildCostSummary(points);
  const colors = buildModelColorLookup(
    summary.models.map(m => ({ model: m.model, provider: m.provider, totalRequests: m.requests })),
  );
  const byKey = new Map(summary.models.map(m => [m.key, m]));
  const buckets = bucketAxis(
    range,
    points.map(p => p.timestamp),
    DAY_MS,
  );
  const modelSeries = pivotSeries(points, {
    buckets,
    key: p => modelKey(p.model, p.provider),
    label: key => byKey.get(key)?.model ?? key,
    value: p => p.cost,
    limit: MODEL_LIMIT,
    colors,
  }).map(s => ({ ...s, values: s.values.map(v => v || null) }));

  const used = new Set<string>();
  for (const s of modelSeries) {
    if (s.key === "__other__") continue;
    if (used.has(s.color)) s.color = SERIES_COLORS.find(c => !used.has(c)) ?? s.color;
    used.add(s.color);
  }
  return {
    summary,
    swatches: new Map(modelSeries.filter(s => s.key !== "__other__").map(s => [s.key, s.color])),
    buckets,
    dailyTotals: densify(points, buckets, p => p.cost),
    unpricedPerDay: densify(points, buckets, p => p.unpricedRequests),
    modelSeries,
    componentSeries: COMPONENTS.map(c => ({
      key: c.key,
      label: componentLabel(c.key),
      color: c.color,
      values: densify(points, buckets, p => p[c.key]).map(v => v || null),
    })),
    maxModelCost: summary.models[0]?.cost ?? 0,
  };
}

function CostStats({ view, stale }: { view: CostsView; stale: boolean }) {
  const { t } = useTranslation();
  const { summary } = view;
  const pricedRequests = summary.requests - summary.unpricedRequests;
  const top = summary.topModel;
  return (
    <div data-stale={stale}>
      <StatGrid min={180}>
        <Stat
          label={t("settingsPage.stats.costs.statEstimateLabel")}
          title={t("settingsPage.stats.costs.statEstimateTitle")}
          value={formatEstimatedCost(summary.totalCost, summary.unpricedRequests)}
          hint={t("settingsPage.stats.costs.statRequestsHint", { count: summary.requests })}
          spark={view.dailyTotals}
          sparkColor="var(--chart-secondary)"
        />
        <Stat
          label={t("settingsPage.stats.costs.statAvgLabel")}
          title={t("settingsPage.stats.costs.statAvgTitle")}
          value={formatEstimatedCost(summary.avgDailyCost, summary.unpricedRequests)}
          hint={t("settingsPage.stats.costs.statActiveDaysHint", { count: summary.activeDays })}
        />
        <Stat
          label={t("settingsPage.stats.costs.statTopLabel")}
          title={top ? `${top.model} (${top.provider})` : undefined}
          value={top ? top.model : "–"}
          hint={
            top
              ? t("settingsPage.stats.costs.statTopHint", {
                  cost: formatCost(top.cost),
                  share: formatPercent(top.share),
                })
              : t("settingsPage.stats.costs.statTopEmpty")
          }
        />
        <Stat
          label={t("settingsPage.stats.costs.statPerRequestLabel")}
          title={t("settingsPage.stats.costs.statPerRequestTitle")}
          value={pricedRequests > 0 ? formatUnitCost(summary.totalCost / pricedRequests) : "–"}
          hint={t("settingsPage.stats.costs.statPricedHint", { count: pricedRequests })}
        />
        <Stat
          label={t("settingsPage.stats.costs.statUnpricedLabel")}
          title={t("settingsPage.stats.costs.statUnpricedTitle")}
          value={formatInteger(summary.unpricedRequests)}
          hint={
            summary.unpricedRequests > 0
              ? t("settingsPage.stats.costs.statUnpricedExcluded")
              : t("settingsPage.stats.costs.statUnpricedAll")
          }
        />
      </StatGrid>
    </div>
  );
}

function ComponentBreakdown({ summary }: { summary: CostSummaryView }) {
  const { t } = useTranslation();
  return (
    <div className="stack" style={{ gap: 14 }}>
      <ShareBar
        height={10}
        segments={COMPONENTS.map(c => ({
          key: c.key,
          label: t(COMPONENT_LABEL_KEYS[c.key]),
          value: summary[c.key],
          color: c.color,
        }))}
      />
      <div className="costs-components">
        {COMPONENTS.map(c => (
          <div key={c.key} className="costs-component-row">
            <span className="row">
              <Swatch color={c.color} />
              {t(COMPONENT_LABEL_KEYS[c.key])}
            </span>
            <span className="num">{formatCost(summary[c.key])}</span>
            <span className="num dim costs-component-share">
              {summary.totalCost > 0 ? formatPercent(summary[c.key] / summary.totalCost) : "–"}
            </span>
          </div>
        ))}
        <div className="costs-component-row costs-component-total">
          <span>{t("settingsPage.stats.costs.total")}</span>
          <span className="num">{formatEstimatedCost(summary.totalCost, summary.unpricedRequests)}</span>
          <span className="costs-component-share" />
        </div>
      </div>
      {summary.unpricedRequests > 0 && (
        <p className="micro dim">
          {t("settingsPage.stats.costs.unpricedNote", { count: summary.unpricedRequests })}
        </p>
      )}
    </div>
  );
}

function buildCostColumns(view: CostsView): Column<CostModelRow>[] {
  const componentColumns: Column<CostModelRow>[] = COMPONENTS.map(c => ({
    key: c.key,
    header: componentLabel(c.key),
    align: "right",
    sort: row => row[c.key],
    render: row => <span className="num">{formatCost(row[c.key])}</span>,
  }));
  return [
    {
      key: "model",
      header: ti("settingsPage.stats.costs.colModel"),
      sort: row => row.model,
      render: row => (
        <LabelCell
          lead={<Swatch color={view.swatches.get(row.key) ?? OTHER_COLOR} />}
          primary={<span className="mono">{row.model}</span>}
          secondary={row.provider}
        />
      ),
    },
    {
      key: "requests",
      header: ti("settingsPage.stats.costs.colRequests"),
      align: "right",
      sort: row => row.requests,
      render: row => <span className="num">{formatInteger(row.requests)}</span>,
    },
    {
      key: "cost",
      header: ti("settingsPage.stats.costs.colEstimate"),
      title: ti("settingsPage.stats.costs.colEstimateTitle"),
      align: "right",
      sort: row => row.cost,
      render: row => (
        <MeterCell
          value={row.cost}
          max={view.maxModelCost}
          display={formatEstimatedCost(row.cost, row.unpricedRequests)}
          color={view.swatches.get(row.key) ?? OTHER_COLOR}
        />
      ),
    },
    {
      key: "share",
      header: ti("settingsPage.stats.costs.colShare"),
      align: "right",
      sort: row => row.share,
      render: row => <span className="num muted">{row.cost > 0 ? formatPercent(row.share) : "–"}</span>,
    },
    {
      key: "split",
      header: ti("settingsPage.stats.costs.colSplit"),
      title: ti("settingsPage.stats.costs.colSplitTitle"),
      width: 150,
      render: row =>
        row.cost > 0 ? (
          <ShareBar
            segments={COMPONENTS.map(c => ({
              key: c.key,
              label: componentLabel(c.key),
              value: row[c.key],
              color: c.color,
            }))}
          />
        ) : (
          <span className="dim">–</span>
        ),
    },
    ...componentColumns,
    {
      key: "perRequest",
      header: ti("settingsPage.stats.costs.colPerRequest"),
      title: ti("settingsPage.stats.costs.colPerRequestTitle"),
      align: "right",
      sort: row => (row.requests > row.unpricedRequests ? row.cost / (row.requests - row.unpricedRequests) : -1),
      render: row => (
        <span className="num">
          {row.requests > row.unpricedRequests
            ? formatUnitCost(row.cost / (row.requests - row.unpricedRequests))
            : "–"}
        </span>
      ),
    },
    {
      key: "unpriced",
      header: ti("settingsPage.stats.costs.colUnpriced"),
      title: ti("settingsPage.stats.costs.colUnpricedTitle"),
      align: "right",
      sort: row => row.unpricedRequests,
      render: row =>
        row.unpricedRequests > 0 ? (
          <span className="num tone-warn">{formatInteger(row.unpricedRequests)}</span>
        ) : (
          <span className="num dim">–</span>
        ),
    },
  ];
}

function formatUnitCost(value: number): string {
  return value > 0 && value < 0.0001 ? "<$0.0001" : formatCost(value);
}

function sum(values: readonly (number | null)[]): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}
