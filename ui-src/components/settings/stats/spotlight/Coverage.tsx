/**
 * Which tools' output the experiment sessions' models saw shaped and unshaped:
 * the unshaped share is where shaping could reach next.
 */
import { useTranslation } from "react-i18next";
import { Legend, ShareBar } from "../charts";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightCoverageRow, SpotlightDashboardStats } from "../types";
import { Badge, Card, type Column, EmptyState, Table } from "../ui";
import { formatShare, toolIcon } from "./meta";

const SHAPED_COLOR = "var(--green)";
const UNSHAPED_COLOR = "var(--orange)";

/** A journal's share, zeroed when missing so the summary bar never divides by NaN. */
function shareOf(row: SpotlightCoverageRow): number {
  return Number.isFinite(row.share) ? row.share : 0;
}

export function Coverage({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
  const { t } = useTranslation();

  const rows = [...stats.coverage].sort(
    (a, b) => (Number.isFinite(b.tokens) ? b.tokens : 0) - (Number.isFinite(a.tokens) ? a.tokens : 0),
  );
  let shaped = 0;
  let unshaped = 0;
  for (const row of rows) {
    if (row.shaped) shaped += shareOf(row);
    else unshaped += shareOf(row);
  }

  const columns: Column<SpotlightCoverageRow>[] = [
    {
      key: "tool",
      header: t("settingsPage.stats.spotlight.coverage.colTool"),
      sort: row => row.tool,
      render: row => {
        const Icon = toolIcon(row.tool);
        return (
          <span className="row">
            <Icon size={13} aria-hidden="true" />
            {row.tool}
            {row.shaped && <Badge tone="ok">{t("settingsPage.stats.spotlight.coverage.shaped")}</Badge>}
          </span>
        );
      },
    },
    {
      key: "calls",
      header: t("settingsPage.stats.spotlight.coverage.colCalls"),
      align: "right",
      sort: row => row.calls,
      render: row => <span className="stats-num">{formatInteger(row.calls)}</span>,
    },
    {
      key: "tokens",
      header: t("settingsPage.stats.spotlight.coverage.colTokens"),
      align: "right",
      sort: row => row.tokens,
      render: row => (
        <span className="stats-num" title={formatInteger(row.tokens)}>
          {formatCompact(row.tokens)}
        </span>
      ),
    },
    {
      key: "share",
      header: t("settingsPage.stats.spotlight.coverage.colShare"),
      align: "right",
      sort: shareOf,
      render: row => <span className="stats-num">{formatShare(shareOf(row))}</span>,
    },
  ];

  return (
    <Card
      title={t("settingsPage.stats.spotlight.coverage.title")}
      description={t("settingsPage.stats.spotlight.coverage.description")}
      actions={
        <Legend
          items={[
            { key: "shaped", label: t("settingsPage.stats.spotlight.coverage.shaped"), color: SHAPED_COLOR },
            { key: "unshaped", label: t("settingsPage.stats.spotlight.coverage.unshaped"), color: UNSHAPED_COLOR },
          ]}
        />
      }
      footer={<span>{t("settingsPage.stats.spotlight.coverage.footer")}</span>}
      stale={stale}
    >
      {rows.length === 0 ? (
        <EmptyState title={t("settingsPage.stats.spotlight.coverage.empty")} />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="micro muted">
              {t("settingsPage.stats.spotlight.coverage.summary", { share: formatShare(unshaped) })}
            </div>
            <ShareBar
              height={8}
              segments={[
                {
                  key: "shaped",
                  label: t("settingsPage.stats.spotlight.coverage.shaped"),
                  value: shaped,
                  color: SHAPED_COLOR,
                },
                {
                  key: "unshaped",
                  label: t("settingsPage.stats.spotlight.coverage.unshaped"),
                  value: unshaped,
                  color: UNSHAPED_COLOR,
                },
              ]}
            />
          </div>
          <Table
            rows={rows}
            rowKey={row => row.tool}
            columns={columns}
            initialSort={{ key: "tokens", dir: "desc" }}
            limit={8}
            dense
          />
        </div>
      )}
    </Card>
  );
}
