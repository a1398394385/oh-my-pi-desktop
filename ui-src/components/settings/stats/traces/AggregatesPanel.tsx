import { useTranslation } from "react-i18next";
import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceToolStat } from "../types";
import { Badge, Card, type Column, MeterCell, Table } from "../ui";

export interface AggregatesPanelProps {
  toolStats: TraceToolStat[];
  index?: number;
}

export function AggregatesPanel({ toolStats, index }: AggregatesPanelProps) {
  const { t } = useTranslation();
  if (toolStats.length === 0) return null;
  const maxTotal = Math.max(...toolStats.map((stat) => stat.totalMs));
  const columns: Column<TraceToolStat>[] = [
    {
      key: "tool",
      header: t("settingsPage.stats.traceView.aggregates.colTool"),
      render: (row) => <span className="mono">{row.tool}</span>,
      sort: (row) => row.tool,
    },
    {
      key: "calls",
      header: t("settingsPage.stats.traceView.aggregates.colCalls"),
      align: "right",
      render: (row) => <span className="num">{formatInteger(row.calls)}</span>,
      sort: (row) => row.calls,
    },
    {
      key: "errors",
      header: t("settingsPage.stats.traceView.aggregates.colErrors"),
      align: "right",
      render: (row) =>
        row.errors > 0 ? (
          <Badge tone="bad">
            {t("settingsPage.stats.traceView.aggregates.failed", { count: row.errors })}
          </Badge>
        ) : (
          <span className="num dim">0</span>
        ),
      sort: (row) => row.errors,
    },
    {
      key: "total",
      header: t("settingsPage.stats.traceView.aggregates.colTotal"),
      align: "right",
      width: 200,
      render: (row) => (
        <MeterCell value={row.totalMs} max={maxTotal} display={formatDurationMs(row.totalMs)} color="var(--orange)" />
      ),
      sort: (row) => row.totalMs,
    },
    {
      key: "avg",
      header: t("settingsPage.stats.traceView.aggregates.colAvg"),
      align: "right",
      render: (row) => <span className="num">{formatDurationMs(row.calls > 0 ? row.totalMs / row.calls : 0)}</span>,
      sort: (row) => (row.calls > 0 ? row.totalMs / row.calls : 0),
    },
    {
      key: "max",
      header: t("settingsPage.stats.traceView.aggregates.colMax"),
      align: "right",
      render: (row) => <span className="num">{formatDurationMs(row.maxMs)}</span>,
      sort: (row) => row.maxMs,
    },
  ];
  return (
    <Card
      title={t("settingsPage.stats.traceView.aggregates.title")}
      description={t("settingsPage.stats.traceView.aggregates.toolCount", { count: toolStats.length })}
      flush
      index={index}
    >
      <Table columns={columns} rows={toolStats} rowKey={(row) => row.tool} dense limit={12} />
    </Card>
  );
}
