import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { getModelDashboardStats } from "../api";
import { type ChartSeries, Legend, Sparkline, TimeChart, useHiddenSeries } from "../charts";
import { buildModelColorLookup, modelKey, OTHER_COLOR } from "../data/colors";
import {
  formatCompact,
  formatDurationMs,
  formatEstimatedCost,
  formatInteger,
  formatPercent,
  formatRelativeTime,
  formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import {
  buildModelPerformanceLookup,
  type ModelPerformanceDataPoint,
  sumConversationTokens,
} from "../data/view-models";
import type { ModelDashboardStats, ModelStats, TimeRange } from "../types";
import {
  Badge,
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  errorRateTone,
  KeyValues,
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

export interface ModelsRouteProps {
  active: boolean;
  range: TimeRange;
}

type ShareMode = "share" | "requests";

const SHARE_LIMIT = 6;

export function ModelsRoute({ active, range }: ModelsRouteProps) {
  const { t } = useTranslation();
  const query = useQuery(["models", range], () => getModelDashboardStats(range), { enabled: active });
  const meta = rangeMeta(range);
  const [mode, setMode] = useState<ShareMode>("share");
  const [hidden, toggleSeries] = useHiddenSeries();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const view = useMemo(() => (query.data ? buildModelsView(query.data, range) : null), [query.data, range]);
  const bucketWord = bucketName(meta.bucketMs, t);
  const modelColumns = useMemo(
    () => (view ? buildModelColumns(t, view, expandedKey, bucketWord) : []),
    [t, view, expandedKey, bucketWord],
  );
  const shareOptions = useMemo(
    () => [
      { value: "share" as const, label: t("settingsPage.stats.models.shareMode.share") },
      { value: "requests" as const, label: t("settingsPage.stats.models.shareMode.requests") },
    ],
    [t],
  );
  const isEmpty = (data: ModelDashboardStats) => data.byModel.length === 0;
  const empty = (
    <EmptyState
      title={t("settingsPage.stats.models.empty.range")}
      hint={t("settingsPage.stats.models.empty.rangeHint")}
    />
  );

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.models.pageTitle")}
        description={t("settingsPage.stats.models.pageDescription", { window: meta.windowLabel })}
      />

      <QueryView
        query={query}
        skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}
        isEmpty={isEmpty}
        empty={empty}
      >
        {() =>
          view && (
            <div data-stale={query.stale}>
              <StatGrid min={200}>
                <Stat
                  label={t("settingsPage.stats.models.stat.modelsUsed")}
                  value={formatInteger(view.models.length)}
                  hint={t("settingsPage.stats.models.stat.modelsUsedHint", {
                    count: formatInteger(view.providerCount),
                  })}
                />
                <Stat
                  label={t("settingsPage.stats.models.stat.mostUsed")}
                  title={view.top ? `${view.top.model} (${view.top.provider})` : undefined}
                  value={view.top ? view.top.model : "–"}
                  hint={
                    view.top
                      ? `${formatPercent(view.top.totalRequests / Math.max(1, view.totalRequests))} ${t("settingsPage.stats.models.stat.mostUsedHintOf")} · ${view.top.provider}`
                      : undefined
                  }
                />
                <Stat
                  label={t("settingsPage.stats.models.stat.requests")}
                  value={formatInteger(view.totalRequests)}
                  hint={t("settingsPage.stats.models.stat.requestsHint", {
                    count: formatInteger(view.failedRequests),
                  })}
                  spark={view.requestTotals}
                />
                <Stat
                  label={t("settingsPage.stats.models.stat.apiCost")}
                  title={t("settingsPage.stats.models.stat.apiCostTitle")}
                  value={formatEstimatedCost(view.totalCost, view.unpricedRequests)}
                  hint={
                    view.unpricedRequests > 0
                      ? t("settingsPage.stats.models.stat.unpricedHint", {
                          count: formatInteger(view.unpricedRequests),
                        })
                      : undefined
                  }
                />
              </StatGrid>
            </div>
          )
        }
      </QueryView>

      <Card
        index={1}
        title={t("settingsPage.stats.models.shareCardTitle")}
        description={
          mode === "share"
            ? t("settingsPage.stats.models.shareCardDesc.share", { bucket: bucketWord })
            : t("settingsPage.stats.models.shareCardDesc.count", { bucket: bucketWord })
        }
        actions={
          <Segmented
            size="sm"
            options={shareOptions}
            value={mode}
            onChange={setMode}
            aria-label={t("settingsPage.stats.models.shareCardAria")}
          />
        }
        stale={query.stale}
      >
        <QueryView query={query} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={empty}>
          {() =>
            view && (
              <div className="stack" style={{ gap: 12 }}>
                <TimeChart
                  buckets={view.buckets}
                  bucketMs={meta.bucketMs}
                  series={mode === "share" ? view.shareSeries : view.countSeries}
                  hidden={hidden}
                  height={260}
                  yMax={mode === "share" ? 1 : undefined}
                  format={mode === "share" ? v => formatPercent(v, 0) : formatCompact}
                  formatTooltip={mode === "share" ? v => formatPercent(v) : formatInteger}
                  showTotal={mode === "requests"}
                />
                <Legend
                  items={view.countSeries.map(s => ({
                    key: s.key,
                    label: s.label,
                    color: s.color,
                    value: formatPercent(sumValues(s.values) / Math.max(1, sumValues(view.requestTotals))),
                  }))}
                  hidden={hidden}
                  onToggle={toggleSeries}
                />
              </div>
            )
          }
        </QueryView>
      </Card>

      <Card
        index={2}
        title={t("settingsPage.stats.models.allModelsCardTitle")}
        description={t("settingsPage.stats.models.allModelsCardDesc")}
        stale={query.stale}
        flush
      >
        <QueryView query={query} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={empty}>
          {() =>
            view && (
              <Table
                rows={view.models}
                rowKey={row => modelKey(row.model, row.provider)}
                columns={modelColumns}
                initialSort={{ key: "requests", dir: "desc" }}
                limit={25}
                onRowClick={row => {
                  const key = modelKey(row.model, row.provider);
                  setExpandedKey(prev => (prev === key ? null : key));
                }}
                selectedKey={expandedKey}
                expanded={row => {
                  const key = modelKey(row.model, row.provider);
                  return key === expandedKey ? (
                    <ModelDetail
                      model={row}
                      color={view.swatches.get(key) ?? "var(--chart-primary)"}
                      points={view.performance.get(key) ?? []}
                      bucketMs={meta.bucketMs}
                      bucketWord={bucketWord}
                    />
                  ) : null;
                }}
              />
            )
          }
        </QueryView>
      </Card>
    </div>
  );
}

interface ModelsView {
  models: ModelStats[];
  top: ModelStats | undefined;
  swatches: Map<string, string>;
  labels: Map<string, string>;
  providerCount: number;
  totalRequests: number;
  failedRequests: number;
  totalCost: number;
  unpricedRequests: number;
  maxRequests: number;
  buckets: number[];
  requestTotals: number[];
  countSeries: ChartSeries[];
  shareSeries: ChartSeries[];
  trends: Map<string, readonly (number | null)[]>;
  performance: Map<string, ModelPerformanceDataPoint[]>;
}

function buildModelsView(data: ModelDashboardStats, range: TimeRange): ModelsView {
  const models = data.byModel;
  const colors = buildModelColorLookup(models);
  const labels = modelLabels(models);
  const buckets = bucketAxis(
    range,
    data.modelSeries.map(p => p.timestamp),
  );
  const requestTotals = densify(data.modelSeries, buckets, p => p.requests);
  const pivot = {
    buckets,
    key: (p: { model: string; provider: string }) => modelKey(p.model, p.provider),
    label: (key: string) => labels.get(key) ?? key,
    value: (p: { requests: number }) => p.requests,
    colors,
  };
  const countSeries = pivotSeries(data.modelSeries, { ...pivot, limit: SHARE_LIMIT }).map(s => ({
    ...s,
    values: s.values.map(v => v || null),
  }));
  const shareSeries = countSeries.map(s => ({
    ...s,
    values: s.values.map((v, i) => (v === null ? null : v / requestTotals[i])),
  }));
  const trends = new Map(pivotSeries(data.modelSeries, pivot).map(s => [s.key, s.values]));

  let top: ModelStats | undefined;
  let totalRequests = 0;
  let failedRequests = 0;
  let totalCost = 0;
  let unpricedRequests = 0;
  for (const m of models) {
    if (!top || m.totalRequests > top.totalRequests) top = m;
    totalRequests += m.totalRequests;
    failedRequests += m.failedRequests;
    totalCost += m.totalCost;
    unpricedRequests += m.unpricedRequests;
  }

  return {
    models,
    top,
    swatches: new Map(countSeries.filter(s => s.key !== "__other__").map(s => [s.key, s.color])),
    labels,
    providerCount: new Set(models.map(m => m.provider)).size,
    totalRequests,
    failedRequests,
    totalCost,
    unpricedRequests,
    maxRequests: top?.totalRequests ?? 0,
    buckets,
    requestTotals,
    countSeries,
    shareSeries,
    trends,
    performance: buildModelPerformanceLookup(data.modelPerformanceSeries),
  };
}

function modelLabels(models: readonly ModelStats[]): Map<string, string> {
  const providersPerModel = new Map<string, number>();
  for (const m of models) providersPerModel.set(m.model, (providersPerModel.get(m.model) ?? 0) + 1);
  return new Map(
    models.map(m => [
      modelKey(m.model, m.provider),
      (providersPerModel.get(m.model) ?? 0) > 1 ? `${m.model} · ${m.provider}` : m.model,
    ]),
  );
}

function buildModelColumns(
  t: TFunction,
  view: ModelsView,
  expandedKey: string | null,
  bucketWord: string,
): Column<ModelStats>[] {
  return [
    {
      key: "expand",
      header: "",
      width: 28,
      render: row => (
        <span className="models-chevron" data-open={modelKey(row.model, row.provider) === expandedKey}>
          <ChevronRight size={14} />
        </span>
      ),
    },
    {
      key: "model",
      header: t("settingsPage.stats.models.columns.model"),
      sort: row => row.model,
      render: row => (
        <LabelCell
          lead={<Swatch color={view.swatches.get(modelKey(row.model, row.provider)) ?? OTHER_COLOR} />}
          primary={<span className="mono">{row.model}</span>}
          secondary={row.provider}
        />
      ),
    },
    {
      key: "requests",
      header: t("settingsPage.stats.models.columns.requests"),
      align: "right",
      sort: row => row.totalRequests,
      render: row => (
        <MeterCell
          value={row.totalRequests}
          max={view.maxRequests}
          display={formatInteger(row.totalRequests)}
          color={view.swatches.get(modelKey(row.model, row.provider)) ?? OTHER_COLOR}
        />
      ),
    },
    {
      key: "cost",
      header: t("settingsPage.stats.models.columns.cost"),
      title: t("settingsPage.stats.models.columns.costTitle"),
      align: "right",
      sort: row => row.totalCost,
      render: row => <span className="num">{formatEstimatedCost(row.totalCost, row.unpricedRequests)}</span>,
    },
    {
      key: "tokens",
      header: t("settingsPage.stats.models.columns.tokens"),
      title: t("settingsPage.stats.models.columns.tokensTitle"),
      align: "right",
      sort: row => sumConversationTokens(row),
      render: row => {
        const tokens = sumConversationTokens(row);
        return (
          <span className="num" title={formatInteger(tokens)}>
            {formatCompact(tokens)}
          </span>
        );
      },
    },
    {
      key: "cache",
      header: t("settingsPage.stats.models.columns.cacheRate"),
      title: t("settingsPage.stats.models.columns.cacheRateTitle"),
      align: "right",
      sort: row => row.cacheRate,
      render: row => <span className="num">{formatPercent(row.cacheRate)}</span>,
    },
    {
      key: "errors",
      header: t("settingsPage.stats.models.columns.errors"),
      align: "right",
      sort: row => row.errorRate,
      render: row =>
        row.failedRequests === 0 ? (
          <span className="num dim">0%</span>
        ) : (
          <span title={t("settingsPage.stats.models.columns.errorsTooltip", { count: formatInteger(row.failedRequests) })}>
            <Badge tone={errorRateTone(row.errorRate)} mono>
              {formatPercent(row.errorRate)}
            </Badge>
          </span>
        ),
    },
    {
      key: "tps",
      header: t("settingsPage.stats.models.columns.tps"),
      title: t("settingsPage.stats.models.columns.tpsTitle"),
      align: "right",
      sort: row => row.avgTokensPerSecond ?? -1,
      render: row => <span className="num">{formatTokensPerSecond(row.avgTokensPerSecond)}</span>,
    },
    {
      key: "ttft",
      header: t("settingsPage.stats.models.columns.ttft"),
      title: t("settingsPage.stats.models.columns.ttftTitle"),
      align: "right",
      sort: row => row.avgTtft ?? -1,
      render: row => <span className="num">{formatDurationMs(row.avgTtft)}</span>,
    },
    {
      key: "trend",
      header: t("settingsPage.stats.models.columns.trend"),
      title: t("settingsPage.stats.models.columns.trendTitle", { bucket: bucketWord }),
      width: 112,
      render: row => {
        const key = modelKey(row.model, row.provider);
        const values = view.trends.get(key);
        return values ? (
          <Sparkline
            values={values.map(v => v ?? 0)}
            color={view.swatches.get(key) ?? OTHER_COLOR}
            width={96}
            height={22}
          />
        ) : (
          <span className="dim">–</span>
        );
      },
    },
  ];
}

function ModelDetail({
  model,
  color,
  points,
  bucketMs,
  bucketWord,
}: {
  model: ModelStats;
  color: string;
  points: readonly ModelPerformanceDataPoint[];
  bucketMs: number;
  bucketWord: string;
}) {
  const { t } = useTranslation();
  const [hidden, toggle] = useHiddenSeries();
  const series: ChartSeries[] = [
    {
      key: "tps",
      label: t("settingsPage.stats.models.chart.tps"),
      color,
      kind: points.length > 1 ? "line" : "bars",
      values: points.map(p => p.avgTokensPerSecond),
    },
    {
      key: "ttft",
      label: t("settingsPage.stats.models.chart.ttft"),
      color: OTHER_COLOR,
      kind: points.length > 1 ? "line" : "bars",
      axis: "right",
      dashed: true,
      values: points.map(p => p.avgTtftSeconds),
    },
  ];

  return (
    <div className="models-detail">
      <div className="models-detail-facts">
        <div>
          <div className="section-label">{t("settingsPage.stats.models.detail.efficiency")}</div>
          <KeyValues
            items={[
              {
                key: "err",
                label: t("settingsPage.stats.models.detail.errorRate"),
                value: (
                  <span className={`tone-${errorRateTone(model.errorRate)}`}>
                    {formatPercent(model.errorRate)}{" "}
                    <span className="dim">
                      {t("settingsPage.stats.models.detail.failedParens", {
                        count: formatInteger(model.failedRequests),
                      })}
                    </span>
                  </span>
                ),
              },
              {
                key: "cache",
                label: t("settingsPage.stats.models.detail.cacheRate"),
                value: formatPercent(model.cacheRate),
              },
              {
                key: "savings",
                label: t("settingsPage.stats.models.detail.cacheSavings"),
                value: (
                  <span className={model.cacheSavings < 0 ? "tone-bad" : undefined}>
                    {formatPercent(model.cacheSavings)}
                  </span>
                ),
              },
              {
                key: "premium",
                label: t("settingsPage.stats.models.detail.premiumRequests"),
                value: formatInteger(Math.round(model.totalPremiumRequests * 100) / 100),
              },
            ]}
          />
        </div>
        <div>
          <div className="section-label">{t("settingsPage.stats.models.detail.latency")}</div>
          <KeyValues
            items={[
              {
                key: "dur",
                label: t("settingsPage.stats.models.detail.avgDuration"),
                value: formatDurationMs(model.avgDuration),
              },
              {
                key: "ttft",
                label: t("settingsPage.stats.models.detail.avgTtft"),
                value: formatDurationMs(model.avgTtft),
              },
              { key: "tps", label: t("settingsPage.stats.models.chart.tps"), value: formatTokensPerSecond(model.avgTokensPerSecond) },
            ]}
          />
        </div>
        <div>
          <div className="section-label">{t("settingsPage.stats.models.detail.tokens")}</div>
          <KeyValues
            items={[
              {
                key: "in",
                label: t("settingsPage.stats.models.detail.uncachedInput"),
                value: formatCompact(model.totalInputTokens),
              },
              {
                key: "cr",
                label: t("settingsPage.stats.models.detail.cacheRead"),
                value: formatCompact(model.totalCacheReadTokens),
              },
              {
                key: "cw",
                label: t("settingsPage.stats.models.detail.cacheWrite"),
                value: formatCompact(model.totalCacheWriteTokens),
              },
              {
                key: "out",
                label: t("settingsPage.stats.models.detail.output"),
                value: formatCompact(model.totalOutputTokens),
              },
            ]}
          />
        </div>
        <div className="micro dim">
          {t("settingsPage.stats.models.detail.firstLast", {
            first: formatRelativeTime(model.firstTimestamp),
            last: formatRelativeTime(model.lastTimestamp),
          })}
        </div>
      </div>
      <div className="models-detail-chart">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="section-label" style={{ marginBottom: 0 }}>
            {t("settingsPage.stats.models.detail.performancePer", { bucket: bucketWord })}
          </div>
          <Legend
            items={series.map(s => ({ key: s.key, label: s.label, color: s.color }))}
            hidden={hidden}
            onToggle={toggle}
          />
        </div>
        {points.length === 0 ? (
          <EmptyState
            title={t("settingsPage.stats.models.detail.noSamples")}
            hint={t("settingsPage.stats.models.detail.noSamplesHint")}
          />
        ) : (
          <TimeChart
            buckets={points.map(p => p.timestamp)}
            bucketMs={bucketMs}
            series={series}
            hidden={hidden}
            stacked={false}
            height={240}
            format={formatCompact}
            formatTooltip={v => t("settingsPage.stats.models.tooltip.tps", { value: formatTokensPerSecond(v) })}
            formatRight={v => `${Number(v.toFixed(2))}s`}
            tooltipExtra={i => (
              <div className="chart-tooltip-row chart-tooltip-total">
                <span className="chart-tooltip-label">{t("settingsPage.stats.models.tooltip.requests")}</span>
                <span className="chart-tooltip-value">{formatInteger(points[i].requests)}</span>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}

function bucketName(bucketMs: number, t: TFunction): string {
  if (bucketMs < 3_600_000) return t("settingsPage.stats.models.bucket.fiveMinutes");
  if (bucketMs < 86_400_000) return t("settingsPage.stats.models.bucket.hour");
  return t("settingsPage.stats.models.bucket.day");
}

function sumValues(values: readonly (number | null)[]): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}
