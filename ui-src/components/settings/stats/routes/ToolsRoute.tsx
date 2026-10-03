import { X } from "lucide-react";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getToolDashboardStats } from "../api";
import { Legend, Sparkline, TimeChart, useHiddenSeries } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import {
  formatCompact,
  formatEstimatedCost,
  formatInteger,
  formatPercent,
  formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import { buildToolRows, type ToolRowView } from "../data/view-models";
import type { TimeRange, ToolDashboardStats, ToolModelStats, ToolTimeSeriesPoint } from "../types";
import {
  Badge,
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  errorRateTone,
  LabelCell,
  MeterCell,
  PageHeader,
  QueryView,
  Segmented,
  Stat,
  StatGrid,
  Swatch,
  Table,
  TableSkeleton,
} from "../ui";

export interface ToolsRouteProps {
  active: boolean;
  range: TimeRange;
}

type CallMetric = "calls" | "errors";

const TOP_TOOLS = 6;

export function ToolsRoute({ active, range }: ToolsRouteProps) {
  const { t } = useTranslation();
  const tools = useQuery(["tools", range], () => getToolDashboardStats(range), { enabled: active });
  const [metric, setMetric] = useState<CallMetric>("calls");
  const [hidden, toggleHidden] = useHiddenSeries();
  const [pickedTool, setToolFilter] = useState<string | null>(null);
  const meta = rangeMeta(range);

  const view = useMemo(() => buildToolsView(tools.data, range, t), [tools.data, range, t]);
  const toolFilter = pickedTool !== null && view.toolNames.includes(pickedTool) ? pickedTool : null;

  const metricOptions = useMemo(
    () => [
      { value: "calls" as const, label: t("settingsPage.stats.tools.metricCalls") },
      { value: "errors" as const, label: t("settingsPage.stats.tools.metricErrors") },
    ],
    [t],
  );
  const noCalls = <EmptyState title={t("settingsPage.stats.tools.emptyNoCalls")} />;
  const bucketUnit =
    meta.bucketMs < 3_600_000
      ? t("settingsPage.stats.tools.bucketUnitMinutes")
      : meta.bucketMs < 86_400_000
        ? t("settingsPage.stats.tools.bucketUnitHour")
        : t("settingsPage.stats.tools.bucketUnitDay");

  const chartSeries = metric === "calls" ? view.callSeries : view.errorSeries;
  const isEmpty = (data: ToolDashboardStats) => data.byTool.length === 0;

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.tools.pageTitle")}
        description={t("settingsPage.stats.tools.pageDescription", { window: meta.windowLabel })}
      />

      <QueryView query={tools} skeleton={<ChartSkeleton height={112} />}>
        {() => {
          const totals = view.totals;
          return (
            <div data-stale={tools.stale} className="stack" style={{ gap: 16 }}>
              <StatGrid min={190}>
                <Stat
                  label={t("settingsPage.stats.tools.statToolCalls")}
                  value={formatInteger(totals.calls)}
                  hint={t("settingsPage.stats.tools.failedCount", { count: formatInteger(totals.errors) })}
                  spark={view.totalCalls}
                />
                <Stat
                  label={t("settingsPage.stats.tools.statDistinctTools")}
                  value={formatInteger(totals.tools)}
                  hint={
                    view.rows[0]
                      ? t("settingsPage.stats.tools.mostUsed", { tool: view.rows[0].tool })
                      : undefined
                  }
                />
                <Stat
                  label={t("settingsPage.stats.tools.statErrorRate")}
                  title={t("settingsPage.stats.tools.statErrorRateTitle")}
                  value={formatPercent(totals.calls > 0 ? totals.errors / totals.calls : 0)}
                  hint={t("settingsPage.stats.tools.succeededCount", {
                    count: formatInteger(totals.calls - totals.errors),
                  })}
                  spark={view.totalErrors}
                  sparkColor="var(--bad)"
                />
                <Stat
                  label={t("settingsPage.stats.tools.statAttributedTokens")}
                  title={t("settingsPage.stats.tools.attributionNote")}
                  value={formatCompact(Math.round(totals.tokens))}
                  hint={t("settingsPage.stats.tools.outputAmount", {
                    amount: formatCompact(Math.round(totals.output)),
                  })}
                />
                <Stat
                  label={t("settingsPage.stats.tools.statAttributedCost")}
                  title={t("settingsPage.stats.tools.attributionNoteCost")}
                  value={formatEstimatedCost(totals.cost, totals.unpriced)}
                  hint={
                    totals.unpriced > 0
                      ? t("settingsPage.stats.tools.unpricedRequests", {
                          count: formatInteger(Math.round(totals.unpriced)),
                        })
                      : t("settingsPage.stats.tools.apiEquivalent")
                  }
                />
              </StatGrid>
              <StatGrid min={150}>
                <Stat
                  size="sm"
                  label={t("settingsPage.stats.tools.statResultText")}
                  title={t("settingsPage.stats.tools.resultTextTitle")}
                  value={t("settingsPage.stats.tools.charsAmount", { amount: formatCompact(totals.resultChars) })}
                />
                <Stat
                  size="sm"
                  label={t("settingsPage.stats.tools.statCallArguments")}
                  title={t("settingsPage.stats.tools.argsCharsTitle")}
                  value={t("settingsPage.stats.tools.charsAmount", { amount: formatCompact(totals.argsChars) })}
                />
                <Stat
                  size="sm"
                  label={t("settingsPage.stats.tools.statAvgResultPerCall")}
                  value={t("settingsPage.stats.tools.charsAmount", {
                    amount: formatCompact(totals.calls > 0 ? Math.round(totals.resultChars / totals.calls) : 0),
                  })}
                />
                <Stat
                  size="sm"
                  label={t("settingsPage.stats.tools.statAvgArgumentsPerCall")}
                  value={t("settingsPage.stats.tools.charsAmount", {
                    amount: formatCompact(totals.calls > 0 ? Math.round(totals.argsChars / totals.calls) : 0),
                  })}
                />
              </StatGrid>
            </div>
          );
        }}
      </QueryView>

      <Card
        index={1}
        title={metric === "calls" ? t("settingsPage.stats.tools.callsOverTime") : t("settingsPage.stats.tools.errorsOverTime")}
        description={t("settingsPage.stats.tools.chartDescription", { unit: bucketUnit, count: TOP_TOOLS })}
        actions={<Segmented size="sm" options={metricOptions} value={metric} onChange={setMetric} />}
        stale={tools.stale}
      >
        <QueryView query={tools} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={noCalls}>
          {() => (
            <div className="stack" style={{ gap: 12 }}>
              <TimeChart
                buckets={view.buckets}
                bucketMs={meta.bucketMs}
                series={chartSeries}
                hidden={hidden}
                height={260}
                formatTooltip={formatInteger}
                emptyLabel={metric === "errors" ? t("settingsPage.stats.tools.noErrorsInRange") : undefined}
              />
              <Legend
                items={chartSeries.map(s => ({
                  key: s.key,
                  label: s.label,
                  color: s.color,
                  value: formatCompact(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
                }))}
                hidden={hidden}
                onToggle={toggleHidden}
              />
            </div>
          )}
        </QueryView>
      </Card>

      <Card
        index={2}
        title={t("settingsPage.stats.tools.byToolTitle")}
        description={t("settingsPage.stats.tools.byToolDescription")}
        flush
        stale={tools.stale}
      >
        <QueryView query={tools} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={noCalls}>
          {() => (
            <Table
              rows={view.rows}
              rowKey={row => row.tool}
              columns={view.toolColumns}
              initialSort={{ key: "calls", dir: "desc" }}
              limit={20}
              selectedKey={toolFilter}
              onRowClick={row => setToolFilter(prev => (prev === row.tool ? null : row.tool))}
              dense
            />
          )}
        </QueryView>
      </Card>

      <Card
        index={3}
        title={t("settingsPage.stats.tools.byToolModelTitle")}
        description={t("settingsPage.stats.tools.byToolModelDescription")}
        flush
        stale={tools.stale}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <select
              className="input tools-filter"
              value={toolFilter ?? ""}
              onChange={e => setToolFilter(e.target.value || null)}
              aria-label={t("settingsPage.stats.tools.filterByTool")}
            >
              <option value="">{t("settingsPage.stats.tools.allTools")}</option>
              {view.toolNames.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {toolFilter !== null && (
              <button
                type="button"
                className="btn"
                data-size="sm"
                data-variant="ghost"
                data-icon="true"
                title={t("settingsPage.stats.tools.clearToolFilter")}
                aria-label={t("settingsPage.stats.tools.clearToolFilter")}
                onClick={() => setToolFilter(null)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        }
      >
        <QueryView query={tools} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={noCalls}>
          {data => <ToolModelTable rows={data.byToolModel} tool={toolFilter} colors={view.colors} />}
        </QueryView>
      </Card>
    </div>
  );
}

interface ToolTotals {
  calls: number;
  errors: number;
  tools: number;
  tokens: number;
  output: number;
  cost: number;
  unpriced: number;
  resultChars: number;
  argsChars: number;
}

function buildToolsView(data: ToolDashboardStats | null, range: TimeRange, t: TFunction) {
  const byTool = data?.byTool ?? [];
  const points = data?.series ?? [];
  const rows = buildToolRows(byTool).sort((a, b) => b.calls - a.calls);
  const colors = buildColorLookup(byTool.map(t => ({ key: t.tool, weight: t.calls })));
  const buckets = bucketAxis(
    range,
    points.map(p => p.timestamp),
  );

  const totals: ToolTotals = {
    calls: 0,
    errors: 0,
    tools: byTool.length,
    tokens: 0,
    output: 0,
    cost: 0,
    unpriced: 0,
    resultChars: 0,
    argsChars: 0,
  };
  for (const t of byTool) {
    totals.calls += t.calls;
    totals.errors += t.errors;
    totals.tokens += t.totalTokensShare;
    totals.output += t.outputTokensShare;
    totals.cost += t.costShare;
    totals.unpriced += t.unpricedRequestsShare;
    totals.resultChars += t.resultChars;
    totals.argsChars += t.argsChars;
  }

  const [callSeries, errorSeries] = [(p: ToolTimeSeriesPoint) => p.calls, (p: ToolTimeSeriesPoint) => p.errors].map(
    value =>
      pivotSeries(points, { buckets, key: p => p.tool, value, limit: TOP_TOOLS, colors }).map(s => ({
        ...s,
        values: s.values.map(v => v || null),
      })),
  );
  const trends = new Map(
    pivotSeries(points, { buckets, key: p => p.tool, value: p => p.calls }).map(s => [s.key, s.values as number[]]),
  );

  const maxCalls = rows[0]?.calls ?? 0;
  const toolColumns = buildToolColumns(maxCalls, colors, trends, t);

  return {
    rows,
    colors,
    buckets,
    totals,
    callSeries,
    errorSeries,
    totalCalls: densify(points, buckets, p => p.calls),
    totalErrors: densify(points, buckets, p => p.errors),
    toolNames: rows.map(r => r.tool).sort((a, b) => a.localeCompare(b)),
    toolColumns,
  };
}

function buildToolColumns(
  maxCalls: number,
  colors: ReadonlyMap<string, string>,
  trends: ReadonlyMap<string, number[]>,
  t: TFunction,
): Column<ToolRowView>[] {
  return [
    {
      key: "tool",
      header: t("settingsPage.stats.tools.colTool"),
      sort: row => row.tool,
      render: row => (
        <span className="row" style={{ gap: 8 }}>
          <Swatch color={colors.get(row.tool) ?? OTHER_COLOR} />
          <span className="mono truncate tools-name" title={row.tool}>
            {row.tool}
          </span>
        </span>
      ),
    },
    {
      key: "trend",
      header: t("settingsPage.stats.tools.colTrend"),
      title: t("settingsPage.stats.tools.colTrendTitle"),
      render: row => {
        const values = trends.get(row.tool);
        return values && values.length > 1 ? (
          <Sparkline values={values} width={80} height={20} color={colors.get(row.tool) ?? OTHER_COLOR} />
        ) : (
          <span className="dim">–</span>
        );
      },
    },
    {
      key: "calls",
      header: t("settingsPage.stats.tools.colCalls"),
      align: "right",
      sort: row => row.calls,
      render: row => (
        <MeterCell
          value={row.calls}
          max={maxCalls}
          display={
            <span title={t("settingsPage.stats.tools.shareOfCalls", { share: formatPercent(row.callFraction) })}>
              {formatInteger(row.calls)}
              <span className="dim tools-share">{formatPercent(row.callFraction, 0)}</span>
            </span>
          }
        />
      ),
    },
    {
      key: "errorRate",
      header: t("settingsPage.stats.tools.colErrors"),
      title: t("settingsPage.stats.tools.colErrorsTitle"),
      align: "right",
      sort: row => row.errorRate,
      render: row => (
        <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <span className="num dim">{formatInteger(row.errors)}</span>
          <Badge tone={row.errors > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
            {formatPercent(row.errorRate)}
          </Badge>
        </span>
      ),
    },
    {
      key: "args",
      header: t("settingsPage.stats.tools.colArgs"),
      title: t("settingsPage.stats.tools.argsCharsTitle"),
      align: "right",
      sort: row => row.argsChars,
      render: row => <span className="num">{formatCompact(row.argsChars)}</span>,
    },
    {
      key: "result",
      header: t("settingsPage.stats.tools.colResult"),
      title: t("settingsPage.stats.tools.resultTextTitle"),
      align: "right",
      sort: row => row.resultChars,
      render: row => <span className="num">{formatCompact(row.resultChars)}</span>,
    },
    {
      key: "avgResult",
      header: t("settingsPage.stats.tools.colResultPerCall"),
      title: t("settingsPage.stats.tools.colResultPerCallTitle"),
      align: "right",
      sort: row => row.avgResultChars,
      render: row => <span className="num muted">{formatCompact(Math.round(row.avgResultChars))}</span>,
    },
    {
      key: "tokens",
      header: t("settingsPage.stats.tools.colAttrTokens"),
      title: t("settingsPage.stats.tools.attributionNote"),
      align: "right",
      sort: row => row.totalTokensShare,
      render: row => (
        <span className="num" title={t("settingsPage.stats.tools.shareOfTokens", { share: formatPercent(row.tokenFraction) })}>
          {formatCompact(Math.round(row.totalTokensShare))}
          <span className="dim tools-share">{formatPercent(row.tokenFraction, 0)}</span>
        </span>
      ),
    },
    {
      key: "cost",
      header: t("settingsPage.stats.tools.colAttrCost"),
      title: t("settingsPage.stats.tools.attributionNoteCost"),
      align: "right",
      sort: row => row.costShare,
      render: row => (
        <span className="num" title={t("settingsPage.stats.tools.shareOfCost", { share: formatPercent(row.costFraction) })}>
          {formatEstimatedCost(row.costShare, row.unpricedRequestsShare)}
          <span className="dim tools-share">{formatPercent(row.costFraction, 0)}</span>
        </span>
      ),
    },
    {
      key: "lastUsed",
      header: t("settingsPage.stats.tools.colLastUsed"),
      align: "right",
      sort: row => row.lastUsed,
      render: row => <span className="muted">{formatRelativeTime(row.lastUsed)}</span>,
    },
  ];
}

interface ToolModelRow extends ToolModelStats {
  errorRate: number;
}

function ToolModelTable({
  rows,
  tool,
  colors,
}: {
  rows: ToolModelStats[];
  tool: string | null;
  colors: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const filtered = useMemo<ToolModelRow[]>(
    () =>
      (tool === null ? rows : rows.filter(r => r.tool === tool)).map(r => ({
        ...r,
        errorRate: r.calls > 0 ? r.errors / r.calls : 0,
      })),
    [rows, tool],
  );
  const columns = useMemo<Column<ToolModelRow>[]>(() => {
    const maxCalls = filtered.reduce((max, r) => Math.max(max, r.calls), 0);
    return [
      {
        key: "tool",
        header: t("settingsPage.stats.tools.colTool"),
        sort: row => row.tool,
        render: row => (
          <span className="row" style={{ gap: 8 }}>
            <Swatch color={colors.get(row.tool) ?? OTHER_COLOR} />
            <span className="mono truncate tools-name" title={row.tool}>
              {row.tool}
            </span>
          </span>
        ),
      },
      {
        key: "model",
        header: t("settingsPage.stats.tools.colModel"),
        sort: row => row.model,
        render: row => (
          <LabelCell
            primary={<span className="mono">{row.model || t("settingsPage.stats.tools.unknownModel")}</span>}
            secondary={row.provider}
          />
        ),
      },
      {
        key: "calls",
        header: t("settingsPage.stats.tools.colCalls"),
        align: "right",
        sort: row => row.calls,
        render: row => <MeterCell value={row.calls} max={maxCalls} display={formatInteger(row.calls)} />,
      },
      {
        key: "errorRate",
        header: t("settingsPage.stats.tools.colErrors"),
        align: "right",
        sort: row => row.errorRate,
        render: row => (
          <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <span className="num dim">{formatInteger(row.errors)}</span>
            <Badge tone={row.errors > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
              {formatPercent(row.errorRate)}
            </Badge>
          </span>
        ),
      },
      {
        key: "result",
        header: t("settingsPage.stats.tools.colResult"),
        title: t("settingsPage.stats.tools.resultTextTitle"),
        align: "right",
        sort: row => row.resultChars,
        render: row => <span className="num">{formatCompact(row.resultChars)}</span>,
      },
      {
        key: "tokens",
        header: t("settingsPage.stats.tools.colAttrTokens"),
        title: t("settingsPage.stats.tools.attributionNote"),
        align: "right",
        sort: row => row.totalTokensShare,
        render: row => <span className="num">{formatCompact(Math.round(row.totalTokensShare))}</span>,
      },
      {
        key: "cost",
        header: t("settingsPage.stats.tools.colAttrCost"),
        title: t("settingsPage.stats.tools.attributionNoteCost"),
        align: "right",
        sort: row => row.costShare,
        render: row => <span className="num">{formatEstimatedCost(row.costShare, row.unpricedRequestsShare)}</span>,
      },
      {
        key: "lastUsed",
        header: t("settingsPage.stats.tools.colLastUsed"),
        align: "right",
        sort: row => row.lastUsed,
        render: row => <span className="muted">{formatRelativeTime(row.lastUsed)}</span>,
      },
    ];
  }, [filtered, colors, t]);

  return (
    <Table
      rows={filtered}
      rowKey={row => `${row.tool}::${row.model}::${row.provider}`}
      columns={columns}
      initialSort={{ key: "calls", dir: "desc" }}
      limit={25}
      dense
      empty={
        <EmptyState
          title={
            tool
              ? t("settingsPage.stats.tools.emptyNoCallsForTool", { tool })
              : t("settingsPage.stats.tools.emptyNoCalls")
          }
        />
      }
    />
  );
}
