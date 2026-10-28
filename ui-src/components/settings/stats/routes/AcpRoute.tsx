import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAcpCompactionStats } from "../api";
import { formatCompact, formatCost, formatInteger, formatTimestamp } from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import type { AcpCompactionRow, TimeRange } from "../types";
import { Card, type Column, EmptyState, PageHeader, QueryView, Table, TableSkeleton } from "../ui";

export interface AcpRouteProps {
  active: boolean;
  range: TimeRange;
}

/** Unknown instead of a fake zero: journals written before the runtime recorded the figure. */
const unknown = (value: number | null) => (value === null ? "–" : formatInteger(value));

export function AcpRoute({ active, range }: AcpRouteProps) {
  const { t } = useTranslation();
  const [model, setModel] = useState<string | null>(null);
  const acp = useQuery(["acp", range], ({ signal }) => getAcpCompactionStats(range, signal), { enabled: active });
  const meta = rangeMeta(range);
  const data = acp.data;

  const models = useMemo(() => [...new Set((data ?? []).map((row) => row.model))].sort(), [data]);
  const rows = useMemo(() => (model === null ? (data ?? []) : (data ?? []).filter((row) => row.model === model)), [data, model]);

  const columns = useMemo<Column<AcpCompactionRow>[]>(
    () => [
      {
        key: "createdAt",
        header: t("settingsPage.stats.acp.colTime"),
        sort: (row) => row.createdAt,
        render: (row) => <span className="cell-primary stats-num">{formatTimestamp(row.createdAt)}</span>,
      },
      {
        key: "model",
        header: t("settingsPage.stats.acp.colModel"),
        sort: (row) => row.model,
        render: (row) => <span className="cell-primary">{row.model}</span>,
      },
      {
        key: "compressed",
        header: t("settingsPage.stats.acp.colCompressed"),
        align: "right",
        sort: (row) => row.compressedTokens,
        render: (row) => (
          <span className="stats-num" title={formatInteger(row.compressedTokens)}>
            {formatCompact(row.compressedTokens)}
          </span>
        ),
      },
      {
        key: "activeAfter",
        header: t("settingsPage.stats.acp.colActiveAfter"),
        align: "right",
        sort: (row) => row.activeTokensAfter,
        render: (row) => (
          <span className="stats-num" title={formatInteger(row.activeTokensAfter)}>
            {formatCompact(row.activeTokensAfter)}
          </span>
        ),
      },
      {
        key: "summary",
        header: t("settingsPage.stats.acp.colSummary"),
        align: "right",
        sort: (row) => row.summaryTokens ?? -1,
        render: (row) => <span className="stats-num">{unknown(row.summaryTokens)}</span>,
      },
      {
        key: "status",
        header: t("settingsPage.stats.acp.colStatus"),
        align: "right",
        sort: (row) => row.statusTokens ?? -1,
        render: (row) => <span className="stats-num">{unknown(row.statusTokens)}</span>,
      },
      {
        key: "hints",
        header: t("settingsPage.stats.acp.colHints"),
        align: "right",
        sort: (row) => row.hints ?? -1,
        render: (row) => <span className="stats-num">{unknown(row.hints)}</span>,
      },
      {
        key: "extraTokens",
        header: t("settingsPage.stats.acp.colExtraTokens"),
        align: "right",
        sort: (row) => row.extraTokens,
        render: (row) => (
          <span className="stats-num" title={formatInteger(row.extraTokens)}>
            {formatCompact(row.extraTokens)}
          </span>
        ),
      },
      {
        key: "extraCost",
        header: t("settingsPage.stats.acp.colExtraCost"),
        align: "right",
        sort: (row) => row.extraCost,
        render: (row) => <span className="stats-num">{formatCost(row.extraCost)}</span>,
      },
      {
        key: "savedTokens",
        header: t("settingsPage.stats.acp.colSavedTokens"),
        align: "right",
        sort: (row) => row.savedTokens,
        render: (row) => (
          <span className="stats-num" title={t("settingsPage.stats.acp.savedTitle", { requests: row.requestsAfter })}>
            {formatCompact(row.savedTokens)}
          </span>
        ),
      },
      {
        key: "savedCost",
        header: t("settingsPage.stats.acp.colSavedCost"),
        align: "right",
        sort: (row) => row.savedCost,
        render: (row) => <span className="stats-num">{formatCost(row.savedCost)}</span>,
      },
    ],
    [t],
  );

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.acp.pageTitle")}
        description={t("settingsPage.stats.acp.pageDescription", { window: meta.windowLabel })}
        actions={
          models.length > 0 && (
            <select
              className="input"
              aria-label={t("settingsPage.stats.acp.modelLabel")}
              value={model ?? ""}
              onChange={(e) => setModel(e.target.value || null)}
              style={{ maxWidth: 320 }}
            >
              <option value="">{t("settingsPage.stats.acp.allModels")}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )
        }
      />

      <QueryView
        query={acp}
        skeleton={<TableSkeleton />}
        isEmpty={(list) => list.length === 0}
        empty={
          <Card>
            <EmptyState
              title={t("settingsPage.stats.acp.empty", { window: meta.windowLabel })}
              hint={range === "all" ? t("settingsPage.stats.acp.emptyHintAll") : t("settingsPage.stats.acp.emptyHintRange")}
            />
          </Card>
        }
      >
        {() => (
          <Card
            title={t("settingsPage.stats.acp.tableTitle")}
            description={t("settingsPage.stats.acp.tableDescription")}
            flush
            stale={acp.stale}
          >
            <Table rows={rows} rowKey={(row) => row.id} columns={columns} initialSort={{ key: "createdAt", dir: "desc" }} />
          </Card>
        )}
      </QueryView>
    </div>
  );
}
