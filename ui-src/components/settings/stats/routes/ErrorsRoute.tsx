import { ArrowUpRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { getRecentErrors } from "../api";
import { BarList } from "../charts";
import { modelKey } from "../data/colors";
import {
  formatCompact,
  formatFolder,
  formatInteger,
  formatMessageCost,
  formatRelativeTime,
  formatTimestamp,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { type ErrorGroupView, errorSignature, groupErrorsBySignature } from "../data/view-models";
import type { MessageStats, TimeRange } from "../types";
import {
  Card,
  type Column,
  EmptyState,
  LabelCell,
  MeterCell,
  PageHeader,
  QueryView,
  SearchInput,
  Skeleton,
  Stat,
  StatGrid,
  Table,
  TableSkeleton,
} from "../ui";

export interface ErrorsRouteProps {
  active: boolean;
  range: TimeRange;
  onRequestClick: (id: number) => void;
}

const LOAD_STEPS = [50, 200, 1_000] as const;

export function ErrorsRoute({ active, range, onRequestClick }: ErrorsRouteProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const limit = LOAD_STEPS[step];
  const errors = useQuery(["errors", range, limit], () => getRecentErrors(range, limit), { enabled: active });
  const [selectedSignature, setSelectedSignature] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const meta = rangeMeta(range);

  const view = useMemo(() => {
    const rows = (errors.data ?? []).map(row => ({ row, signature: errorSignature(row.errorMessage) }));
    const groups = groupErrorsBySignature(errors.data ?? []);
    const byModel = new Map<string, { model: string; provider: string; count: number }>();
    for (const { row } of rows) {
      const key = modelKey(row.model, row.provider);
      const entry = byModel.get(key);
      if (entry) entry.count++;
      else byModel.set(key, { model: row.model, provider: row.provider, count: 1 });
    }
    const models = [...byModel.entries()]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
    const newest = rows.reduce<MessageStats | null>(
      (best, { row }) => (!best || row.timestamp > best.timestamp ? row : best),
      null,
    );
    return { rows, groups, models, newest };
  }, [errors.data]);

  const signature = view.groups.some(g => g.signature === selectedSignature) ? selectedSignature : null;
  const model = view.models.some(m => m.key === selectedModel) ? selectedModel : null;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return view.rows
      .filter(
        entry =>
          (signature === null || entry.signature === signature) &&
          (model === null || modelKey(entry.row.model, entry.row.provider) === model) &&
          (needle === "" ||
            entry.row.model.toLowerCase().includes(needle) ||
            entry.row.provider.toLowerCase().includes(needle) ||
            entry.row.folder.toLowerCase().includes(needle) ||
            (entry.row.errorMessage ?? "").toLowerCase().includes(needle)),
      )
      .map(entry => entry.row);
  }, [view.rows, signature, model, search]);

  const loaded = errors.data?.length ?? 0;
  const complete = !errors.stale && loaded < limit;
  const nextStep = step + 1 < LOAD_STEPS.length ? LOAD_STEPS[step + 1] : null;
  const footer =
    errors.data !== null && !complete ? (
      <>
        <span>
          {t("settingsPage.stats.errors.footerShowing", {
            loaded: formatInteger(loaded),
            window: meta.windowLabel,
          })}
        </span>
        {nextStep !== null && (
          <button
            type="button"
            className="btn"
            data-size="sm"
            disabled={errors.refreshing}
            onClick={() => setStep(step + 1)}
          >
            {errors.refreshing && errors.stale
              ? t("settingsPage.stats.errors.loadMoreLoading")
              : t("settingsPage.stats.errors.loadMore", { count: formatInteger(nextStep) })}
          </button>
        )}
      </>
    ) : undefined;

  const maxGroup = view.groups[0]?.count ?? 0;
  const groupColumns = useMemo(() => buildGroupColumns(t, maxGroup), [t, maxGroup]);
  const failureColumns = useMemo(() => buildFailureColumns(t), [t]);
  const selectedModelInfo = view.models.find(m => m.key === model);

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.errors.pageTitle")}
        description={t("settingsPage.stats.errors.pageDescription", { window: meta.windowLabel })}
      />

      <QueryView query={errors} skeleton={<Skeleton height={96} style={{ borderRadius: 12 }} />}>
        {() => (
          <div data-stale={errors.stale}>
            <StatGrid min={170}>
              <Stat
                label={t("settingsPage.stats.errors.stat.failures")}
                value={formatInteger(loaded)}
                hint={
                  complete
                    ? t("settingsPage.stats.errors.stat.failuresHint.all", { window: meta.windowLabel })
                    : t("settingsPage.stats.errors.stat.failuresHint.partial", {
                        loaded: formatInteger(loaded),
                      })
                }
              />
              <Stat
                label={t("settingsPage.stats.errors.stat.signatures")}
                title={t("settingsPage.stats.errors.stat.signaturesTitle")}
                value={formatInteger(view.groups.length)}
                hint={
                  view.groups[0]
                    ? t("settingsPage.stats.errors.stat.signaturesHint", {
                        count: formatInteger(view.groups[0].count),
                      })
                    : undefined
                }
              />
              <Stat
                label={t("settingsPage.stats.errors.stat.affectedModels")}
                value={formatInteger(view.models.length)}
                hint={view.models[0]?.model}
              />
              <Stat
                label={t("settingsPage.stats.errors.stat.lastFailure")}
                value={view.newest ? formatRelativeTime(view.newest.timestamp) : "–"}
                hint={
                  view.newest
                    ? formatTimestamp(view.newest.timestamp)
                    : t("settingsPage.stats.errors.stat.lastFailureNone", { window: meta.windowLabel })
                }
              />
            </StatGrid>
          </div>
        )}
      </QueryView>

      <div className="grid grid-main-side">
        <Card
          index={1}
          title={t("settingsPage.stats.errors.signaturesCardTitle")}
          description={t("settingsPage.stats.errors.signaturesCardDesc")}
          flush
          stale={errors.stale}
        >
          <QueryView
            query={errors}
            skeleton={<TableSkeleton rows={8} />}
            isEmpty={rows => rows.length === 0}
            empty={
              <EmptyState
                title={t("settingsPage.stats.errors.empty.noFailures", { window: meta.windowLabel })}
                hint={t("settingsPage.stats.errors.empty.noFailuresHint")}
              />
            }
          >
            {() => (
              <Table
                rows={view.groups}
                rowKey={group => group.signature}
                columns={groupColumns}
                onRowClick={group =>
                  setSelectedSignature(signature === group.signature ? null : group.signature)
                }
                selectedKey={signature}
                expanded={group =>
                  group.signature === signature ? (
                    <SignatureDetail group={group} onRequestClick={onRequestClick} />
                  ) : null
                }
                limit={12}
              />
            )}
          </QueryView>
        </Card>

        <Card
          index={2}
          title={t("settingsPage.stats.errors.byModelCardTitle")}
          description={t("settingsPage.stats.errors.byModelCardDesc")}
          stale={errors.stale}
        >
          <QueryView
            query={errors}
            skeleton={<Skeleton height={180} />}
            isEmpty={rows => rows.length === 0}
            empty={<EmptyState title={t("settingsPage.stats.errors.empty.noModels")} />}
          >
            {() => (
              <BarList
                items={view.models.slice(0, 12).map(m => ({
                  key: m.key,
                  label: (
                    <span className="row" style={{ gap: 6, minWidth: 0 }}>
                      <span className="mono truncate">{m.model}</span>
                      <span className="dim truncate">{m.provider}</span>
                    </span>
                  ),
                  value: m.count,
                  color: m.key === model ? "var(--bad)" : "color-mix(in srgb, var(--bad) 45%, transparent)",
                }))}
                onSelect={key => setSelectedModel(model === key ? null : key)}
              />
            )}
          </QueryView>
        </Card>
      </div>

      <Card
        index={3}
        title={t("settingsPage.stats.errors.failuresCardTitle")}
        description={
          errors.data === null
            ? t("settingsPage.stats.errors.failuresCardDesc.loading")
            : t("settingsPage.stats.errors.failuresCardDesc.count", {
                filtered: formatInteger(filtered.length),
                loaded: formatInteger(loaded),
              })
        }
        actions={
          <>
            {signature !== null && (
              <button
                type="button"
                className="btn errors-filter"
                data-size="sm"
                onClick={() => setSelectedSignature(null)}
                title={signature}
              >
                <span className="mono truncate">{signature}</span>
                <X size={12} />
              </button>
            )}
            {selectedModelInfo && (
              <button
                type="button"
                className="btn errors-filter"
                data-size="sm"
                onClick={() => setSelectedModel(null)}
              >
                <span className="mono truncate">{selectedModelInfo.model}</span>
                <X size={12} />
              </button>
            )}
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("settingsPage.stats.errors.searchPlaceholder")}
            />
          </>
        }
        flush
        stale={errors.stale}
        footer={footer}
      >
        <QueryView
          query={errors}
          skeleton={<TableSkeleton rows={10} />}
          isEmpty={rows => rows.length === 0}
          empty={
            <EmptyState title={t("settingsPage.stats.errors.empty.noFailures", { window: meta.windowLabel })} />
          }
        >
          {() => (
            <Table
              rows={filtered}
              rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
              onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
              columns={failureColumns}
              initialSort={{ key: "time", dir: "desc" }}
              limit={50}
              dense
              empty={
                <EmptyState
                  title={t("settingsPage.stats.errors.empty.noMatch")}
                  hint={t("settingsPage.stats.errors.empty.noMatchHint")}
                />
              }
            />
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function buildGroupColumns(t: TFunction, maxCount: number): Column<ErrorGroupView>[] {
  return [
    {
      key: "signature",
      header: t("settingsPage.stats.errors.groupColumns.signature"),
      wrap: true,
      sort: group => group.signature,
      render: group => (
        <span className="errors-signature" title={group.latest.errorMessage ?? undefined}>
          {group.signature}
        </span>
      ),
    },
    {
      key: "models",
      header: t("settingsPage.stats.errors.groupColumns.models"),
      sort: group => group.models.length,
      render: group => (
        <LabelCell
          primary={<span className="mono">{group.models[0]?.model}</span>}
          secondary={
            group.models.length > 1
              ? t("settingsPage.stats.errors.moreModels", { count: formatInteger(group.models.length - 1) })
              : group.models[0]?.provider
          }
        />
      ),
    },
    {
      key: "last",
      header: t("settingsPage.stats.errors.groupColumns.lastSeen"),
      sort: group => group.lastSeen,
      render: group => (
        <span className="muted" title={formatTimestamp(group.lastSeen)}>
          {formatRelativeTime(group.lastSeen)}
        </span>
      ),
    },
    {
      key: "count",
      header: t("settingsPage.stats.errors.groupColumns.failures"),
      align: "right",
      width: 120,
      sort: group => group.count,
      render: group => (
        <MeterCell value={group.count} max={maxCount} display={formatInteger(group.count)} color="var(--bad)" />
      ),
    },
  ];
}

function SignatureDetail({ group, onRequestClick }: { group: ErrorGroupView; onRequestClick: (id: number) => void }) {
  const { t } = useTranslation();
  const latestId = group.latest.id;
  return (
    <div className="errors-detail">
      <pre className="code-block errors-detail-message">
        {group.latest.errorMessage ?? t("settingsPage.stats.errors.unknownError")}
      </pre>
      <div className="errors-detail-meta">
        <span className="muted">
          {t("settingsPage.stats.errors.detailMeta", {
            count: formatInteger(group.count),
            first: formatTimestamp(group.firstSeen),
            last: formatTimestamp(group.lastSeen),
          })}
        </span>
        {latestId !== undefined && (
          <button type="button" className="btn" data-size="sm" onClick={() => onRequestClick(latestId)}>
            {t("settingsPage.stats.errors.openLatest")} <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      <div className="errors-detail-models">
        {group.models.map(m => (
          <span key={modelKey(m.model, m.provider)} className="badge" data-mono="true">
            {m.model} <span className="dim">{m.provider}</span>{" "}
            <span className="num">{formatCompact(m.count)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function buildFailureColumns(t: TFunction): readonly Column<MessageStats>[] {
  return [
    {
      key: "time",
      header: t("settingsPage.stats.errors.columns.when"),
      width: 120,
      sort: row => row.timestamp,
      render: row => (
        <span className="muted" title={formatTimestamp(row.timestamp)}>
          {formatRelativeTime(row.timestamp)}
        </span>
      ),
    },
    {
      key: "model",
      header: t("settingsPage.stats.errors.columns.model"),
      sort: row => row.model,
      render: row => <LabelCell primary={<span className="mono">{row.model}</span>} secondary={row.provider} />,
    },
    {
      key: "error",
      header: t("settingsPage.stats.errors.columns.error"),
      sort: row => row.errorMessage ?? "",
      render: row => (
        <span className="errors-message" title={row.errorMessage ?? undefined}>
          {row.errorMessage ?? t("settingsPage.stats.errors.unknownError")}
        </span>
      ),
    },
    {
      key: "project",
      header: t("settingsPage.stats.errors.columns.project"),
      sort: row => row.folder,
      render: row => (
        <span className="mono muted" title={row.folder}>
          {formatFolder(row.folder)}
        </span>
      ),
    },
    {
      key: "tokens",
      header: t("settingsPage.stats.errors.columns.tokens"),
      align: "right",
      sort: row => row.usage.totalTokens,
      render: row => <span className="num">{formatInteger(row.usage.totalTokens)}</span>,
    },
    {
      key: "cost",
      header: t("settingsPage.stats.errors.columns.cost"),
      title: t("settingsPage.stats.errors.columns.costTitle"),
      align: "right",
      sort: row => row.usage.cost.total,
      render: row => <span className="num">{formatMessageCost(row, 4)}</span>,
    },
  ];
}
