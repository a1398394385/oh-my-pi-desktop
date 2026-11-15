/**
 * Recent results: the newest shortened and held-out tool results with what each
 * cut saved and what the agent fetched back. Answers "is shaping still landing
 * on the calls that matter, and is the hidden output coming back?".
 */
import type { TFunction } from "i18next";
import { CornerDownRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  formatCompact,
  formatCost,
  formatDurationMs,
  formatElapsed,
  formatInteger,
  formatRelativeTime,
  formatTimestamp,
} from "../data/formatters";
import type { SpotlightRecoveryKind, SpotlightResultRow } from "../types";
import { Badge, Card, type Column, EmptyState, KeyValues, MeterCell, Table } from "../ui";
import { formatSignedCompact, RECOVERY_KIND, RECOVERY_KINDS, toolIcon } from "./meta";

/** Rows shown before the table's own "show more"; the feed is a feed, not a full log. */
const FEED_LIMIT = 15;


/** A result is identified by the session it was journaled in plus its call. */
function rowKey(row: SpotlightResultRow): string {
  return `${row.sessionFile}\u0000${row.toolCallId}`;
}

// A payload field can arrive missing or non-finite, and every formatter prints that verbatim
// ("NaN", "$NaN", "NaNs"); the numeric cells route through here so they show a dash instead.
function num(value: number, format: (value: number) => string): string {
  return Number.isFinite(value) ? format(value) : "–";
}

function kindCounts(row: SpotlightResultRow): [SpotlightRecoveryKind, number][] {
  const counts = new Map<SpotlightRecoveryKind, number>();
  for (const recovery of row.recoveries) counts.set(recovery.kind, (counts.get(recovery.kind) ?? 0) + 1);
  return RECOVERY_KINDS.flatMap((kind): [SpotlightRecoveryKind, number][] => {
    const count = counts.get(kind);
    return count ? [[kind, count]] : [];
  });
}

function NetCell({ value }: { value: number }) {
  return (
    <span className={value < 0 ? "stats-num tone-bad" : value > 0 ? "stats-num tone-ok" : "stats-num"}>
      {num(value, formatSignedCompact)}
    </span>
  );
}

// Recovery-kind copy is looked up through a literal per kind: the i18n gate only
// resolves static keys, and RECOVERY_KIND's key suffix cannot build one.
const RECOVERY_TITLE = {
  artifact: "settingsPage.stats.spotlight.meta.recovery.artifact.rule",
  reread: "settingsPage.stats.spotlight.meta.recovery.reread.rule",
  rerun: "settingsPage.stats.spotlight.meta.recovery.rerun.rule",
} as const;

function KindBadge({ kind, count: kindCount }: { kind: SpotlightRecoveryKind; count?: number }) {
  const { t } = useTranslation();
  const meta = RECOVERY_KIND[kind];
  const Icon = meta.icon;
  return (
    <span title={t(RECOVERY_TITLE[kind])}>
      <Badge mono>
        <Icon size={11} aria-hidden="true" />
        {kindCount !== undefined && ` ${num(kindCount, formatInteger)}`}
      </Badge>
    </span>
  );
}

function HoldoutBadge() {
  const { t } = useTranslation();
  return (
    <span title={t("settingsPage.stats.spotlight.feed.holdoutBadgeTitle")}>
      <Badge>{t("settingsPage.stats.spotlight.feed.holdoutBadge")}</Badge>
    </span>
  );
}

function ScoreFreeBadge() {
  const { t } = useTranslation();
  return (
    <span title={t("settingsPage.stats.spotlight.feed.scoreFreeBadgeTitle")}>
      <Badge>{t("settingsPage.stats.spotlight.feed.scoreFreeBadge")}</Badge>
    </span>
  );
}

function buildColumns(t: TFunction): readonly Column<SpotlightResultRow>[] {
  return [
    {
      key: "result",
      header: t("settingsPage.stats.spotlight.feed.colResult"),
      width: "40%",
      sort: row => row.timestamp,
      render: row => {
        const Icon = toolIcon(row.tool);
        return (
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <Icon size={14} aria-hidden="true" />
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span className="cell-primary truncate" title={row.target}>
                {row.target || "–"}
              </span>
              <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <span className="mono dim">{row.tool}</span>
                {row.holdout && <HoldoutBadge />}
                {row.scoreFree && <ScoreFreeBadge />}
                <span className="dim" title={Number.isFinite(row.timestamp) ? formatTimestamp(row.timestamp) : undefined}>
                  {Number.isFinite(row.timestamp) ? formatRelativeTime(row.timestamp) : "–"}
                </span>
              </span>
            </div>
          </div>
        );
      },
    },
    {
      key: "shrink",
      header: t("settingsPage.stats.spotlight.feed.colShrink"),
      align: "right",
      // A zero plain size means nothing was shown unshaped, so nothing survived by definition.
      sort: row => (row.plainTokens > 0 ? row.outTokens / row.plainTokens : 1),
      title: t("settingsPage.stats.spotlight.feed.colShrinkTitle"),
      render: row => (
        <MeterCell
          value={row.outTokens}
          max={row.plainTokens}
          // Held-out results are a counterfactual: dim bar, so it never reads as what the model saw.
          color={row.holdout ? "var(--dim)" : "var(--chart-primary)"}
          display={
            <>
              {num(row.plainTokens, formatCompact)}
              <span className="dim"> → </span>
              {num(row.outTokens, formatCompact)}
            </>
          }
        />
      ),
    },
    {
      key: "saved",
      header: t("settingsPage.stats.spotlight.feed.colSaved"),
      align: "right",
      width: 120,
      sort: row => row.savedTokens,
      render: row =>
        row.holdout ? (
          <span className="dim" title={t("settingsPage.stats.spotlight.feed.savedHoldoutTitle")}>
            {t("settingsPage.stats.spotlight.feed.wouldSave")}{" "}
            <span className="stats-num">{num(row.savedTokens, formatSignedCompact)}</span>
          </span>
        ) : (
          <span className="stats-num">{num(row.savedTokens, formatSignedCompact)}</span>
        ),
    },
    {
      key: "hidden",
      header: t("settingsPage.stats.spotlight.feed.colHidden"),
      align: "right",
      width: 110,
      sort: row => row.hiddenLines,
      render: row =>
        row.hiddenLines > 0 ? (
          <span className="stats-num">{num(row.hiddenLines, formatInteger)}</span>
        ) : (
          <span className="dim">–</span>
        ),
    },
    {
      key: "recoveries",
      header: t("settingsPage.stats.spotlight.feed.colFetchedBack"),
      sort: row => row.recoveries.length,
      render: row => {
        const counts = kindCounts(row);
        return counts.length === 0 ? (
          <span className="dim" title={t("settingsPage.stats.spotlight.feed.recoveredNoneTitle")}>
            –
          </span>
        ) : (
          <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {counts.map(([kind, count]) => (
              <KindBadge key={kind} kind={kind} count={count} />
            ))}
          </span>
        );
      },
    },
    {
      key: "net",
      header: t("settingsPage.stats.spotlight.feed.colNet"),
      align: "right",
      width: 100,
      sort: row => row.netTokens,
      title: t("settingsPage.stats.spotlight.feed.colNetTitle"),
      render: row =>
        row.holdout ? (
          <span className="dim" title={t("settingsPage.stats.spotlight.feed.netHoldoutTitle")}>
            –
          </span>
        ) : (
          <NetCell value={row.netTokens} />
        ),
    },
  ];
}

/** The newest shortened and held-out results; a row expands into its recovery timeline. */
export function ResultsFeed({ rows, stale }: { rows: readonly SpotlightResultRow[]; stale: boolean }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const columns = useMemo(() => buildColumns(t), [t]);

  return (
    <Card
      index={12}
      title={t("settingsPage.stats.spotlight.feed.cardTitle")}
      description={t("settingsPage.stats.spotlight.feed.cardDesc")}
      flush
      stale={stale}
      footer={t("settingsPage.stats.spotlight.feed.cardFooter")}
    >
      <Table
        rows={rows}
        rowKey={rowKey}
        columns={columns}
        initialSort={{ key: "saved", dir: "desc" }}
        limit={FEED_LIMIT}
        dense
        onRowClick={row => setSelected(current => (current === rowKey(row) ? null : rowKey(row)))}
        selectedKey={selected}
        expanded={row => (rowKey(row) === selected ? <ResultDetail row={row} /> : null)}
        empty={<EmptyState title={t("settingsPage.stats.spotlight.feed.empty")} />}
      />
    </Card>
  );
}

/** One result's cut and the calls that fetched the hidden output back, newest first. */
function ResultDetail({ row }: { row: SpotlightResultRow }) {
  const { t } = useTranslation();
  // Recovery tokens are what the row's net already subtracted; saved − net is that cost with no extra field.
  const recovered = Math.max(0, row.savedTokens - row.netTokens);

  return (
    // The expanded cell is padding-free, so the detail reuses the page's padded column container.
    <div className="drawer-body">
      <KeyValues
        items={[
          {
            key: "saved",
            label: row.holdout ? t("settingsPage.stats.spotlight.feed.detailWouldSave") : t("settingsPage.stats.spotlight.feed.detailSaved"),
            value: num(row.savedTokens, formatSignedCompact),
          },
          {
            key: "recovered",
            label: t("settingsPage.stats.spotlight.feed.detailRecovered"),
            value: (
              <span className={recovered > 0 ? "stats-num tone-warn" : "stats-num"}>
                {num(recovered, formatCompact)}
              </span>
            ),
          },
          {
            key: "net",
            label: t("settingsPage.stats.spotlight.feed.detailNet"),
            value: row.holdout ? (
              <span className="dim" title={t("settingsPage.stats.spotlight.feed.detailNetHoldoutTitle")}>
                –
              </span>
            ) : (
              <NetCell value={row.netTokens} />
            ),
          },
          { key: "plain", label: t("settingsPage.stats.spotlight.feed.detailPlain"), value: num(row.plainTokens, formatInteger) },
          { key: "out", label: t("settingsPage.stats.spotlight.feed.detailOut"), value: num(row.outTokens, formatInteger) },
          { key: "in", label: t("settingsPage.stats.spotlight.feed.detailIn"), value: num(row.inTokens, formatInteger) },
          {
            key: "hidden",
            label: row.holdout ? t("settingsPage.stats.spotlight.feed.detailHiddenWould") : t("settingsPage.stats.spotlight.feed.detailHidden"),
            value: num(row.hiddenLines, formatInteger),
          },
          {
            key: "steps",
            label: t("settingsPage.stats.spotlight.feed.detailSteps"),
            value: row.steps.length > 0 ? row.steps.join(" → ") : "–",
          },
          { key: "cost", label: t("settingsPage.stats.spotlight.feed.detailCost"), value: num(row.spotlightUsd, formatCost) },
          { key: "shape", label: t("settingsPage.stats.spotlight.feed.detailShapeMs"), value: num(row.shapeMs, formatDurationMs) },
        ]}
      />

      <div>
        <div className="section-label">{t("settingsPage.stats.spotlight.feed.detailCall")}</div>
        <pre className="code-block" style={{ margin: 0 }}>{row.target}</pre>
      </div>

      <div>
        <div className="section-label">{t("settingsPage.stats.spotlight.feed.detailTimeline")}</div>
        {row.recoveries.length === 0 ? (
          <span className="micro">{t("settingsPage.stats.spotlight.feed.detailNoRecoveries")}</span>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {row.recoveries.map(recovery => (
              <div key={recovery.toolCallId} className="stack" style={{ gap: 2 }}>
                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <CornerDownRight size={12} aria-hidden="true" />
                  <KindBadge kind={recovery.kind} />
                  {recovery.turn && <Badge tone="warn">{t("settingsPage.stats.spotlight.feed.extraTurn")}</Badge>}
                  <span className="stats-num tone-warn">+{num(recovery.tokens, formatCompact)}</span>
                </span>
                <span className="mono truncate" title={recovery.target}>
                  <span className="dim">{recovery.tool} </span>
                  {recovery.target}
                </span>
                <span className="micro">
                  {recovery.after === 0
                    ? t("settingsPage.stats.spotlight.feed.nextCall")
                    : t("settingsPage.stats.spotlight.feed.callsLater", { count: recovery.after })}
                  {" · "}
                  {t("settingsPage.stats.spotlight.feed.afterCut", {
                    elapsed: Number.isFinite(recovery.timestamp - row.timestamp)
                      ? formatElapsed(Math.max(0, recovery.timestamp - row.timestamp))
                      : "–",
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
