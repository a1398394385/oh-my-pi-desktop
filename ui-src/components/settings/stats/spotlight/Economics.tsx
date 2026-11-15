/**
 * What cut results earn per tool once fetch-backs, extra turns and Spotlight's
 * own bill are charged: the cautious per-100-cuts view, plus the bill itself
 * against the holdout-adjusted net.
 */
import { useTranslation } from "react-i18next";
import { BarList } from "../charts";
import { formatCompact, formatCost, formatInteger } from "../data/formatters";
import type { SpotlightCutEconomics, SpotlightDashboardStats } from "../types";
import { Card, type Column, EmptyState, Stat, StatGrid, Table } from "../ui";
import { foldTools, formatSignedCost, OTHER_TOOLS, toolIcon, toolsBySaving } from "./meta";

/** The folded tools' cells summed into one `other` cell. */
function otherCell(cells: readonly SpotlightCutEconomics[]): SpotlightCutEconomics | undefined {
  if (cells.length === 0) return undefined;
  const sum: SpotlightCutEconomics = {
    tool: OTHER_TOOLS,
    cuts: 0,
    savedTokens: 0,
    recoveredTokens: 0,
    extraTurns: 0,
    savedUsd: 0,
    recoveryUsd: 0,
    turnUsd: 0,
    netUsd: 0,
    extraTurnsPer100Cuts: 0,
    netUsdPer100Cuts: 0,
  };
  for (const cell of cells) {
    sum.cuts += cell.cuts;
    sum.savedTokens += cell.savedTokens;
    sum.recoveredTokens += cell.recoveredTokens;
    sum.extraTurns += cell.extraTurns;
    sum.savedUsd += cell.savedUsd;
    sum.recoveryUsd += cell.recoveryUsd;
    sum.turnUsd += cell.turnUsd;
    sum.netUsd += cell.netUsd;
  }
  if (sum.cuts > 0) {
    sum.extraTurnsPer100Cuts = (sum.extraTurns * 100) / sum.cuts;
    sum.netUsdPer100Cuts = (sum.netUsd * 100) / sum.cuts;
  }
  return sum;
}

/** A signed per-cut net, zeroed when a journal carries no finite value. */
function netOf(cell: SpotlightCutEconomics): number {
  return Number.isFinite(cell.netUsdPer100Cuts) ? cell.netUsdPer100Cuts : 0;
}

export function Economics({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
  const { t } = useTranslation();

  const cutTools = new Set(stats.economics.filter(cell => cell.cuts > 0).map(cell => cell.tool));
  const groups = toolsBySaving(stats).filter(tool => cutTools.has(tool));
  const { listed, rest } = foldTools(groups);
  const folded = new Set(rest);
  const cells = new Map<string, SpotlightCutEconomics>(
    stats.economics
      .filter(cell => !folded.has(cell.tool))
      .map((cell): [string, SpotlightCutEconomics] => [cell.tool, cell]),
  );
  const other = otherCell(stats.economics.filter(cell => folded.has(cell.tool)));
  if (other !== undefined) cells.set(OTHER_TOOLS, other);
  const rows = (rest.length > 0 ? [...listed, OTHER_TOOLS] : listed).flatMap(tool => {
    const cell = cells.get(tool);
    return cell === undefined ? [] : [cell];
  });

  const netUsd = stats.adjusted.netUsd.value;
  const toolName = (tool: string) =>
    tool === OTHER_TOOLS ? t("settingsPage.stats.spotlight.meta.other") : tool;

  const barItems = rows.map(cell => {
    const net = netOf(cell);
    const Icon = toolIcon(cell.tool);
    return {
      key: cell.tool,
      label: (
        <span className="row">
          <Icon size={13} aria-hidden="true" />
          {toolName(cell.tool)}
        </span>
      ),
      value: Math.abs(net),
      display: formatSignedCost(net),
      color: net > 0 ? "var(--green)" : net < 0 ? "var(--err)" : "var(--faint)",
    };
  });

  const columns: Column<SpotlightCutEconomics>[] = [
    {
      key: "tool",
      header: t("settingsPage.stats.spotlight.economics.colTool"),
      render: cell => {
        const Icon = toolIcon(cell.tool);
        return (
          <span className="row">
            <Icon size={13} aria-hidden="true" />
            {toolName(cell.tool)}
          </span>
        );
      },
    },
    {
      key: "cuts",
      header: t("settingsPage.stats.spotlight.economics.colCuts"),
      align: "right",
      sort: cell => cell.cuts,
      render: cell => <span className="stats-num">{formatInteger(cell.cuts)}</span>,
    },
    {
      key: "saved",
      header: t("settingsPage.stats.spotlight.economics.colSaved"),
      align: "right",
      sort: cell => cell.savedTokens,
      render: cell => (
        <span className="stats-num" title={formatInteger(cell.savedTokens)}>
          {formatCompact(cell.savedTokens)}
        </span>
      ),
    },
    {
      key: "recovered",
      header: t("settingsPage.stats.spotlight.economics.colRecovered"),
      align: "right",
      sort: cell => cell.recoveredTokens,
      render: cell => (
        <span className="stats-num" title={formatInteger(cell.recoveredTokens)}>
          {formatCompact(cell.recoveredTokens)}
        </span>
      ),
    },
    {
      key: "turns",
      header: t("settingsPage.stats.spotlight.economics.colExtraTurns"),
      align: "right",
      sort: cell => cell.extraTurnsPer100Cuts,
      render: cell => (
        <span className="stats-num">
          {Number.isFinite(cell.extraTurnsPer100Cuts) ? cell.extraTurnsPer100Cuts.toFixed(1) : "–"}
        </span>
      ),
    },
    {
      key: "net100",
      header: t("settingsPage.stats.spotlight.economics.colNetPerHundred"),
      align: "right",
      sort: netOf,
      render: cell => {
        const net = netOf(cell);
        return (
          <span className={net > 0 ? "stats-num tone-ok" : net < 0 ? "stats-num tone-bad" : "stats-num"}>
            {formatSignedCost(net)}
          </span>
        );
      },
    },
    {
      key: "net",
      header: t("settingsPage.stats.spotlight.economics.colNet"),
      align: "right",
      sort: cell => cell.netUsd,
      render: cell => (
        <span className="stats-num">
          {Number.isFinite(cell.netUsd) ? formatSignedCost(cell.netUsd) : "–"}
        </span>
      ),
    },
  ];

  return (
    <Card
      title={t("settingsPage.stats.spotlight.economics.title")}
      description={t("settingsPage.stats.spotlight.economics.description")}
      footer={<span>{t("settingsPage.stats.spotlight.economics.footer")}</span>}
      stale={stale}
    >
      {rows.length === 0 ? (
        <EmptyState title={t("settingsPage.stats.spotlight.economics.empty")} />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <StatGrid min={150}>
            <Stat
              size="sm"
              label={t("settingsPage.stats.spotlight.economics.bill")}
              value={
                Number.isFinite(stats.overhead.spotlightUsd)
                  ? formatCost(stats.overhead.spotlightUsd)
                  : "–"
              }
            />
            <Stat
              size="sm"
              label={t("settingsPage.stats.spotlight.economics.net")}
              value={netUsd !== null && Number.isFinite(netUsd) ? formatSignedCost(netUsd) : "–"}
            />
          </StatGrid>
          <div>
            <div className="micro muted">{t("settingsPage.stats.spotlight.economics.perHundred")}</div>
            <BarList items={barItems} />
          </div>
          <Table
            rows={rows}
            rowKey={row => row.tool}
            columns={columns}
            initialSort={{ key: "net100", dir: "desc" }}
            dense
          />
        </div>
      )}
    </Card>
  );
}
