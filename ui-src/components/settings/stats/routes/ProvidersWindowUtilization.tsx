import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { t as ti } from "../../../../i18n";
import { Chart, type ChartSeries, Legend, useHiddenSeries } from "../charts";
import { SERIES_COLORS } from "../data/colors";
import { formatInteger, formatPercent, formatRelativeTime } from "../data/formatters";
import type { QueryResult } from "../data/query";
import { bucketAxis, formatBucket, formatTick } from "../data/range";
import type {
  ProviderWindowInsight,
  ProviderWindowStats,
  UsageWindowSeries,
} from "../types";
import {
  Badge,
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  MeterCell,
  QueryView,
  Swatch,
  Table,
} from "../ui";

export interface WindowRef {
  provider: string;
  windowKey: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const UTIL_STEPS = [
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
];
const MAX_UTIL_SLOTS = 240;
const MAX_HOLD_MS = 6 * HOUR_MS;

const WINDOW_RANGE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface AccountRow {
  series: UsageWindowSeries;
  name: string;
  color: string | null;
  latest: { fraction: number; exhausted: boolean; timestamp: number } | null;
  peak: number | null;
  samples: number;
}

export function WindowUtilizationCard({
  insights,
  accounts,
  selected,
  onSelect,
}: {
  insights: ProviderWindowInsight[] | null;
  accounts: QueryResult<ProviderWindowStats>;
  selected: WindowRef | null;
  onSelect: (ref: WindowRef) => void;
}) {
  const { t } = useTranslation();
  const [hidden, toggleHidden] = useHiddenSeries();

  const providers = useMemo(() => [...new Set((insights ?? []).map(i => i.provider))], [insights]);
  const windows = useMemo(
    () =>
      (insights ?? [])
        .filter(i => i.provider === selected?.provider)
        .map(i => ({ key: i.windowKey, label: i.windowLabel })),
    [insights, selected?.provider],
  );

  const providerSeries = useMemo(
    () => (accounts.data?.usageSeries ?? []).filter(s => s.provider === selected?.provider),
    [accounts.data, selected?.provider],
  );
  const loadingSeries = providerSeries.length === 0 && (accounts.loading || accounts.stale);

  const names = useMemo(() => {
    const keysByLabel = new Map<string, string[]>();
    for (const s of providerSeries) {
      const keys = keysByLabel.get(s.accountLabel) ?? [];
      if (!keys.includes(s.accountKey)) keys.push(s.accountKey);
      keysByLabel.set(s.accountLabel, keys);
    }
    const out = new Map<string, string>();
    for (const [label, keys] of keysByLabel) {
      keys.sort();
      keys.forEach((key, i) => out.set(key, keys.length > 1 ? `${label} #${i + 1}` : label));
    }
    return out;
  }, [providerSeries]);

  const chart = useMemo(
    () =>
      buildUtilization(
        providerSeries.filter(s => s.windowKey === selected?.windowKey),
        names,
      ),
    [providerSeries, names, selected?.windowKey],
  );

  const rows = useMemo<AccountRow[]>(() => {
    const colorOf = new Map(chart.series.map(s => [s.key, s.color]));
    return providerSeries
      .map(series => {
        let latest: AccountRow["latest"] = null;
        let peak: number | null = null;
        for (const p of series.points) {
          if (p.usedFraction === null) continue;
          peak = Math.max(peak ?? 0, p.usedFraction);
          if (!latest || p.timestamp >= latest.timestamp)
            latest = { fraction: p.usedFraction, exhausted: p.exhausted, timestamp: p.timestamp };
        }
        const color = series.windowKey === selected?.windowKey ? (colorOf.get(series.accountKey) ?? null) : null;
        const name = names.get(series.accountKey) ?? series.accountLabel;
        return { series, name, color, latest, peak, samples: series.points.length };
      })
      .sort(
        (a, b) =>
          Number(b.color !== null) - Number(a.color !== null) ||
          a.series.windowLabel.localeCompare(b.series.windowLabel) ||
          (b.latest?.fraction ?? -1) - (a.latest?.fraction ?? -1),
      );
  }, [providerSeries, names, chart.series, selected?.windowKey]);

  const windowLabel = windows.find(w => w.key === selected?.windowKey)?.label;

  const accountColumns = useMemo<Column<AccountRow>[]>(
    () => [
      {
        key: "account",
        header: t("settingsPage.stats.providers.colAccount"),
        sort: r => r.name,
        render: r => (
          <span className="row" style={{ gap: 8 }}>
            <span className="providers-swatch-slot">{r.color && <Swatch color={r.color} />}</span>
            <span className="truncate providers-account" title={r.series.accountKey}>
              {r.name}
            </span>
          </span>
        ),
      },
      {
        key: "window",
        header: t("settingsPage.stats.providers.colWindow"),
        sort: r => r.series.windowLabel,
        render: r => <span className={r.color ? undefined : "muted"}>{r.series.windowLabel}</span>,
      },
      {
        key: "latest",
        header: t("settingsPage.stats.providers.colLatestUsed"),
        align: "right",
        sort: r => r.latest?.fraction ?? -1,
        render: r =>
          r.latest ? (
            <MeterCell
              value={r.latest.fraction}
              max={1}
              display={formatPercent(r.latest.fraction, 0)}
              color={r.latest.exhausted ? "var(--bad)" : r.latest.fraction >= 0.8 ? "var(--warn)" : "var(--ok)"}
            />
          ) : (
            <span className="dim">–</span>
          ),
      },
      {
        key: "status",
        header: t("settingsPage.stats.providers.colStatus"),
        sort: r => (r.latest?.exhausted ? 2 : (r.latest?.fraction ?? 0) >= 0.8 ? 1 : 0),
        render: r => statusBadge(r.latest),
      },
      {
        key: "peak",
        header: t("settingsPage.stats.providers.colPeakInRange"),
        align: "right",
        sort: r => r.peak ?? -1,
        render: r => <span className="num">{r.peak === null ? "–" : formatPercent(r.peak, 0)}</span>,
      },
      {
        key: "samples",
        header: t("settingsPage.stats.providers.colSnapshots"),
        align: "right",
        sort: r => r.samples,
        render: r => <span className="num muted">{formatInteger(r.samples)}</span>,
      },
      {
        key: "recorded",
        header: t("settingsPage.stats.providers.colRecorded"),
        align: "right",
        sort: r => r.latest?.timestamp ?? 0,
        render: r => <span className="muted">{r.latest ? formatRelativeTime(r.latest.timestamp) : "–"}</span>,
      },
    ],
    [t],
  );

  return (
    <Card
      index={5}
      title={t("settingsPage.stats.providers.utilTitle")}
      description={
        chart.buckets.length > 0
          ? t("settingsPage.stats.providers.utilDescRange", {
              window: windowLabel ?? t("settingsPage.stats.providers.colWindow"),
              from: WINDOW_RANGE_FMT.format(new Date(chart.first)),
              to: WINDOW_RANGE_FMT.format(new Date(chart.last)),
            })
          : t("settingsPage.stats.providers.utilDescEmpty")
      }
      actions={
        selected && (
          <div className="row" style={{ gap: 6 }}>
            <select
              className="input providers-select"
              value={selected.provider}
              onChange={e => {
                const next = e.target.value;
                const first = insights?.find(i => i.provider === next);
                if (first) onSelect({ provider: next, windowKey: first.windowKey });
              }}
              aria-label={t("settingsPage.stats.providers.providerAria")}
            >
              {providers.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className="input providers-select"
              value={selected.windowKey}
              onChange={e => onSelect({ provider: selected.provider, windowKey: e.target.value })}
              aria-label={t("settingsPage.stats.providers.colWindow")}
            >
              {windows.map(w => (
                <option key={w.key} value={w.key}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
        )
      }
      stale={accounts.stale}
    >
      {insights === null ? (
        <ChartSkeleton height={260} />
      ) : selected === null ? (
        <EmptyState
          title={t("settingsPage.stats.providers.snapshotsEmpty")}
          hint={t("settingsPage.stats.providers.snapshotHint")}
        />
      ) : (
        <QueryView query={accounts} skeleton={<ChartSkeleton height={260} />}>
          {() =>
            loadingSeries ? (
              <ChartSkeleton height={260} />
            ) : (
              <div className="stack" style={{ gap: 16 }}>
                <div className="stack" style={{ gap: 12 }}>
                  <Chart
                    slots={chart.buckets.length}
                    tickLabel={i =>
                      formatTick(
                        chart.buckets[i],
                        chart.last - chart.first > DAY_MS ? DAY_MS : chart.bucketMs,
                      )
                    }
                    tooltipTitle={i => formatBucket(chart.buckets[i], HOUR_MS)}
                    series={chart.series}
                    hidden={hidden}
                    kind="line"
                    stacked={false}
                    height={260}
                    yMax={Math.max(1, chart.max)}
                    format={v => formatPercent(v, 0)}
                    formatTooltip={v => formatPercent(v, 1)}
                    references={[{ value: 1, label: "100%" }]}
                    emptyLabel={t("settingsPage.stats.providers.utilEmpty")}
                    tooltipExtra={i => {
                      const exhausted = chart.exhausted[i];
                      return exhausted.length > 0 ? (
                        <div className="chart-tooltip-row">
                          <span className="chart-tooltip-label tone-bad">
                            {t("settingsPage.stats.providers.tooltipExhausted")}
                          </span>
                          <span className="chart-tooltip-value">{exhausted.join(", ")}</span>
                        </div>
                      ) : null;
                    }}
                  />
                  {chart.series.length > 1 && (
                    <Legend
                      items={chart.series.map(s => ({ key: s.key, label: s.label, color: s.color }))}
                      hidden={hidden}
                      onToggle={toggleHidden}
                    />
                  )}
                </div>
                <div className="providers-accounts">
                  <Table
                    rows={rows}
                    rowKey={r => `${r.series.windowKey}::${r.series.accountKey}`}
                    columns={accountColumns}
                    limit={16}
                    onRowClick={r => onSelect({ provider: r.series.provider, windowKey: r.series.windowKey })}
                    dense
                  />
                </div>
              </div>
            )
          }
        </QueryView>
      )}
    </Card>
  );
}

interface UtilizationChart {
  buckets: number[];
  bucketMs: number;
  first: number;
  last: number;
  max: number;
  series: ChartSeries[];
  exhausted: string[][];
}

function buildUtilization(accounts: UsageWindowSeries[], names: ReadonlyMap<string, string>): UtilizationChart {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const s of accounts) {
    for (const p of s.points) {
      if (p.timestamp < first) first = p.timestamp;
      if (p.timestamp > last) last = p.timestamp;
    }
  }
  if (!(last >= first))
    return { buckets: [], bucketMs: HOUR_MS, first: 0, last: 0, max: 0, series: [], exhausted: [] };

  const span = last - first;
  const bucketMs = UTIL_STEPS.find(step => span / step < MAX_UTIL_SLOTS) ?? DAY_MS;
  const buckets = bucketAxis("all", [first], bucketMs, last);
  const index = (ts: number) => Math.floor((ts - buckets[0]) / bucketMs);
  const exhausted = buckets.map((): string[] => []);
  let max = 0;

  const nameOf = (account: UsageWindowSeries) => names.get(account.accountKey) ?? account.accountLabel;
  const ordered = [...accounts].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const series = ordered.map((account, rank): ChartSeries => {
    const values: (number | null)[] = buckets.map(() => null);
    const readAt: number[] = buckets.map(() => 0);
    for (const p of account.points) {
      const i = index(p.timestamp);
      if (i < 0 || i >= buckets.length) continue;
      if (p.exhausted && !exhausted[i].includes(nameOf(account))) exhausted[i].push(nameOf(account));
      if (p.usedFraction === null || p.timestamp < readAt[i]) continue;
      values[i] = p.usedFraction;
      readAt[i] = p.timestamp;
      max = Math.max(max, p.usedFraction);
    }
    let held: number | null = null;
    let heldAt = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (values[i] !== null) {
        held = values[i];
        heldAt = readAt[i];
      } else if (held !== null && buckets[i] - heldAt <= MAX_HOLD_MS) {
        values[i] = held;
      }
    }
    return {
      key: account.accountKey,
      label: nameOf(account),
      color: SERIES_COLORS[rank % SERIES_COLORS.length],
      values,
    };
  });

  return { buckets, bucketMs, first, last, max, series, exhausted };
}

function statusBadge(latest: AccountRow["latest"]): ReactNode {
  if (!latest) return <span className="dim">{ti("settingsPage.stats.providers.statusNoReading")}</span>;
  if (latest.exhausted) return <Badge tone="bad">{ti("settingsPage.stats.providers.statusExhausted")}</Badge>;
  if (latest.fraction >= 0.8) return <Badge tone="warn">{ti("settingsPage.stats.providers.statusHigh")}</Badge>;
  return <Badge tone="ok">{ti("settingsPage.stats.providers.statusOk")}</Badge>;
}
