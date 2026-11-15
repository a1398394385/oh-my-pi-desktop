/**
 * Which shaping steps pay: how much of each kind of cut's saving stays saved
 * after the agent fetches the hidden text back, by tool, step combination and
 * result size. One row per (tool, steps); tinted cells carry the kept share.
 */
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatCompact, formatInteger } from "../data/formatters";
import type {
  SpotlightDashboardStats,
  SpotlightSizeBin,
  SpotlightStepCell,
  SpotlightTool,
} from "../types";
import { Card, type Column, EmptyState, Table } from "../ui";
import { foldTools, formatShare, formatSignedCompact, SIZE_BINS, toolIcon, toolsBySaving } from "./meta";

/** Under this many cuts a cell's share swings on a handful of fetch-backs: it renders muted. */
const THIN_CUTS = 10;

/** Tint of a cell kept entirely (or lost entirely); the rest scale with the distance from half kept. */
const MAX_TINT = 30;
const MIN_TINT = 4;

interface StepRow {
  tool: SpotlightTool;
  steps: string;
  bySize: Map<SpotlightSizeBin, SpotlightStepCell>;
  cuts: number;
  savedTokens: number;
  recoveredTokens: number;
  excessTokens: number;
}

/** One tool's steps, its biggest saving first and the folded `other` last. */
function stepRows(cells: readonly SpotlightStepCell[], tool: SpotlightTool): StepRow[] {
  const rows = new Map<string, StepRow>();
  for (const cell of cells) {
    if (cell.tool !== tool) continue;
    let row = rows.get(cell.steps);
    if (row === undefined) {
      row = {
        tool,
        steps: cell.steps,
        bySize: new Map(),
        cuts: 0,
        savedTokens: 0,
        recoveredTokens: 0,
        excessTokens: 0,
      };
      rows.set(cell.steps, row);
    }
    row.bySize.set(cell.size, cell);
    row.cuts += cell.cuts;
    row.savedTokens += cell.savedTokens;
    row.recoveredTokens += cell.recoveredTokens;
    row.excessTokens += cell.excessTokens;
  }
  return [...rows.values()].sort(
    (a, b) => Number(a.steps === "other") - Number(b.steps === "other") || b.savedTokens - a.savedTokens,
  );
}

/** Green above half the saving kept, red below; strength grows toward all or nothing. */
function tintStyle(kept: number): CSSProperties {
  const strength = MIN_TINT + Math.min(1, Math.abs(kept - 0.5) * 2) * (MAX_TINT - MIN_TINT);
  return {
    background: `color-mix(in srgb, var(${kept >= 0.5 ? "--green" : "--err"}) ${strength}%, transparent)`,
    borderRadius: "var(--r-sm)",
    padding: "2px 6px",
  };
}

function KeptCell({
  kept,
  cuts,
  title,
  facts,
  noSaving,
}: {
  kept: number | null;
  cuts: number;
  title: string;
  facts: string;
  noSaving: string;
}) {
  if (kept === null) {
    return (
      <span className="dim" title={title}>
        {noSaving}
      </span>
    );
  }
  return (
    <div style={tintStyle(kept)} title={title}>
      <span className={cuts < THIN_CUTS ? "stats-num muted" : "stats-num"}>{formatShare(kept)}</span>
      <div className="micro dim">{facts}</div>
    </div>
  );
}

export function Steps({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
  const { t } = useTranslation();
  const grouped = toolsBySaving(stats)
    .map(tool => ({ tool, rows: stepRows(stats.steps, tool) }))
    .filter(group => group.rows.length > 0);
  const { listed } = foldTools(grouped);
  const rows = listed.flatMap(group => group.rows);

  const cellTitle = (row: StepRow, size: string, cuts: number, cell: SpotlightStepCell | StepRow): string[] => [
    t("settingsPage.stats.spotlight.steps.cellTitle", {
      tool: row.tool,
      steps: row.steps,
      size,
      cuts: formatInteger(cuts),
    }),
    t("settingsPage.stats.spotlight.steps.cellDetail", {
      saved: formatSignedCompact(cell.savedTokens),
      recovered: formatCompact(cell.recoveredTokens),
      excess: formatCompact(cell.excessTokens),
    }),
  ];

  const columns: Column<StepRow>[] = [
    {
      key: "tool",
      header: t("settingsPage.stats.spotlight.steps.colTool"),
      render: row => {
        const Icon = toolIcon(row.tool);
        return (
          <span className="row">
            <Icon size={13} aria-hidden="true" />
            {row.tool}
          </span>
        );
      },
    },
    {
      key: "steps",
      header: t("settingsPage.stats.spotlight.steps.colSteps"),
      render: row => <span className="truncate">{row.steps}</span>,
    },
    ...SIZE_BINS.map(
      (size): Column<StepRow> => ({
        key: size,
        header: t("settingsPage.stats.spotlight.steps.colSizeHeader", { size }),
        align: "center",
        render: row => {
          const cell = row.bySize.get(size);
          if (cell === undefined || cell.cuts === 0) return <span className="dim">–</span>;
          const title = [
            ...cellTitle(row, size, cell.cuts, cell),
            t("settingsPage.stats.spotlight.steps.cellFetchedBack", {
              share: formatShare(cell.fetchBackRate.value),
            }),
          ].join("\n");
          return (
            <KeptCell
              kept={cell.keptShare}
              cuts={cell.cuts}
              title={title}
              noSaving={t("settingsPage.stats.spotlight.steps.noSaving")}
              facts={t("settingsPage.stats.spotlight.steps.cellFacts", {
                cuts: formatInteger(cell.cuts),
                saved: formatSignedCompact(cell.savedTokens),
              })}
            />
          );
        },
      }),
    ),
    {
      key: "all",
      header: t("settingsPage.stats.spotlight.steps.allSizes"),
      align: "center",
      render: row => {
        const size = t("settingsPage.stats.spotlight.steps.allSizes");
        const kept = row.savedTokens > 0 ? (row.savedTokens - row.excessTokens) / row.savedTokens : null;
        return (
          <KeptCell
            kept={kept}
            cuts={row.cuts}
            title={cellTitle(row, size, row.cuts, row).join("\n")}
            noSaving={t("settingsPage.stats.spotlight.steps.noSaving")}
            facts={t("settingsPage.stats.spotlight.steps.cellFacts", {
              cuts: formatInteger(row.cuts),
              saved: formatSignedCompact(row.savedTokens),
            })}
          />
        );
      },
    },
  ];

  return (
    <Card
      title={t("settingsPage.stats.spotlight.steps.title")}
      description={t("settingsPage.stats.spotlight.steps.description")}
      footer={
        <span>{t("settingsPage.stats.spotlight.steps.footer", { thin: THIN_CUTS })}</span>
      }
      stale={stale}
    >
      <Table
        rows={rows}
        rowKey={row => `${row.tool}::${row.steps}`}
        columns={columns}
        dense
        empty={<EmptyState title={t("settingsPage.stats.spotlight.steps.empty")} />}
      />
    </Card>
  );
}
