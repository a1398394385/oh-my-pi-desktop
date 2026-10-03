import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getProviderDashboardStats, getProviderWindowStats } from "../api";
import { Chart, type ChartSeries, Legend, ShareBar, TimeChart, useHiddenSeries } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import {
  formatCompact,
  formatCost,
  formatEstimatedCost,
  formatInteger,
  formatPercent,
  formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import type {
  ProviderAggregate,
  ProviderHourlyPoint,
  ProviderWindowInsight,
  TimeRange,
} from "../types";
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
import { WindowUtilizationCard, type WindowRef } from "./ProvidersWindowUtilization";

export interface ProvidersRouteProps {
  active: boolean;
  range: TimeRange;
}

type BurnMetric = "tokens" | "cost" | "requests";

const TOP_PROVIDERS = 6;

// Labels come from i18n at render time; only stable key + color stay module-level.
const TOKEN_MIX = [
  { key: "input", color: "#5b8cff" },
  { key: "cacheRead", color: "var(--chart-primary)" },
  { key: "cacheWrite", color: "#f5b54a" },
  { key: "output", color: "var(--chart-secondary)" },
] as const;

const TOKEN_LABEL_KEYS: Record<(typeof TOKEN_MIX)[number]["key"], string> = {
  input: "settingsPage.stats.providers.mixInput",
  cacheRead: "settingsPage.stats.providers.mixCacheRead",
  cacheWrite: "settingsPage.stats.providers.mixCacheWrite",
  output: "settingsPage.stats.providers.mixOutput",
};

export function ProvidersRoute({ active, range }: ProvidersRouteProps) {
  const { t } = useTranslation();
  const stats = useQuery(["providers", range], () => getProviderDashboardStats(range), { enabled: active });
  const [metric, setMetric] = useState<BurnMetric>("tokens");
  const [hidden, toggleHidden] = useHiddenSeries();
  const meta = rangeMeta(range);
  const burnOptions = useMemo(
    () => [
      { value: "tokens" as const, label: t("settingsPage.stats.providers.burnTokens") },
      {
        value: "cost" as const,
        label: t("settingsPage.stats.providers.burnCost"),
        title: t("settingsPage.stats.providers.burnCostTitle"),
      },
      { value: "requests" as const, label: t("settingsPage.stats.providers.burnRequests") },
    ],
    [t],
  );

  const windows = useQuery(["provider-windows", range], () => getProviderWindowStats(range, null), {
    enabled: active,
  });
  const [picked, setPicked] = useState<WindowRef | null>(null);
  const selected = resolveWindow(windows.data?.windowInsights ?? [], picked);
  const selectedProvider = selected?.provider ?? null;
  const accounts = useQuery(
    ["provider-windows", range, selectedProvider],
    () => getProviderWindowStats(range, selectedProvider),
    { enabled: active && selectedProvider !== null },
  );

  const view = useMemo(() => {
    const providers = stats.data?.providers ?? [];
    const points = stats.data?.series ?? [];
    const colors = buildColorLookup(providers.map(p => ({ key: p.provider, weight: p.totalTokens })));
    const buckets = bucketAxis(
      range,
      points.map(p => p.timestamp),
    );
    const totals = { requests: 0, failed: 0, tokens: 0, cost: 0, unpriced: 0 };
    for (const p of providers) {
      totals.requests += p.totalRequests;
      totals.failed += p.failedRequests;
      totals.tokens += p.totalTokens;
      totals.cost += p.totalCost;
      totals.unpriced += p.unpricedRequests;
    }
    const pivot = (value: (p: (typeof points)[number]) => number) =>
      pivotSeries(points, { buckets, key: p => p.provider, value, limit: TOP_PROVIDERS, colors }).map(s => ({
        ...s,
        values: s.values.map(v => v || null),
      }));
    return {
      colors,
      buckets,
      totals,
      burn: {
        tokens: pivot(p => p.totalTokens),
        cost: pivot(p => p.cost),
        requests: pivot(p => p.requests),
      } satisfies Record<BurnMetric, ChartSeries[]>,
      spark: {
        tokens: densify(points, buckets, p => p.totalTokens),
        cost: densify(points, buckets, p => p.cost),
        requests: densify(points, buckets, p => p.requests),
      },
      topProvider: providers.reduce<ProviderAggregate | null>(
        (top, p) => (top === null || p.totalTokens > top.totalTokens ? p : top),
        null,
      ),
    };
  }, [stats.data, range]);

  const burnSeries = view.burn[metric];
  const burnFormat = metric === "cost" ? (v: number) => formatCost(v) : formatCompact;
  const totals = view.totals;

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.providers.title")}
        description={t("settingsPage.stats.providers.desc", { window: meta.windowLabel })}
      />

      <QueryView query={stats} skeleton={<ChartSkeleton height={112} />}>
        {({ providers }) => (
          <div data-stale={stats.stale}>
            <StatGrid min={190}>
              <Stat
                label={t("settingsPage.stats.providers.statProviders")}
                value={formatInteger(providers.length)}
                hint={
                  view.topProvider
                    ? t("settingsPage.stats.providers.statProvidersHint", { provider: view.topProvider.provider })
                    : undefined
                }
              />
              <Stat
                label={t("settingsPage.stats.providers.statRequests")}
                value={formatInteger(totals.requests)}
                hint={t("settingsPage.stats.providers.statFailedHint", { count: totals.failed })}
                spark={view.spark.requests}
              />
              <Stat
                label={t("settingsPage.stats.providers.statTokens")}
                title={t("settingsPage.stats.providers.statTokensTitle")}
                value={formatCompact(totals.tokens)}
                spark={view.spark.tokens}
              />
              <Stat
                label={t("settingsPage.stats.providers.statCost")}
                title={t("settingsPage.stats.providers.statCostTitle")}
                value={formatEstimatedCost(totals.cost, totals.unpriced)}
                hint={
                  totals.unpriced > 0
                    ? t("settingsPage.stats.providers.statUnpricedHint", { count: totals.unpriced })
                    : undefined
                }
                spark={view.spark.cost}
                sparkColor="var(--chart-secondary)"
              />
              <Stat
                label={t("settingsPage.stats.providers.statErrorRate")}
                value={formatPercent(totals.requests > 0 ? totals.failed / totals.requests : 0)}
                hint={t("settingsPage.stats.providers.statSucceededHint", {
                  count: totals.requests - totals.failed,
                })}
              />
            </StatGrid>
          </div>
        )}
      </QueryView>

      <Card
        index={1}
        title={t("settingsPage.stats.providers.totalsTitle")}
        description={
          totals.unpriced > 0
            ? t("settingsPage.stats.providers.totalsDescUnpriced", { count: totals.unpriced })
            : t("settingsPage.stats.providers.totalsDesc")
        }
        flush
        stale={stats.stale}
      >
        <QueryView query={stats} skeleton={<TableSkeleton rows={6} />}>
          {({ providers }) => <ProviderTotalsTable providers={providers} colors={view.colors} />}
        </QueryView>
      </Card>

      <div className="grid grid-main-side">
        <Card
          index={2}
          title={t("settingsPage.stats.providers.burnTitle")}
          description={
            metric === "cost" && totals.unpriced > 0
              ? t("settingsPage.stats.providers.burnDescCost", {
                  bucket:
                    meta.bucketMs < 86_400_000
                      ? t("settingsPage.stats.providers.unitHour")
                      : t("settingsPage.stats.providers.unitDay"),
                })
              : t("settingsPage.stats.providers.burnDescGeneral", {
                  bucket:
                    meta.bucketMs < 3_600_000
                      ? t("settingsPage.stats.providers.unit5Minutes")
                      : meta.bucketMs < 86_400_000
                        ? t("settingsPage.stats.providers.unitHour")
                        : t("settingsPage.stats.providers.unitDay"),
                  count: TOP_PROVIDERS,
                })
          }
          actions={<Segmented size="sm" options={burnOptions} value={metric} onChange={setMetric} />}
          stale={stats.stale}
        >
          <QueryView query={stats} skeleton={<ChartSkeleton height={260} />}>
            {() => (
              <div className="stack" style={{ gap: 12 }}>
                <TimeChart
                  buckets={view.buckets}
                  bucketMs={meta.bucketMs}
                  series={burnSeries}
                  hidden={hidden}
                  height={260}
                  format={burnFormat}
                  formatTooltip={metric === "cost" ? v => formatCost(v) : formatInteger}
                  emptyLabel={t("settingsPage.stats.providers.burnEmpty")}
                />
                <Legend
                  items={burnSeries.map(s => ({
                    key: s.key,
                    label: s.label,
                    color: s.color,
                    value: burnFormat(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
                  }))}
                  hidden={hidden}
                  onToggle={toggleHidden}
                />
              </div>
            )}
          </QueryView>
        </Card>

        <QueryView query={stats} skeleton={<ChartSkeleton height={320} />}>
          {({ hourly, providers }) => <PeakHoursCard hourly={hourly} providers={providers} stale={stats.stale} />}
        </QueryView>
      </div>

      <Card
        index={4}
        title={t("settingsPage.stats.providers.windowsTitle")}
        description={t("settingsPage.stats.providers.windowsDesc")}
        flush
        stale={windows.stale}
      >
        <QueryView query={windows} skeleton={<TableSkeleton rows={6} />}>
          {data => <WindowInsightsTable insights={data.windowInsights} selected={selected} onSelect={setPicked} />}
        </QueryView>
      </Card>

      <WindowUtilizationCard
        insights={windows.data?.windowInsights ?? null}
        accounts={accounts}
        selected={selected}
        onSelect={setPicked}
      />
    </div>
  );
}

function resolveWindow(insights: readonly ProviderWindowInsight[], picked: WindowRef | null): WindowRef | null {
  if (picked && insights.some(i => i.provider === picked.provider && i.windowKey === picked.windowKey)) return picked;
  const fallback =
    (picked && insights.find(i => i.provider === picked.provider)) ||
    insights.reduce<ProviderWindowInsight | undefined>(
      (top, i) => (top === undefined || i.fractionConsumed > top.fractionConsumed ? i : top),
      undefined,
    );
  return fallback ? { provider: fallback.provider, windowKey: fallback.windowKey } : null;
}

function ProviderTotalsTable({
  providers,
  colors,
}: {
  providers: ProviderAggregate[];
  colors: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const columns = useMemo<Column<ProviderAggregate>[]>(() => {
    let maxRequests = 0;
    let maxTokens = 0;
    let grandTokens = 0;
    for (const p of providers) {
      maxRequests = Math.max(maxRequests, p.totalRequests);
      maxTokens = Math.max(maxTokens, p.totalTokens);
      grandTokens += p.totalTokens;
    }
    return [
      {
        key: "provider",
        header: t("settingsPage.stats.providers.colProvider"),
        sort: p => p.provider,
        render: p => (
          <span className="row" style={{ gap: 8 }}>
            <Swatch color={colors.get(p.provider) ?? OTHER_COLOR} />
            <span className="mono cell-primary">{p.provider}</span>
          </span>
        ),
      },
      {
        key: "requests",
        header: t("settingsPage.stats.providers.colRequests"),
        align: "right",
        sort: p => p.totalRequests,
        render: p => (
          <MeterCell value={p.totalRequests} max={maxRequests} display={formatInteger(p.totalRequests)} />
        ),
      },
      {
        key: "errors",
        header: t("settingsPage.stats.providers.colErrorRate"),
        align: "right",
        sort: p => (p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0),
        render: p => {
          const rate = p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0;
          return (
            <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <span className="num dim">{formatInteger(p.failedRequests)}</span>
              <Badge tone={p.failedRequests > 0 ? errorRateTone(rate) : "neutral"} mono>
                {formatPercent(rate)}
              </Badge>
            </span>
          );
        },
      },
      {
        key: "models",
        header: t("settingsPage.stats.providers.colModels"),
        title: t("settingsPage.stats.providers.colModelsTitle"),
        align: "right",
        sort: p => p.models,
        render: p => <span className="num">{formatInteger(p.models)}</span>,
      },
      {
        key: "tokens",
        header: t("settingsPage.stats.providers.colTokens"),
        title: t("settingsPage.stats.providers.statTokensTitle"),
        align: "right",
        sort: p => p.totalTokens,
        render: p => (
          <MeterCell
            value={p.totalTokens}
            max={maxTokens}
            display={formatCompact(p.totalTokens)}
            color={colors.get(p.provider)}
          />
        ),
      },
      {
        key: "share",
        header: t("settingsPage.stats.providers.colShare"),
        title: t("settingsPage.stats.providers.colShareTitle"),
        align: "right",
        sort: p => p.totalTokens,
        render: p => (
          <span className="num muted">{formatPercent(grandTokens > 0 ? p.totalTokens / grandTokens : 0)}</span>
        ),
      },
      {
        key: "cost",
        header: t("settingsPage.stats.providers.colCost"),
        title: t("settingsPage.stats.providers.colCostTitle"),
        align: "right",
        sort: p => p.totalCost,
        render: p => (
          <span
            className="num"
            title={
              p.unpricedRequests > 0
                ? t("settingsPage.stats.providers.statUnpricedHint", { count: p.unpricedRequests })
                : undefined
            }
          >
            {formatEstimatedCost(p.totalCost, p.unpricedRequests)}
          </span>
        ),
      },
      {
        key: "tps",
        header: t("settingsPage.stats.providers.colTps"),
        title: t("settingsPage.stats.providers.colTpsTitle"),
        align: "right",
        sort: p => p.avgTokensPerSecond ?? -1,
        render: p => <span className="num">{formatTokensPerSecond(p.avgTokensPerSecond)}</span>,
      },
      {
        key: "premium",
        header: t("settingsPage.stats.providers.colPremium"),
        title: t("settingsPage.stats.providers.colPremiumTitle"),
        align: "right",
        sort: p => p.totalPremiumRequests,
        render: p => (
          <span className={p.totalPremiumRequests > 0 ? "num" : "num dim"}>
            {formatInteger(Math.round(p.totalPremiumRequests * 100) / 100)}
          </span>
        ),
      },
    ];
  }, [providers, colors, t]);

  return (
    <Table
      rows={providers}
      rowKey={p => p.provider}
      columns={columns}
      initialSort={{ key: "tokens", dir: "desc" }}
      limit={12}
      selectedKey={open}
      onRowClick={p => setOpen(prev => (prev === p.provider ? null : p.provider))}
      expanded={p => (p.provider === open ? <TokenMix provider={p} /> : null)}
      empty={<EmptyState title={t("settingsPage.stats.providers.totalsEmpty")} />}
    />
  );
}

function TokenMix({ provider }: { provider: ProviderAggregate }) {
  const { t } = useTranslation();
  const mix = {
    input: provider.totalInputTokens,
    cacheRead: provider.totalCacheReadTokens,
    cacheWrite: provider.totalCacheWriteTokens,
    output: provider.totalOutputTokens,
  };
  return (
    <div className="providers-mix">
      <ShareBar
        segments={TOKEN_MIX.map(m => ({
          key: m.key,
          label: t(TOKEN_LABEL_KEYS[m.key]),
          value: mix[m.key],
          color: m.color,
        }))}
      />
      <Legend
        items={TOKEN_MIX.map(m => ({
          key: m.key,
          label: t(TOKEN_LABEL_KEYS[m.key]),
          color: m.color,
          value: `${formatCompact(mix[m.key])} · ${provider.totalTokens > 0 ? formatPercent(mix[m.key] / provider.totalTokens, 0) : "–"}`,
        }))}
      />
    </div>
  );
}

const ALL_PROVIDERS = "";

function PeakHoursCard({
  hourly,
  providers,
  stale,
}: {
  hourly: ProviderHourlyPoint[];
  providers: ProviderAggregate[];
  stale: boolean;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState(ALL_PROVIDERS);
  const current =
    provider === ALL_PROVIDERS || providers.some(p => p.provider === provider) ? provider : ALL_PROVIDERS;

  const hours = useMemo(() => {
    const tokens = Array.from({ length: 24 }, () => 0);
    const output = Array.from({ length: 24 }, () => 0);
    const requests = Array.from({ length: 24 }, () => 0);
    for (const point of hourly) {
      if (current !== ALL_PROVIDERS && point.provider !== current) continue;
      tokens[point.hour] += point.totalTokens;
      output[point.hour] += point.outputTokens;
      requests[point.hour] += point.requests;
    }
    let peak = 0;
    for (let hour = 1; hour < 24; hour++) if (tokens[hour] > tokens[peak]) peak = hour;
    const hasData = tokens[peak] > 0;
    const series: ChartSeries[] = [
      {
        key: "tokens",
        label: t("settingsPage.stats.providers.burnTokens"),
        color: "var(--chart-primary)",
        values: tokens.map((v, hour) => (hasData && hour === peak ? null : v)),
      },
      {
        key: "peak",
        label: t("settingsPage.stats.providers.peakSeries"),
        color: "var(--chart-secondary)",
        values: tokens.map((v, hour) => (hasData && hour === peak ? v : null)),
      },
    ];
    return { series, output, requests, peak, hasData };
  }, [hourly, current, t]);

  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

  return (
    <Card
      index={3}
      title={t("settingsPage.stats.providers.peakTitle")}
      description={
        hours.hasData
          ? t("settingsPage.stats.providers.peakDescWithPeak", { time: hourLabel(hours.peak) })
          : t("settingsPage.stats.providers.peakDesc")
      }
      actions={
        <select
          className="input providers-select"
          value={current}
          onChange={e => setProvider(e.target.value)}
          aria-label={t("settingsPage.stats.providers.providerAria")}
        >
          <option value={ALL_PROVIDERS}>{t("settingsPage.stats.providers.allProviders")}</option>
          {providers.map(p => (
            <option key={p.provider} value={p.provider}>
              {p.provider}
            </option>
          ))}
        </select>
      }
      stale={stale}
    >
      <Chart
        slots={24}
        tickLabel={hour => String(hour).padStart(2, "0")}
        tooltipTitle={hour => `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`}
        series={hours.series}
        height={260}
        showTotal={false}
        formatTooltip={formatInteger}
        emptyLabel={t("settingsPage.stats.providers.peakEmpty")}
        tooltipExtra={hour => (
          <>
            <div className="chart-tooltip-row">
              <span className="chart-tooltip-label">{t("settingsPage.stats.providers.mixOutput")}</span>
              <span className="chart-tooltip-value">{formatInteger(hours.output[hour])}</span>
            </div>
            <div className="chart-tooltip-row">
              <span className="chart-tooltip-label">{t("settingsPage.stats.providers.burnRequests")}</span>
              <span className="chart-tooltip-value">{formatInteger(hours.requests[hour])}</span>
            </div>
          </>
        )}
      />
    </Card>
  );
}

function WindowInsightsTable({
  insights,
  selected,
  onSelect,
}: {
  insights: ProviderWindowInsight[];
  selected: WindowRef | null;
  onSelect: (ref: WindowRef) => void;
}) {
  const { t } = useTranslation();
  const columns = useMemo<Column<ProviderWindowInsight>[]>(
    () => [
      {
        key: "window",
        header: t("settingsPage.stats.providers.colWindow"),
        sort: i => `${i.provider} ${i.windowLabel}`,
        render: i => <LabelCell primary={i.windowLabel} secondary={<span className="mono">{i.provider}</span>} />,
      },
      {
        key: "accounts",
        header: t("settingsPage.stats.providers.colAccounts"),
        title: t("settingsPage.stats.providers.colAccountsTitle"),
        align: "right",
        sort: i => i.accounts,
        render: i => <span className="num">{formatInteger(i.accounts)}</span>,
      },
      {
        key: "cycles",
        header: t("settingsPage.stats.providers.colResets"),
        title: t("settingsPage.stats.providers.colResetsTitle"),
        align: "right",
        sort: i => i.cycles,
        render: i => <span className="num muted">{formatInteger(i.cycles)}</span>,
      },
      {
        key: "consumed",
        header: t("settingsPage.stats.providers.colConsumed"),
        title: t("settingsPage.stats.providers.colConsumedTitle"),
        align: "right",
        sort: i => i.fractionConsumed,
        render: i => <span className="num">{i.fractionConsumed.toFixed(2)}</span>,
      },
      {
        key: "capacity",
        header: t("settingsPage.stats.providers.colCapacity"),
        title: t("settingsPage.stats.providers.colCapacityTitle"),
        align: "right",
        sort: i => i.estTokensPerWindow ?? -1,
        render: i =>
          i.estTokensPerWindow !== null ? (
            <span className="num">{formatCompact(i.estTokensPerWindow)}</span>
          ) : (
            <span className="dim" title={t("settingsPage.stats.providers.tooLittleData")}>
              –
            </span>
          ),
      },
      {
        key: "peak",
        header: t("settingsPage.stats.providers.colPeak"),
        title: t("settingsPage.stats.providers.colPeakTitle"),
        align: "right",
        sort: i => i.peakConcurrentFraction,
        render: i => {
          const load = i.accounts > 0 ? i.peakConcurrentFraction / i.accounts : 0;
          return (
            <MeterCell
              value={i.peakConcurrentFraction}
              max={i.accounts}
              display={formatPercent(i.peakConcurrentFraction, 0)}
              color={load >= 0.9 ? "var(--warn)" : undefined}
            />
          );
        },
      },
      {
        key: "ideal",
        header: t("settingsPage.stats.providers.colIdeal"),
        title: t("settingsPage.stats.providers.colIdealTitle"),
        align: "right",
        sort: i => i.idealAccounts - i.accounts,
        render: i =>
          i.idealAccounts > i.accounts ? (
            <Badge tone="warn" mono>
              {t("settingsPage.stats.providers.idealBadge", {
                ideal: formatInteger(i.idealAccounts),
                accounts: formatInteger(i.accounts),
              })}
            </Badge>
          ) : (
            <span className="num">{formatInteger(i.idealAccounts)}</span>
          ),
      },
      {
        key: "exhausted",
        header: t("settingsPage.stats.providers.colExhausted"),
        title: t("settingsPage.stats.providers.colExhaustedTitle"),
        align: "right",
        sort: i => i.exhaustedEvents,
        render: i =>
          i.exhaustedEvents > 0 ? (
            <Badge tone="warn" mono>
              {t("settingsPage.stats.providers.exhaustedBadge", { count: i.exhaustedEvents })}
            </Badge>
          ) : (
            <span className="num dim">0</span>
          ),
      },
    ],
    [t],
  );

  return (
    <Table
      rows={insights}
      rowKey={i => `${i.provider}::${i.windowKey}`}
      columns={columns}
      initialSort={{ key: "consumed", dir: "desc" }}
      limit={12}
      selectedKey={selected ? `${selected.provider}::${selected.windowKey}` : null}
      onRowClick={i => onSelect({ provider: i.provider, windowKey: i.windowKey })}
      empty={
        <EmptyState
          title={t("settingsPage.stats.providers.snapshotsEmpty")}
          hint={t("settingsPage.stats.providers.snapshotHint")}
        />
      }
    />
  );
}
