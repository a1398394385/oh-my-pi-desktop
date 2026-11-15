/** Fetch-back: how often the agent fetched more of each cut group's output within 12 calls, and what recoveries cost. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Legend } from "../charts";
import { formatCompact, formatCost, formatInteger } from "../data/formatters";
import type {
  SpotlightCutGroup,
  SpotlightDashboardStats,
  SpotlightFetchBackCell,
  SpotlightGapBin,
  SpotlightGapCount,
  SpotlightRecoveryKind,
  SpotlightRecoveryTotals,
} from "../types";
import { Card, EmptyState, MeterCell, Stat, StatGrid, Table, type Column } from "../ui";
import {
  CUT_GROUP,
  CUT_GROUPS,
  foldTools,
  formatInterval,
  formatShare,
  formatSignedCompact,
  GAP_BINS,
  RECOVERY_KIND,
  RECOVERY_KINDS,
  toolIcon,
  toolsBySaving,
} from "./meta";

const GROUP_LABEL = {
  applied: "settingsPage.stats.spotlight.meta.cutGroup.applied.label",
  scoreFree: "settingsPage.stats.spotlight.meta.cutGroup.scoreFree.label",
  holdout: "settingsPage.stats.spotlight.meta.cutGroup.holdout.label",
  gated: "settingsPage.stats.spotlight.meta.cutGroup.gated.label",
  reference: "settingsPage.stats.spotlight.meta.cutGroup.reference.label",
} as const;

const GROUP_RULE = {
  applied: "settingsPage.stats.spotlight.meta.cutGroup.applied.rule",
  scoreFree: "settingsPage.stats.spotlight.meta.cutGroup.scoreFree.rule",
  holdout: "settingsPage.stats.spotlight.meta.cutGroup.holdout.rule",
  gated: "settingsPage.stats.spotlight.meta.cutGroup.gated.rule",
  reference: "settingsPage.stats.spotlight.meta.cutGroup.reference.rule",
} as const;

const KIND_LABEL = {
  artifact: "settingsPage.stats.spotlight.meta.recovery.artifact.label",
  reread: "settingsPage.stats.spotlight.meta.recovery.reread.label",
  rerun: "settingsPage.stats.spotlight.meta.recovery.rerun.label",
} as const;

const KIND_RULE = {
  artifact: "settingsPage.stats.spotlight.meta.recovery.artifact.rule",
  reread: "settingsPage.stats.spotlight.meta.recovery.reread.rule",
  rerun: "settingsPage.stats.spotlight.meta.recovery.rerun.rule",
} as const;

/** The gap histogram counts only the scored cut and its counterfactual. */
type GapGroup = "applied" | "holdout";
const GAP_GROUPS: readonly GapGroup[] = ["applied", "holdout"];

/** Cells with results only; a group without results has no cell. */
type FetchRow = { tool: string; byGroup: ReadonlyMap<SpotlightCutGroup, SpotlightFetchBackCell> };

type KindRow = { kind: SpotlightRecoveryKind; totals: SpotlightRecoveryTotals };

const NO_RECOVERY: SpotlightRecoveryTotals = { events: 0, tokens: 0, turns: 0, turnsUsd: 0, usd: 0 };

export interface FetchBackProps {
  stats: SpotlightDashboardStats;
  stale: boolean;
}

/** Fetch-back rate per tool: the scored cut against the score-free one, the random holdout and unchanged results. */
export function FetchBack({ stats, stale }: FetchBackProps) {
  const { t } = useTranslation();
  const fetchBack = stats.fetchBack ?? [];
  const measured = new Set(fetchBack.filter((cell) => cell.results > 0).map((cell) => cell.tool));
  const rows: FetchRow[] = toolsBySaving(stats)
    .filter((tool) => measured.has(tool))
    .map((tool) => {
      const byGroup = new Map<SpotlightCutGroup, SpotlightFetchBackCell>();
      for (const cell of fetchBack) if (cell.tool === tool) byGroup.set(cell.group, cell);
      return { tool, byGroup };
    });
  // Only reads were gated, and only while pi's former edit gate ran: list the group where the range has results.
  const groups = CUT_GROUPS.filter(
    (group) => group !== "gated" || fetchBack.some((cell) => cell.group === "gated" && cell.results > 0),
  );
  const maxRate = Math.max(
    0,
    ...fetchBack.filter((cell) => groups.includes(cell.group)).map((cell) => cell.rate.value ?? 0),
  );

  const rateCell = (row: FetchRow, group: SpotlightCutGroup) => {
    const cell = row.byGroup.get(group);
    if (cell === undefined || cell.results === 0) return <span className="dim">–</span>;
    const interval = formatInterval(cell.rate, formatShare);
    const title = [
      t("settingsPage.stats.spotlight.fetchBack.cellTitle", {
        results: formatInteger(cell.results),
        sessions: formatInteger(cell.sessions),
      }),
      interval === "" ? null : t("settingsPage.stats.spotlight.fetchBack.interval", { interval }),
    ]
      .filter((part) => part !== null)
      .join(" · ");
    return (
      <span title={title}>
        <MeterCell
          value={cell.rate.value ?? 0}
          max={maxRate}
          display={formatShare(cell.rate.value)}
          color={CUT_GROUP[group].color}
        />
      </span>
    );
  };

  const columns: Column<FetchRow>[] = [
    {
      key: "tool",
      header: t("settingsPage.stats.spotlight.fetchBack.colTool"),
      width: 150,
      render: (row) => {
        const Icon = toolIcon(row.tool);
        return (
          <span className="row" style={{ gap: 6 }}>
            <Icon size={13} aria-hidden="true" />
            <span className="cell-primary">{row.tool}</span>
          </span>
        );
      },
    },
    ...groups.map(
      (group): Column<FetchRow> => ({
        key: group,
        header: (
          <span className="row" style={{ gap: 6 }}>
            <span className="swatch" style={{ background: CUT_GROUP[group].color }} />
            <span title={t(GROUP_RULE[group])}>{t(GROUP_LABEL[group])}</span>
          </span>
        ),
        align: "right",
        render: (row) => rateCell(row, group),
      }),
    ),
  ];

  const { clawback } = stats;
  const kindRows: KindRow[] = RECOVERY_KINDS.map((kind) => ({
    kind,
    totals: clawback.byKind[kind] ?? NO_RECOVERY,
  }));
  const maxKindTokens = Math.max(1, ...kindRows.map((row) => row.totals.tokens));
  const reach = clawback.withHidden > 0 ? clawback.recovered / clawback.withHidden : null;

  const kindColumns: Column<KindRow>[] = [
    {
      key: "kind",
      header: t("settingsPage.stats.spotlight.fetchBack.clawback.colKind"),
      render: (row) => {
        const Icon = RECOVERY_KIND[row.kind].icon;
        return (
          <span className="row" style={{ gap: 6 }} title={t(KIND_RULE[row.kind])}>
            <span style={{ color: RECOVERY_KIND[row.kind].color }}>
              <Icon size={13} aria-hidden="true" />
            </span>
            <span className="cell-primary">{t(KIND_LABEL[row.kind])}</span>
          </span>
        );
      },
    },
    {
      key: "events",
      header: t("settingsPage.stats.spotlight.fetchBack.clawback.colEvents"),
      align: "right",
      render: (row) => <span className="stats-num">{formatInteger(row.totals.events)}</span>,
    },
    {
      key: "tokens",
      header: t("settingsPage.stats.spotlight.fetchBack.clawback.colTokens"),
      align: "right",
      render: (row) => (
        <span title={formatInteger(row.totals.tokens)}>
          <MeterCell
            value={row.totals.tokens}
            max={maxKindTokens}
            display={formatCompact(row.totals.tokens)}
            color={RECOVERY_KIND[row.kind].color}
          />
        </span>
      ),
    },
    {
      key: "turns",
      header: t("settingsPage.stats.spotlight.fetchBack.clawback.colTurns"),
      align: "right",
      render: (row) => <span className="stats-num">{formatInteger(row.totals.turns)}</span>,
    },
    {
      key: "usd",
      header: t("settingsPage.stats.spotlight.fetchBack.clawback.colCost"),
      align: "right",
      render: (row) => <span className="stats-num">{formatCost(row.totals.usd)}</span>,
    },
  ];

  return (
    <>
      <Card
        index={2}
        title={t("settingsPage.stats.spotlight.fetchBack.title")}
        description={t("settingsPage.stats.spotlight.fetchBack.description")}
        stale={stale}
        footer={t("settingsPage.stats.spotlight.fetchBack.footer")}
      >
        {rows.length === 0 ? (
          <EmptyState title={t("settingsPage.stats.spotlight.fetchBack.empty")} />
        ) : (
          <Table rows={rows} rowKey={(row) => row.tool} columns={columns} dense limit={12} />
        )}
      </Card>

      <Card
        index={3}
        title={t("settingsPage.stats.spotlight.fetchBack.clawback.title")}
        description={t("settingsPage.stats.spotlight.fetchBack.clawback.description")}
        stale={stale}
        footer={t("settingsPage.stats.spotlight.fetchBack.clawback.footer")}
      >
        {clawback.withHidden === 0 ? (
          <EmptyState title={t("settingsPage.stats.spotlight.fetchBack.clawback.empty")} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <StatGrid min={170}>
              <Stat
                label={t("settingsPage.stats.spotlight.fetchBack.clawback.statReach")}
                value={formatShare(reach)}
                hint={t("settingsPage.stats.spotlight.fetchBack.clawback.statReachHint", {
                  recovered: formatInteger(clawback.recovered),
                  withHidden: formatInteger(clawback.withHidden),
                })}
              />
              <Stat
                label={t("settingsPage.stats.spotlight.fetchBack.clawback.statEvents")}
                value={formatInteger(clawback.events)}
              />
              <Stat
                label={t("settingsPage.stats.spotlight.fetchBack.clawback.statTokens")}
                value={formatCompact(clawback.tokens)}
                hint={t("settingsPage.stats.spotlight.fetchBack.clawback.statTokensHint", {
                  net: formatSignedCompact(clawback.netTokens),
                })}
              />
              <Stat
                label={t("settingsPage.stats.spotlight.fetchBack.clawback.statCost")}
                value={formatCost(clawback.usd)}
                hint={t("settingsPage.stats.spotlight.fetchBack.clawback.statCostHint", {
                  turns: formatInteger(clawback.turns),
                })}
              />
            </StatGrid>
            <Table rows={kindRows} rowKey={(row) => row.kind} columns={kindColumns} dense />
          </div>
        )}
      </Card>
    </>
  );
}

interface GapRow {
  bin: SpotlightGapBin;
  count: SpotlightGapCount | undefined;
}

/** One tool's fetch-back distribution: each group's bins as a share of that group's own fetch-backs. */
function GapPanel({ tool, counts }: { tool: string; counts: readonly SpotlightGapCount[] }) {
  const { t } = useTranslation();
  const Icon = toolIcon(tool);
  const byBin = new Map<SpotlightGapBin, SpotlightGapCount>(counts.map((count) => [count.gap, count]));
  const totals: Record<GapGroup, number> = { applied: 0, holdout: 0 };
  for (const count of counts) {
    totals.applied += count.applied;
    totals.holdout += count.holdout;
  }
  const rows: GapRow[] = GAP_BINS.map((bin) => ({ bin, count: byBin.get(bin) }));
  const shareOf = (group: GapGroup, row: GapRow): number | null =>
    totals[group] > 0 ? (row.count?.[group] ?? 0) / totals[group] : null;
  const top = Math.max(0, ...rows.flatMap((row) => GAP_GROUPS.map((group) => shareOf(group, row) ?? 0)));

  const shareCell = (row: GapRow, group: GapGroup) => {
    const share = shareOf(group, row);
    return (
      <span
        title={t("settingsPage.stats.spotlight.fetchBack.gaps.cellTitle", {
          group: t(GROUP_LABEL[group]),
          count: formatInteger(row.count?.[group] ?? 0),
          total: formatInteger(totals[group]),
        })}
      >
        <MeterCell
          value={share ?? 0}
          max={top}
          display={share === null ? "–" : formatShare(share)}
          color={CUT_GROUP[group].color}
        />
      </span>
    );
  };

  const columns: Column<GapRow>[] = [
    {
      key: "gap",
      header: t("settingsPage.stats.spotlight.fetchBack.gaps.colGap"),
      width: 96,
      render: (row) => <span className="stats-num">{row.bin}</span>,
    },
    {
      key: "applied",
      header: t("settingsPage.stats.spotlight.fetchBack.gaps.colShortened"),
      align: "right",
      render: (row) => shareCell(row, "applied"),
    },
    {
      key: "holdout",
      header: t("settingsPage.stats.spotlight.fetchBack.gaps.colHeldOut"),
      align: "right",
      render: (row) => shareCell(row, "holdout"),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="row" style={{ gap: 6 }}>
        <Icon size={13} aria-hidden="true" />
        <span className="cell-primary">{tool}</span>
        <span className="micro dim">
          {t("settingsPage.stats.spotlight.fetchBack.gaps.totals", {
            shortened: formatInteger(totals.applied),
            heldOut: formatInteger(totals.holdout),
          })}
        </span>
      </span>
      <Table rows={rows} rowKey={(row) => row.bin} columns={columns} dense />
    </div>
  );
}

/** How many calls after the cut the agent fetched back, per tool, shortened against held out. */
export function FetchBackGaps({ stats, stale }: FetchBackProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const gaps = stats.gaps ?? [];
  const counted = toolsBySaving(stats).filter((tool) => gaps.some((count) => count.tool === tool));
  const { listed, rest } = foldTools(counted);
  const shown = expanded ? [...listed, ...rest] : listed;

  return (
    <Card
      index={4}
      title={t("settingsPage.stats.spotlight.fetchBack.gaps.title")}
      description={t("settingsPage.stats.spotlight.fetchBack.gaps.description")}
      stale={stale}
      footer={t("settingsPage.stats.spotlight.fetchBack.gaps.footer")}
    >
      {listed.length === 0 ? (
        <EmptyState title={t("settingsPage.stats.spotlight.fetchBack.gaps.empty")} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Legend
            items={GAP_GROUPS.map((group) => ({
              key: group,
              label: t(GROUP_LABEL[group]),
              color: CUT_GROUP[group].color,
            }))}
          />
          {shown.map((tool) => (
            <GapPanel key={tool} tool={tool} counts={gaps.filter((count) => count.tool === tool)} />
          ))}
          {rest.length > 0 && (
            <button
              type="button"
              className="btn"
              data-size="sm"
              data-variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? t("settingsPage.stats.spotlight.fetchBack.gaps.fewer")
                : t("settingsPage.stats.spotlight.fetchBack.gaps.more", { count: rest.length })}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
