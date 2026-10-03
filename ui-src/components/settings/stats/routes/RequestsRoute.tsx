import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { getRecentRequests } from "../api";
import {
  formatCompact,
  formatDurationMs,
  formatEstimatedCost,
  formatFolder,
  formatInteger,
  formatMessageCost,
  formatPercent,
  formatRelativeTime,
  formatTimestamp,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { type RequestStatus, requestStatus, summarizeRequests } from "../data/view-models";
import { REQUEST_STATUS } from "../ui/RequestDrawer";
import type { MessageStats, TimeRange } from "../types";
import {
  Card,
  type Column,
  Dot,
  EmptyState,
  LabelCell,
  PageHeader,
  QueryView,
  SearchInput,
  Segmented,
  Skeleton,
  Stat,
  StatGrid,
  Table,
  TableSkeleton,
} from "../ui";

export interface RequestsRouteProps {
  active: boolean;
  range: TimeRange;
  onRequestClick: (id: number) => void;
}

const LOAD_STEPS = [500, 2_000, 10_000] as const;

type StatusFilter = "all" | RequestStatus;

export function RequestsRoute({ active, range, onRequestClick }: RequestsRouteProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const limit = LOAD_STEPS[step];
  const log = useQuery(["requests-log", limit], () => getRecentRequests(limit), { enabled: active });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const meta = rangeMeta(range);

  const view = useMemo(() => {
    const rows = log.data ?? [];
    const cutoff = meta.spanMs === null ? null : Date.now() - meta.spanMs;
    const inRange = cutoff === null ? rows : rows.filter(row => row.timestamp >= cutoff);
    const complete = !log.stale && (rows.length < limit || (cutoff !== null && inRange.length < rows.length));
    const counts: Record<StatusFilter, number> = { all: inRange.length, ok: 0, aborted: 0, failed: 0 };
    for (const row of inRange) counts[requestStatus(row)]++;
    return { loaded: rows.length, inRange, complete, counts, summary: summarizeRequests(inRange) };
  }, [log.data, log.stale, limit, meta.spanMs]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return view.inRange.filter(
      row =>
        (status === "all" || requestStatus(row) === status) &&
        (needle === "" ||
          row.model.toLowerCase().includes(needle) ||
          row.provider.toLowerCase().includes(needle) ||
          row.folder.toLowerCase().includes(needle)),
    );
  }, [view.inRange, search, status]);

  const { summary, counts, complete } = view;
  const nextStep = step + 1 < LOAD_STEPS.length ? LOAD_STEPS[step + 1] : null;
  const loadMore =
    nextStep !== null ? (
      <button
        type="button"
        className="btn"
        data-size="sm"
        disabled={log.refreshing}
        onClick={() => setStep(step + 1)}
      >
        {log.refreshing && log.stale
          ? t("settingsPage.stats.requests.loadMoreLoading")
          : t("settingsPage.stats.requests.loadMore", { count: formatInteger(nextStep) })}
      </button>
    ) : undefined;

  const statusOptions = (["all", "ok", "aborted", "failed"] as const).map(value => ({
    value,
    label: (
      <>
        {value === "all" ? t("settingsPage.stats.requests.filter.all") : REQUEST_STATUS[value].label}{" "}
        <span className="dim num">{formatCompact(counts[value])}</span>
      </>
    ),
  }));

  const requestColumns = useMemo(() => buildRequestColumns(t), [t]);

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.requests.pageTitle")}
        description={t("settingsPage.stats.requests.pageDescription", { window: meta.windowLabel })}
      />

      <QueryView query={log} skeleton={<Skeleton height={96} style={{ borderRadius: 12 }} />}>
        {() => (
          <div data-stale={log.stale}>
            <StatGrid min={160}>
              <Stat
                label={t("settingsPage.stats.requests.stat.requests")}
                value={formatInteger(summary.requests)}
                hint={
                  summary.oldest === null
                    ? t("settingsPage.stats.requests.stat.requestsHint.none", { window: meta.windowLabel })
                    : t("settingsPage.stats.requests.stat.requestsHint.since", {
                        time: formatRelativeTime(summary.oldest),
                      })
                }
              />
              <Stat
                label={t("settingsPage.stats.requests.stat.failed")}
                value={formatInteger(summary.failed)}
                hint={t("settingsPage.stats.requests.stat.failedHint", {
                  percent: summary.requests > 0 ? formatPercent(summary.failed / summary.requests) : "–",
                  count: formatInteger(summary.aborted),
                })}
              />
              <Stat
                label={t("settingsPage.stats.requests.stat.tokens")}
                title={t("settingsPage.stats.requests.stat.tokensTitle")}
                value={formatCompact(summary.tokens)}
              />
              <Stat
                label={t("settingsPage.stats.requests.stat.apiCost")}
                title={t("settingsPage.stats.requests.stat.apiCostTitle")}
                value={formatEstimatedCost(summary.cost, summary.unpriced)}
                hint={
                  summary.unpriced > 0
                    ? t("settingsPage.stats.requests.hint.unpriced", { count: formatInteger(summary.unpriced) })
                    : undefined
                }
              />
              <Stat
                label={t("settingsPage.stats.requests.stat.medianDuration")}
                value={formatDurationMs(summary.medianDuration)}
                hint={t("settingsPage.stats.requests.stat.medianDurationHint", {
                  value: formatDurationMs(summary.p95Duration),
                })}
              />
              <Stat
                label={t("settingsPage.stats.requests.stat.medianTtft")}
                title={t("settingsPage.stats.requests.stat.medianTtftTitle")}
                value={formatDurationMs(summary.medianTtft)}
              />
            </StatGrid>
          </div>
        )}
      </QueryView>

      <Card
        index={1}
        title={t("settingsPage.stats.requests.logCardTitle")}
        description={
          log.data === null
            ? t("settingsPage.stats.requests.logCardDesc.loading")
            : complete
              ? t("settingsPage.stats.requests.logCardDesc.complete", {
                  shown: formatInteger(filtered.length),
                  total: formatInteger(summary.requests),
                  window: meta.windowLabel,
                })
              : t("settingsPage.stats.requests.logCardDesc.partial", {
                  shown: formatInteger(filtered.length),
                  total: formatInteger(summary.requests),
                })
        }
        actions={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("settingsPage.stats.requests.searchPlaceholder")}
            />
            <Segmented
              size="sm"
              aria-label={t("settingsPage.stats.requests.statusFilter")}
              options={statusOptions}
              value={status}
              onChange={setStatus}
            />
          </>
        }
        flush
        stale={log.stale}
        footer={
          log.data !== null && !complete ? (
            <>
              <span>
                {t("settingsPage.stats.requests.footerShowing", {
                  loaded: formatInteger(view.loaded),
                  oldest: summary.oldest === null ? "–" : formatTimestamp(summary.oldest),
                  window: meta.windowLabel,
                })}
              </span>
              {loadMore}
            </>
          ) : undefined
        }
      >
        <QueryView query={log} skeleton={<TableSkeleton rows={12} />}>
          {() => (
            <Table
              rows={filtered}
              rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
              onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
              columns={requestColumns}
              initialSort={{ key: "time", dir: "desc" }}
              limit={100}
              dense
              empty={
                <EmptyState
                  title={
                    summary.requests === 0
                      ? t("settingsPage.stats.requests.empty.none", { window: meta.windowLabel })
                      : t("settingsPage.stats.requests.empty.noMatch")
                  }
                  hint={
                    summary.requests === 0
                      ? undefined
                      : t("settingsPage.stats.requests.empty.noMatchHint")
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

function buildRequestColumns(t: TFunction): readonly Column<MessageStats>[] {
  return [
    {
      key: "model",
      header: t("settingsPage.stats.requests.columns.model"),
      sort: row => row.model,
      render: row => <LabelCell primary={<span className="mono">{row.model}</span>} secondary={row.provider} />,
    },
    {
      key: "time",
      header: t("settingsPage.stats.requests.columns.when"),
      sort: row => row.timestamp,
      render: row => (
        <span className="muted" title={formatTimestamp(row.timestamp)}>
          {formatRelativeTime(row.timestamp)}
        </span>
      ),
    },
    {
      key: "project",
      header: t("settingsPage.stats.requests.columns.project"),
      sort: row => row.folder,
      render: row => (
        <span className="mono muted truncate" title={row.folder} style={{ display: "block", maxWidth: 180 }}>
          {formatFolder(row.folder)}
        </span>
      ),
    },
    {
      key: "input",
      header: t("settingsPage.stats.requests.columns.input"),
      title: t("settingsPage.stats.requests.columns.inputTitle"),
      align: "right",
      sort: row => row.usage.input,
      render: row => <span className="num">{formatCompact(row.usage.input)}</span>,
    },
    {
      key: "cache",
      header: t("settingsPage.stats.requests.columns.cacheRead"),
      title: t("settingsPage.stats.requests.columns.cacheReadTitle"),
      align: "right",
      sort: row => row.usage.cacheRead,
      render: row => (
        <span
          className="num"
          title={t("settingsPage.stats.requests.cacheWriteTooltip", {
            count: formatInteger(row.usage.cacheWrite),
          })}
        >
          {formatCompact(row.usage.cacheRead)}
        </span>
      ),
    },
    {
      key: "output",
      header: t("settingsPage.stats.requests.columns.output"),
      align: "right",
      sort: row => row.usage.output,
      render: row => <span className="num">{formatCompact(row.usage.output)}</span>,
    },
    {
      key: "cost",
      header: t("settingsPage.stats.requests.columns.cost"),
      title: t("settingsPage.stats.requests.columns.costTitle"),
      align: "right",
      sort: row => row.usage.cost.total,
      render: row => <span className="num">{formatMessageCost(row, 4)}</span>,
    },
    {
      key: "duration",
      header: t("settingsPage.stats.requests.columns.duration"),
      align: "right",
      sort: row => row.duration ?? -1,
      render: row => <span className="num">{formatDurationMs(row.duration)}</span>,
    },
    {
      key: "ttft",
      header: t("settingsPage.stats.requests.columns.ttft"),
      title: t("settingsPage.stats.requests.columns.ttftTitle"),
      align: "right",
      sort: row => row.ttft ?? -1,
      render: row => <span className="num muted">{formatDurationMs(row.ttft)}</span>,
    },
    {
      key: "status",
      header: t("settingsPage.stats.requests.columns.status"),
      sort: row => requestStatus(row),
      render: row => {
        const status = REQUEST_STATUS[requestStatus(row)];
        return (
          <span title={row.errorMessage ?? undefined}>
            <LabelCell
              lead={<Dot tone={status.tone} />}
              primary={status.label}
              secondary={<span className="mono">{row.stopReason}</span>}
            />
          </span>
        );
      },
    },
  ];
}
