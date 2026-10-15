import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getGainDashboardStats } from "../api";
import { Chart, type ChartSeries, Legend } from "../charts";
import { formatBytes, formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import type { GainSource, GainSourceTotals, TimeRange } from "../types";
import {
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  MeterCell,
  PageHeader,
  QueryView,
  Stat,
  StatGrid,
  Table,
} from "../ui";

export interface GainRouteProps {
  active: boolean;
  range: TimeRange;
}

const DAY_MS = 86_400_000;

const SOURCE_LABEL: Record<GainSource, string> = { snapcompact: "Snapcompact" };

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

interface SourceRow extends GainSourceTotals {
  source: GainSource;
  share: number;
}

export function GainRoute({ active, range }: GainRouteProps) {
  const { t } = useTranslation();
  const [project, setProject] = useState<string | null>(null);
  const gain = useQuery(["gain", range, project], () => getGainDashboardStats(range, project), { enabled: active });
  const meta = rangeMeta(range);
  const data = gain.data;

  const series = useMemo(() => {
    const points = (data?.timeSeries ?? []).map(p => ({ ...p, timestamp: Date.parse(`${p.date}T00:00:00Z`) }));
    const buckets = bucketAxis(
      range,
      points.map(p => p.timestamp),
      DAY_MS,
    );
    const daily = densify(points, buckets, p => p.snapcompact);
    let running = 0;
    const cumulative = daily.map(v => (running += v));
    return { buckets, daily, cumulative };
  }, [data, range]);

  const sourceRows = useMemo((): SourceRow[] => {
    if (!data) return [];
    const total = data.overall.savedTokens;
    return (Object.keys(data.bySource) as GainSource[]).map(source => ({
      ...data.bySource[source],
      source,
      share: total > 0 ? data.bySource[source].savedTokens / total : 0,
    }));
  }, [data]);

  const projects = data?.projects ?? [];
  const projectOptions = project !== null && !projects.includes(project) ? [project, ...projects] : projects;
  const scope = project ? t("settingsPage.stats.gain.scopeFor", { project }) : "";

  const sourceColumns = useMemo<Column<SourceRow>[]>(
    () => [
      {
        key: "source",
        header: t("settingsPage.stats.gain.colSource"),
        sort: row => row.source,
        render: row => <span className="cell-primary">{SOURCE_LABEL[row.source]}</span>,
      },
      {
        key: "tokens",
        header: t("settingsPage.stats.gain.colSavedTokens"),
        align: "right",
        sort: row => row.savedTokens,
        render: row => (
          <span title={formatInteger(row.savedTokens)}>
            <MeterCell value={row.share} max={1} display={formatCompact(row.savedTokens)} />
          </span>
        ),
      },
      {
        key: "share",
        header: t("settingsPage.stats.gain.colShare"),
        align: "right",
        sort: row => row.share,
        render: row => <span className="num muted">{formatPercent(row.share)}</span>,
      },
      {
        key: "bytes",
        header: t("settingsPage.stats.gain.colSavedBytes"),
        align: "right",
        sort: row => row.savedBytes,
        render: row => <span className="num">{formatBytes(row.savedBytes)}</span>,
      },
      {
        key: "hits",
        header: t("settingsPage.stats.gain.colHits"),
        align: "right",
        sort: row => row.hits,
        render: row => <span className="num">{formatInteger(row.hits)}</span>,
      },
      {
        key: "reduction",
        header: t("settingsPage.stats.gain.colReduction"),
        align: "right",
        sort: row => row.reductionPercent ?? -1,
        render: row => (
          <span className="num">{row.reductionPercent !== null ? formatPercent(row.reductionPercent) : "–"}</span>
        ),
      },
    ],
    [t],
  );

  const chartSeries: ChartSeries[] = [
    { key: "daily", label: t("settingsPage.stats.gain.seriesDaily"), color: "var(--chart-primary)", values: series.daily },
    {
      key: "cumulative",
      label: t("settingsPage.stats.gain.seriesCumulative"),
      color: "var(--chart-secondary)",
      values: series.cumulative,
      kind: "line",
      axis: "right",
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.gain.pageTitle")}
        description={t("settingsPage.stats.gain.pageDescription", { scope, window: meta.windowLabel })}
        actions={
          projectOptions.length > 0 && (
            <select
              className="input"
              aria-label={t("settingsPage.stats.gain.projectLabel")}
              value={project ?? ""}
              onChange={e => setProject(e.target.value || null)}
              style={{ maxWidth: 320 }}
            >
              <option value="">{t("settingsPage.stats.gain.allProjects")}</option>
              {projectOptions.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )
        }
      />

      <QueryView
        query={gain}
        skeleton={<ChartSkeleton height={96} />}
        isEmpty={stats => stats.overall.hits === 0 && stats.timeSeries.length === 0}
        empty={
          <Card>
            <EmptyState
              title={t("settingsPage.stats.gain.emptyNoSavings", { scope, window: meta.windowLabel })}
              hint={
                range === "all"
                  ? t("settingsPage.stats.gain.emptyHintAll")
                  : t("settingsPage.stats.gain.emptyHintRange")
              }
            />
          </Card>
        }
      >
        {({ overall }) => (
          <>
            <div data-stale={gain.stale}>
              <StatGrid min={180}>
                <Stat
                  label={t("settingsPage.stats.gain.statSavedTokens")}
                  value={formatCompact(overall.savedTokens)}
                  hint={formatInteger(overall.savedTokens)}
                  spark={series.daily}
                />
                <Stat label={t("settingsPage.stats.gain.statSavedBytes")} value={formatBytes(overall.savedBytes)} />
                <Stat
                  label={t("settingsPage.stats.gain.statReduction")}
                  title={t("settingsPage.stats.gain.statReductionTitle")}
                  value={overall.reductionPercent !== null ? formatPercent(overall.reductionPercent) : "–"}
                  hint={
                    overall.reductionPercent === null ? t("settingsPage.stats.gain.originalNotRecorded") : undefined
                  }
                />
                <Stat label={t("settingsPage.stats.gain.statHits")} value={formatInteger(overall.hits)} />
                <Stat
                  label={t("settingsPage.stats.gain.statSavedPerHit")}
                  value={overall.hits > 0 ? formatCompact(overall.savedTokens / overall.hits) : "–"}
                  hint={t("settingsPage.stats.gain.tokensUnit")}
                />
              </StatGrid>
            </div>

            <Card
              index={1}
              title={t("settingsPage.stats.gain.chartTitle")}
              description={t("settingsPage.stats.gain.chartDescription")}
              actions={<Legend items={chartSeries.map(s => ({ key: s.key, label: s.label, color: s.color }))} />}
              stale={gain.stale}
            >
              <Chart
                slots={series.buckets.length}
                tickLabel={i => DAY_LABEL.format(series.buckets[i])}
                series={chartSeries}
                height={260}
                formatTooltip={formatInteger}
                formatRight={formatCompact}
              />
            </Card>

            <Card
              index={2}
              title={t("settingsPage.stats.gain.bySourceTitle")}
              description={t("settingsPage.stats.gain.bySourceDescription")}
              flush
              stale={gain.stale}
            >
              <Table rows={sourceRows} rowKey={row => row.source} columns={sourceColumns} />
            </Card>
          </>
        )}
      </QueryView>
    </div>
  );
}
