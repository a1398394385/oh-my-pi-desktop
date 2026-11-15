/**
 * Ranking: whether Spotlight's heat and its cut keep the lines of a shaped read
 * that the agent came back for, read against the score-free cut and the
 * would-be cut held out whole.
 */
import { useTranslation } from "react-i18next";
import { BarList } from "../charts";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats, SpotlightEstimate, SpotlightRankingCell } from "../types";
import { Card, EmptyState, MeterCell, Stat, StatGrid, Table, type Column } from "../ui";
import { CUT_GROUP, formatInterval } from "./meta";

type RankingGroup = SpotlightRankingCell["group"];

/** Scored cuts first (the figure), then what they are read against. */
const GROUPS: readonly RankingGroup[] = ["applied", "scoreFree", "holdout"];

const GROUP_LABEL = {
  applied: "settingsPage.stats.spotlight.meta.cutGroup.applied.label",
  scoreFree: "settingsPage.stats.spotlight.meta.cutGroup.scoreFree.label",
  holdout: "settingsPage.stats.spotlight.meta.cutGroup.holdout.label",
} as const;

const GROUP_RULE = {
  applied: "settingsPage.stats.spotlight.meta.cutGroup.applied.rule",
  scoreFree: "settingsPage.stats.spotlight.meta.cutGroup.scoreFree.rule",
  holdout: "settingsPage.stats.spotlight.meta.cutGroup.holdout.rule",
} as const;

interface RankRow {
  group: RankingGroup;
  /** Absent until the range has a shaped read in this group. */
  cell: SpotlightRankingCell | undefined;
}

/** A missing estimate reads as a dash, never as a zero score. */
function formatScore(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "–" : value.toFixed(2);
}

function formatLift(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "–" : `${value.toFixed(2)}×`;
}

export function Ranking({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
  const { t } = useTranslation();
  const { ranking } = stats;
  const cells = new Map<RankingGroup, SpotlightRankingCell>(
    (ranking.cells ?? []).map((cell) => [cell.group, cell]),
  );
  const rows: RankRow[] = GROUPS.map((group) => ({ group, cell: cells.get(group) }));
  const applied = cells.get("applied");
  const measured = rows.some((row) => (row.cell?.results ?? 0) > 0);

  const barMax = (pick: (cell: SpotlightRankingCell) => number | null): number =>
    Math.max(1, ...rows.map((row) => (row.cell === undefined ? 0 : (pick(row.cell) ?? 0))));

  const ratioCell = (
    row: RankRow,
    pick: (cell: SpotlightRankingCell) => SpotlightEstimate,
    format: (value: number | null) => string,
    max: number,
  ) => {
    if (row.cell === undefined) return <span className="dim">–</span>;
    const estimate = pick(row.cell);
    const interval = formatInterval(estimate, format);
    return (
      <span title={interval === "" ? undefined : t("settingsPage.stats.spotlight.ranking.interval", { interval })}>
        <MeterCell
          value={estimate.value ?? 0}
          max={max}
          display={format(estimate.value)}
          color={CUT_GROUP[row.group].color}
        />
      </span>
    );
  };

  const maxAuc = barMax((cell) => cell.auc.value);
  const maxTopLift = barMax((cell) => cell.topLift.value);
  const maxKeptLift = barMax((cell) => cell.keptLift.value);

  const columns: Column<RankRow>[] = [
    {
      key: "group",
      header: t("settingsPage.stats.spotlight.ranking.colGroup"),
      width: 160,
      render: (row) => (
        <span className="row" style={{ gap: 6 }}>
          <span className="swatch" style={{ background: CUT_GROUP[row.group].color }} />
          <span className="cell-primary" title={t(GROUP_RULE[row.group])}>
            {t(GROUP_LABEL[row.group])}
          </span>
        </span>
      ),
    },
    {
      key: "results",
      header: t("settingsPage.stats.spotlight.ranking.colResults"),
      align: "right",
      render: (row) =>
        row.cell === undefined || row.cell.results === 0 ? (
          <span className="dim">–</span>
        ) : (
          <span className="stats-num">{formatInteger(row.cell.results)}</span>
        ),
    },
    {
      key: "neededLines",
      header: t("settingsPage.stats.spotlight.ranking.colNeededLines"),
      align: "right",
      render: (row) =>
        row.cell === undefined || row.cell.results === 0 ? (
          <span className="dim">–</span>
        ) : (
          <span className="stats-num">{formatCompact(row.cell.neededLines)}</span>
        ),
    },
    {
      key: "auc",
      header: t("settingsPage.stats.spotlight.ranking.colAuc"),
      align: "right",
      render: (row) => ratioCell(row, (cell) => cell.auc, formatScore, maxAuc),
    },
    {
      key: "topLift",
      header: t("settingsPage.stats.spotlight.ranking.colTopLift"),
      align: "right",
      render: (row) => ratioCell(row, (cell) => cell.topLift, formatLift, maxTopLift),
    },
    {
      key: "keptLift",
      header: t("settingsPage.stats.spotlight.ranking.colKeptLift"),
      align: "right",
      render: (row) => ratioCell(row, (cell) => cell.keptLift, formatLift, maxKeptLift),
    },
  ];

  const positions = (ranking.position ?? []).filter((position) => Number.isFinite(position.meanHeat));
  const heatTop = Math.max(0, ...positions.map((position) => position.meanHeat));
  const aucInterval = applied === undefined ? "" : formatInterval(applied.auc, formatScore);
  const aucHint =
    aucInterval === ""
      ? t("settingsPage.stats.spotlight.ranking.statAucHint")
      : `${t("settingsPage.stats.spotlight.ranking.interval", { interval: aucInterval })} · ${t(
          "settingsPage.stats.spotlight.ranking.statAucHint",
        )}`;

  return (
    <Card
      index={1}
      title={t("settingsPage.stats.spotlight.ranking.title")}
      description={t("settingsPage.stats.spotlight.ranking.description")}
      stale={stale}
      footer={t("settingsPage.stats.spotlight.ranking.footer")}
    >
      {!measured ? (
        <EmptyState title={t("settingsPage.stats.spotlight.ranking.empty")} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <StatGrid min={160}>
            <Stat
              label={t("settingsPage.stats.spotlight.ranking.statAuc")}
              value={formatScore(applied?.auc.value ?? null)}
              hint={aucHint}
            />
            <Stat
              label={t("settingsPage.stats.spotlight.ranking.statNeeded")}
              value={applied === undefined ? "–" : formatCompact(applied.neededLines)}
              hint={
                applied === undefined
                  ? undefined
                  : t("settingsPage.stats.spotlight.ranking.statNeededHint", {
                      results: formatInteger(applied.results),
                    })
              }
            />
          </StatGrid>
          <Table rows={rows} rowKey={(row) => row.group} columns={columns} dense />
          {positions.length === 0 || heatTop === 0 ? (
            <span className="micro dim">{t("settingsPage.stats.spotlight.ranking.positionEmpty")}</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="micro dim" title={t("settingsPage.stats.spotlight.ranking.positionHint")}>
                {t("settingsPage.stats.spotlight.ranking.positionTitle")}
              </span>
              <BarList
                items={positions.map((position) => ({
                  key: position.label,
                  label: position.label,
                  value: position.meanHeat,
                  display: position.meanHeat.toFixed(2),
                }))}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
