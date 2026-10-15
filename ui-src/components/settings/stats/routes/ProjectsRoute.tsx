import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { t as ti } from "../../../../i18n";
import { getFolderStats } from "../api";
import { BarList } from "../charts";
import {
  formatCompact,
  formatDurationMs,
  formatEstimatedCost,
  formatFolder,
  formatInteger,
  formatPercent,
  formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { buildFolderRows, type FolderRowView } from "../data/view-models";
import type { TimeRange } from "../types";
import {
  Badge,
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  errorRateTone,
  MeterCell,
  PageHeader,
  QueryView,
  SearchInput,
  Stat,
  StatGrid,
  Table,
  TableSkeleton,
} from "../ui";

export interface ProjectsRouteProps {
  active: boolean;
  range: TimeRange;
}

const TABLE_LIMIT = 100;
const TOP_LIMIT = 8;

export function ProjectsRoute({ active, range }: ProjectsRouteProps) {
  const { t } = useTranslation();
  const folders = useQuery(["projects", range], () => getFolderStats(range), { enabled: active });
  const [search, setSearch] = useState("");
  const [hideTemporary, setHideTemporary] = useState(true);
  const query = useDeferredValue(search.trim().toLowerCase());
  const meta = rangeMeta(range);

  const view = useMemo(() => buildFolderRows(folders.data ?? []), [folders.data]);
  const scoped = useMemo(
    () => (hideTemporary ? view.rows.filter(row => !row.temporary) : view.rows),
    [view, hideTemporary],
  );
  const matching = useMemo(
    () => (query ? scoped.filter(row => row.folder.toLowerCase().includes(query)) : scoped),
    [scoped, query],
  );
  const top = useMemo(
    () => ({
      cost: [...scoped].sort((a, b) => b.totalCost - a.totalCost).slice(0, TOP_LIMIT),
      requests: [...scoped].sort((a, b) => b.totalRequests - a.totalRequests).slice(0, TOP_LIMIT),
    }),
    [scoped],
  );
  const topEmpty = (
    <EmptyState
      title={
        view.rows.length === 0
          ? t("settingsPage.stats.projects.topEmptyNone")
          : t("settingsPage.stats.projects.topEmptyTemp")
      }
    />
  );
  const columns = useMemo(() => folderColumns(view.maxRequests, view.maxCost), [view]);

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.projects.title")}
        description={t("settingsPage.stats.projects.desc", { window: meta.windowLabel })}
      />

      <QueryView query={folders} skeleton={<ChartSkeleton height={96} />}>
        {() => (
          <div data-stale={folders.stale}>
            <StatGrid min={180}>
              <Stat
                label={t("settingsPage.stats.projects.statFolders")}
                value={formatInteger(view.rows.length)}
                hint={
                  view.temporaryCount > 0
                    ? t("settingsPage.stats.projects.statTempHint", { count: view.temporaryCount })
                    : undefined
                }
              />
              <Stat
                label={t("settingsPage.stats.projects.statRequests")}
                value={formatInteger(view.totalRequests)}
                hint={t("settingsPage.stats.projects.statFailedHint", { count: view.failedRequests })}
              />
              <Stat
                label={t("settingsPage.stats.projects.statCostLabel")}
                title={t("settingsPage.stats.projects.statCostTitle")}
                value={formatEstimatedCost(view.totalCost, view.unpricedRequests)}
                hint={
                  view.unpricedRequests > 0
                    ? t("settingsPage.stats.projects.statUnpricedHint", { count: view.unpricedRequests })
                    : undefined
                }
              />
              <Stat
                label={t("settingsPage.stats.projects.statTokensLabel")}
                title={t("settingsPage.stats.projects.statTokensTitle")}
                value={formatCompact(view.conversationTokens)}
              />
              <Stat
                label={t("settingsPage.stats.projects.statCacheLabel")}
                title={t("settingsPage.stats.projects.statCacheTitle")}
                value={formatPercent(view.cacheRate)}
              />
            </StatGrid>
          </div>
        )}
      </QueryView>

      <div className="grid grid-2">
        <Card
          index={1}
          title={t("settingsPage.stats.projects.topCostTitle")}
          description={t("settingsPage.stats.projects.topCostDesc")}
          stale={folders.stale}
        >
          <QueryView
            query={folders}
            skeleton={<ChartSkeleton height={236} />}
            isEmpty={() => top.cost.length === 0}
            empty={topEmpty}
          >
            {() => (
              <BarList
                items={top.cost.map(row => ({
                  key: row.folder,
                  label: <span className="mono">{formatFolder(row.folder)}</span>,
                  value: row.totalCost,
                  display: `${formatEstimatedCost(row.totalCost, row.unpricedRequests)} · ${formatPercent(row.costShare)}`,
                  color: "var(--chart-secondary)",
                }))}
                onSelect={setSearch}
              />
            )}
          </QueryView>
        </Card>
        <Card
          index={2}
          title={t("settingsPage.stats.projects.topRequestsTitle")}
          description={t("settingsPage.stats.projects.topRequestsDesc")}
          stale={folders.stale}
        >
          <QueryView
            query={folders}
            skeleton={<ChartSkeleton height={236} />}
            isEmpty={() => top.requests.length === 0}
            empty={topEmpty}
          >
            {() => (
              <BarList
                items={top.requests.map(row => ({
                  key: row.folder,
                  label: <span className="mono">{formatFolder(row.folder)}</span>,
                  value: row.totalRequests,
                  display: `${formatInteger(row.totalRequests)} · ${formatPercent(row.requestShare)}`,
                }))}
                onSelect={setSearch}
              />
            )}
          </QueryView>
        </Card>
      </div>

      <Card
        index={3}
        title={t("settingsPage.stats.projects.tableTitle")}
        description={
          folders.data
            ? matching.length === view.rows.length
              ? t("settingsPage.stats.projects.tableDescAll", { count: view.rows.length })
              : t("settingsPage.stats.projects.tableDescFiltered", {
                  shown: matching.length,
                  total: view.rows.length,
                })
            : undefined
        }
        actions={
          <>
            {view.temporaryCount > 0 && (
              <label
                className="check"
                title={t("settingsPage.stats.projects.hideTemporaryTitle")}
              >
                <input
                  type="checkbox"
                  checked={hideTemporary}
                  onChange={e => setHideTemporary(e.target.checked)}
                />
                {t("settingsPage.stats.projects.hideTemporary", { count: view.temporaryCount })}
              </label>
            )}
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("settingsPage.stats.projects.filterPlaceholder")}
              width={240}
            />
          </>
        }
        flush
        stale={folders.stale}
      >
        <QueryView query={folders} skeleton={<TableSkeleton rows={10} />}>
          {() => (
            <Table
              rows={matching}
              rowKey={row => row.folder}
              columns={columns}
              initialSort={{ key: "cost", dir: "desc" }}
              limit={TABLE_LIMIT}
              dense
              empty={
                <EmptyState
                  title={
                    view.rows.length === 0
                      ? t("settingsPage.stats.projects.topEmptyNone")
                      : t("settingsPage.stats.projects.tableEmptyNoMatch")
                  }
                  hint={
                    view.rows.length === 0
                      ? t("settingsPage.stats.projects.tableEmptyHintRange")
                      : hideTemporary && view.temporaryCount > 0
                        ? t("settingsPage.stats.projects.tableEmptyHintTemp")
                        : undefined
                  }
                />
              }
            />
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function folderColumns(maxRequests: number, maxCost: number): Column<FolderRowView>[] {
  return [
    {
      key: "folder",
      header: ti("settingsPage.stats.projects.colFolder"),
      sort: row => row.folder,
      render: row => (
        <span className="row projects-folder" title={row.folder || ti("settingsPage.stats.projects.rootFolder")}>
          <span className="mono truncate">{formatFolder(row.folder)}</span>
          {row.temporary && <Badge>{ti("settingsPage.stats.projects.badgeTemp")}</Badge>}
        </span>
      ),
    },
    {
      key: "requests",
      header: ti("settingsPage.stats.projects.colRequests"),
      align: "right",
      sort: row => row.totalRequests,
      render: row => (
        <span title={ti("settingsPage.stats.projects.colRequestsTitle", { share: formatPercent(row.requestShare) })}>
          <MeterCell value={row.totalRequests} max={maxRequests} display={formatInteger(row.totalRequests)} />
        </span>
      ),
    },
    {
      key: "cost",
      header: ti("settingsPage.stats.projects.colCost"),
      title: ti("settingsPage.stats.projects.colCostTitle"),
      align: "right",
      sort: row => row.totalCost,
      render: row => (
        <span title={ti("settingsPage.stats.projects.colCostShareTitle", { share: formatPercent(row.costShare) })}>
          <MeterCell
            value={row.totalCost}
            max={maxCost}
            display={formatEstimatedCost(row.totalCost, row.unpricedRequests)}
            color="var(--chart-secondary)"
          />
        </span>
      ),
    },
    {
      key: "tokens",
      header: ti("settingsPage.stats.projects.colTokens"),
      title: ti("settingsPage.stats.projects.colTokensTitle"),
      align: "right",
      sort: row => row.conversationTokens,
      render: row => (
        <span className="num" title={formatInteger(row.conversationTokens)}>
          {formatCompact(row.conversationTokens)}
        </span>
      ),
    },
    {
      key: "cacheRate",
      header: ti("settingsPage.stats.projects.colCacheRate"),
      title: ti("settingsPage.stats.projects.colCacheRateTitle"),
      align: "right",
      sort: row => row.cacheRate,
      render: row => <span className="num">{formatPercent(row.cacheRate)}</span>,
    },
    {
      key: "cacheSavings",
      header: ti("settingsPage.stats.projects.colCacheSavings"),
      title: ti("settingsPage.stats.projects.colCacheSavingsTitle"),
      align: "right",
      sort: row => row.cacheSavings,
      render: row => (
        <span className={`num ${row.cacheSavings < 0 ? "tone-bad" : "muted"}`}>
          {formatPercent(row.cacheSavings)}
        </span>
      ),
    },
    {
      key: "errorRate",
      header: ti("settingsPage.stats.projects.colErrors"),
      align: "right",
      sort: row => row.errorRate,
      render: row => (
        <span title={ti("settingsPage.stats.projects.colErrorsTitle", { count: row.failedRequests })}>
          <Badge tone={row.failedRequests > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
            {formatPercent(row.errorRate)}
          </Badge>
        </span>
      ),
    },
    {
      key: "duration",
      header: ti("settingsPage.stats.projects.colAvgDuration"),
      align: "right",
      sort: row => row.avgDuration ?? -1,
      render: row => <span className="num">{formatDurationMs(row.avgDuration)}</span>,
    },
    {
      key: "last",
      header: ti("settingsPage.stats.projects.colLastActive"),
      align: "right",
      sort: row => row.lastTimestamp,
      render: row => <span className="dim">{formatRelativeTime(row.lastTimestamp)}</span>,
    },
  ];
}
