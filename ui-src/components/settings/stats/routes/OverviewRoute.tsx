import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { getOverviewStats, getRecentRequests } from "../api";
import { Legend, ShareBar, TimeChart } from "../charts";
import {
  formatCompact,
  formatDurationMs,
  formatEstimatedCost,
  formatInteger,
  formatMessageCost,
  formatPercent,
  formatRelativeTime,
  formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import { buildAgentTokenShare, sumConversationTokens } from "../data/view-models";
import type { AgentType, MessageStats, TimeRange } from "../types";
import {
  Badge,
  Card,
  ChartSkeleton,
  Dot,
  LabelCell,
  PageHeader,
  QueryView,
  Segmented,
  Stat,
  StatGrid,
  Table,
  TableSkeleton,
} from "../ui";

export interface OverviewRouteProps {
  active: boolean;
  range: TimeRange;
  onRequestClick: (id: number) => void;
  onNavigate?: (route: string) => void;
}

type ActivityMetric = "requests" | "tokens" | "cost";

type TokenMixKey = "input" | "cacheRead" | "cacheWrite" | "output";

const AGENT_COLOR: Record<AgentType, string> = {
  main: "var(--chart-primary)",
  subagent: "var(--chart-secondary)",
  advisor: "#9d7bff",
};

const TOKEN_MIX_COLORS: Record<TokenMixKey, string> = {
  input: "#5b8cff",
  cacheRead: "var(--chart-primary)",
  cacheWrite: "#f5b54a",
  output: "var(--chart-secondary)",
};

export function OverviewRoute({ active, range, onRequestClick, onNavigate }: OverviewRouteProps) {
  const { t } = useTranslation();
  const overview = useQuery(["overview", range], () => getOverviewStats(range), { enabled: active });
  const recent = useQuery(["recent-requests"], () => getRecentRequests(12), { enabled: active });
  const [metric, setMetric] = useState<ActivityMetric>("requests");
  const meta = rangeMeta(range);

  const activityOptions = useMemo(
    () => [
      { value: "requests" as const, label: t("settingsPage.stats.overview.activityMetric.requests") },
      { value: "tokens" as const, label: t("settingsPage.stats.overview.activityMetric.tokens") },
      { value: "cost" as const, label: t("settingsPage.stats.overview.activityMetric.cost") },
    ],
    [t],
  );
  const agentLabel = useMemo<Record<AgentType, string>>(
    () => ({
      main: t("settingsPage.stats.overview.agent.main"),
      subagent: t("settingsPage.stats.overview.agent.subagent"),
      advisor: t("settingsPage.stats.overview.agent.advisor"),
    }),
    [t],
  );
  const tokenMix = useMemo(
    () =>
      (Object.keys(TOKEN_MIX_COLORS) as TokenMixKey[]).map(key => ({
        key,
        label: t(`settingsPage.stats.overview.tokenMix.${key}`),
        color: TOKEN_MIX_COLORS[key],
      })),
    [t],
  );
  const requestColumns = useMemo(() => buildRequestColumns(t), [t]);

  const series = useMemo(() => {
    const points = overview.data?.timeSeries ?? [];
    const buckets = bucketAxis(
      range,
      points.map(p => p.timestamp),
    );
    return {
      buckets,
      requests: densify(points, buckets, p => p.requests - p.errors),
      errors: densify(points, buckets, p => p.errors),
      tokens: densify(points, buckets, p => p.tokens),
      cost: densify(points, buckets, p => p.cost),
      all: densify(points, buckets, p => p.requests),
    };
  }, [overview.data, range]);

  const chartSeries =
    metric === "requests"
      ? [
          {
            key: "ok",
            label: t("settingsPage.stats.overview.chart.succeeded"),
            color: "var(--chart-primary)",
            values: series.requests,
          },
          {
            key: "err",
            label: t("settingsPage.stats.overview.chart.failed"),
            color: "var(--bad)",
            values: series.errors,
          },
        ]
      : metric === "tokens"
        ? [
            {
              key: "tokens",
              label: t("settingsPage.stats.overview.activityMetric.tokens"),
              color: "var(--chart-primary)",
              values: series.tokens,
            },
          ]
        : [
            {
              key: "cost",
              label: t("settingsPage.stats.overview.chart.apiEquivalent"),
              color: "var(--chart-secondary)",
              values: series.cost,
            },
          ];

  const activityUnit =
    meta.bucketMs < 3_600_000
      ? t("settingsPage.stats.overview.activityUnit.fiveMinutes")
      : meta.bucketMs < 86_400_000
        ? t("settingsPage.stats.overview.activityUnit.hour")
        : t("settingsPage.stats.overview.activityUnit.day");

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.overview.pageTitle")}
        description={t("settingsPage.stats.overview.pageDescription", { window: meta.windowLabel })}
      />

      <QueryView query={overview} skeleton={<ChartSkeleton height={112} />}>
        {({ overall }) => (
          <div data-stale={overview.stale} className="stack" style={{ gap: 16 }}>
            <StatGrid min={190}>
              <Stat
                label={t("settingsPage.stats.overview.stat.apiCost")}
                title={t("settingsPage.stats.overview.stat.apiCostTitle")}
                value={formatEstimatedCost(overall.totalCost, overall.unpricedRequests)}
                hint={
                  overall.unpricedRequests > 0
                    ? t("settingsPage.stats.overview.hint.unpriced", {
                        count: formatInteger(overall.unpricedRequests),
                      })
                    : undefined
                }
                spark={series.cost}
                sparkColor="var(--chart-secondary)"
              />
              <Stat
                label={t("settingsPage.stats.overview.stat.requests")}
                value={formatInteger(overall.totalRequests)}
                hint={t("settingsPage.stats.overview.hint.failed", {
                  count: formatInteger(overall.failedRequests),
                })}
                spark={series.all}
              />
              <Stat
                label={t("settingsPage.stats.overview.stat.conversationTokens")}
                title={t("settingsPage.stats.overview.stat.conversationTokensTitle")}
                value={formatCompact(sumConversationTokens(overall))}
                hint={t("settingsPage.stats.overview.hint.output", {
                  count: formatCompact(overall.totalOutputTokens),
                })}
                spark={series.tokens}
              />
              <Stat
                label={t("settingsPage.stats.overview.stat.cacheRate")}
                title={t("settingsPage.stats.overview.stat.cacheRateTitle")}
                value={formatPercent(overall.cacheRate)}
                hint={t("settingsPage.stats.overview.hint.saved", {
                  percent: formatPercent(overall.cacheSavings),
                })}
              />
              <Stat
                label={t("settingsPage.stats.overview.stat.errorRate")}
                value={formatPercent(overall.errorRate)}
                hint={t("settingsPage.stats.overview.hint.succeeded", {
                  count: formatInteger(overall.successfulRequests),
                })}
                spark={series.errors}
                sparkColor="var(--bad)"
              />
            </StatGrid>
            <StatGrid min={140}>
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.uncachedInput")}
                value={formatCompact(overall.totalInputTokens)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.cacheRead")}
                value={formatCompact(overall.totalCacheReadTokens)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.cacheWrite")}
                value={formatCompact(overall.totalCacheWriteTokens)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.output")}
                value={formatCompact(overall.totalOutputTokens)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.premiumRequests")}
                value={formatInteger(Math.round(overall.totalPremiumRequests * 100) / 100)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.tokensPerSec")}
                value={formatTokensPerSecond(overall.avgTokensPerSecond)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.avgLatency")}
                value={formatDurationMs(overall.avgDuration)}
              />
              <Stat
                size="sm"
                label={t("settingsPage.stats.overview.stat.avgTtft")}
                value={formatDurationMs(overall.avgTtft)}
              />
            </StatGrid>
          </div>
        )}
      </QueryView>

      <div className="grid grid-main-side">
        <Card
          index={1}
          title={t("settingsPage.stats.overview.activityCardTitle")}
          description={t("settingsPage.stats.overview.activityCardDescription", { unit: activityUnit })}
          actions={<Segmented size="sm" options={activityOptions} value={metric} onChange={setMetric} />}
          stale={overview.stale}
        >
          <QueryView query={overview} skeleton={<ChartSkeleton height={260} />}>
            {() => (
              <TimeChart
                buckets={series.buckets}
                bucketMs={meta.bucketMs}
                series={chartSeries}
                height={260}
                format={metric === "cost" ? v => formatEstimatedCost(v, 0) : formatCompact}
              />
            )}
          </QueryView>
        </Card>

        <Card
          index={2}
          title={t("settingsPage.stats.overview.tokenMixCardTitle")}
          description={t("settingsPage.stats.overview.tokenMixCardDescription")}
          stale={overview.stale}
        >
          <QueryView query={overview} skeleton={<ChartSkeleton height={260} />}>
            {({ overall, byAgentType }) => {
              const mix = {
                input: overall.totalInputTokens,
                cacheRead: overall.totalCacheReadTokens,
                cacheWrite: overall.totalCacheWriteTokens,
                output: overall.totalOutputTokens,
              };
              const total = sumConversationTokens(overall);
              const agents = buildAgentTokenShare(byAgentType);
              return (
                <div className="stack" style={{ gap: 18 }}>
                  <div className="stack" style={{ gap: 10 }}>
                    <ShareBar
                      segments={tokenMix.map(seg => ({
                        key: seg.key,
                        label: seg.label,
                        value: mix[seg.key],
                        color: seg.color,
                      }))}
                    />
                    <Legend
                      items={tokenMix.map(seg => ({
                        key: seg.key,
                        label: seg.label,
                        color: seg.color,
                        value: total > 0 ? formatPercent(mix[seg.key] / total, 0) : "–",
                      }))}
                    />
                  </div>
                  <div className="stack" style={{ gap: 10 }}>
                    <div className="section-label" style={{ marginBottom: 0 }}>
                      {t("settingsPage.stats.overview.byAgent")}
                    </div>
                    <ShareBar
                      segments={agents.segments.map(s => ({
                        key: s.agentType,
                        label: agentLabel[s.agentType],
                        value: s.tokens,
                        color: AGENT_COLOR[s.agentType],
                      }))}
                    />
                    {agents.segments.map(s => (
                      <div key={s.agentType} className="row" style={{ justifyContent: "space-between" }}>
                        <span className="row">
                          <span className="swatch" style={{ background: AGENT_COLOR[s.agentType] }} />
                          {agentLabel[s.agentType]}
                          <span className="dim num">
                            {t("settingsPage.stats.overview.reqCount", {
                              count: formatInteger(s.requests),
                            })}
                          </span>
                        </span>
                        <span className="row">
                          <span className="dim num">{formatCompact(s.tokens)}</span>
                          <span className="num" style={{ minWidth: 48, textAlign: "right" }}>
                            {formatPercent(s.share)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }}
          </QueryView>
        </Card>
      </div>

      <Card
        index={3}
        title={
          <>
            <Dot tone="live" pulse /> {t("settingsPage.stats.overview.latestCardTitle")}
          </>
        }
        description={t("settingsPage.stats.overview.latestCardDescription")}
        actions={
          <button
            type="button"
            className="btn"
            data-size="sm"
            data-variant="ghost"
            onClick={() => onNavigate?.("requests")}
          >
            {t("settingsPage.stats.overview.latestCardViewAll")} <ArrowRight size={13} />
          </button>
        }
        flush
      >
        <QueryView query={recent} skeleton={<TableSkeleton rows={8} />}>
          {rows => (
            <Table
              rows={rows}
              rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
              onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
              columns={requestColumns}
              dense
            />
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function buildRequestColumns(t: TFunction) {
  return [
    {
      key: "model",
      header: t("settingsPage.stats.overview.columns.model"),
      render: (row: MessageStats) => <LabelCell primary={row.model} secondary={row.provider} />,
    },
    {
      key: "time",
      header: t("settingsPage.stats.overview.columns.when"),
      render: (row: MessageStats) => <span className="muted">{formatRelativeTime(row.timestamp)}</span>,
    },
    {
      key: "tokens",
      header: t("settingsPage.stats.overview.columns.tokens"),
      align: "right" as const,
      render: (row: MessageStats) => <span className="num">{formatInteger(row.usage.totalTokens)}</span>,
    },
    {
      key: "cost",
      header: t("settingsPage.stats.overview.columns.cost"),
      align: "right" as const,
      render: (row: MessageStats) => <span className="num">{formatMessageCost(row, 4)}</span>,
    },
    {
      key: "duration",
      header: t("settingsPage.stats.overview.columns.duration"),
      align: "right" as const,
      render: (row: MessageStats) => <span className="num">{formatDurationMs(row.duration)}</span>,
    },
    {
      key: "status",
      header: t("settingsPage.stats.overview.columns.status"),
      align: "right" as const,
      render: (row: MessageStats) =>
        row.errorMessage ? (
          <Badge tone="bad">{t("settingsPage.stats.overview.badge.failed")}</Badge>
        ) : (
          <Badge tone="ok">{t("settingsPage.stats.overview.badge.ok")}</Badge>
        ),
    },
  ];
}
