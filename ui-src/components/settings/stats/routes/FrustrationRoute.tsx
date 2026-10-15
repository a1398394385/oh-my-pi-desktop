import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getFrustrationDashboardStats } from "../api";
import { Chart, type ChartSeries, Legend, useHiddenSeries } from "../charts";
import { SERIES_COLORS } from "../data/colors";
import { formatInteger, formatPercent } from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import type {
  FrustrationCounts,
  FrustrationModelStats,
  TimeRange,
} from "../types";
import {
  Badge,
  Card,
  ChartSkeleton,
  type Column,
  EmptyState,
  PageHeader,
  QueryView,
  Segmented,
  Stat,
  StatGrid,
  Table,
  TableSkeleton,
} from "../ui";
import { JudgePanel } from "./FrustrationJudge";

export interface FrustrationRouteProps {
  active: boolean;
  range: TimeRange;
}

const RUNNING_POLL_MS = 1_000;
const MIN_MESSAGES = 50;
const MIN_JUDGED_SHARE = 0.5;
const ALL_CLASSES = "*";

export function FrustrationRoute({ active, range }: FrustrationRouteProps) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const stats = useQuery(["frustration", range], () => getFrustrationDashboardStats(range), {
    enabled: active,
    pollMs: running ? RUNNING_POLL_MS : undefined,
  });
  const meta = rangeMeta(range);

  const jobState = stats.data?.job.state;
  useEffect(() => {
    if (jobState !== undefined) setRunning(jobState === "running");
  }, [jobState]);

  const { refetch } = stats;
  const handleRunStarted = useCallback(() => {
    setRunning(true);
    refetch();
  }, [refetch]);

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.frustration.pageTitle")}
        description={t("settingsPage.stats.frustration.pageDescription", { window: meta.windowLabel })}
      />

      <QueryView query={stats} skeleton={<ChartSkeleton height={96} />}>
        {data => (
          <div data-stale={stats.stale}>
            <FrustrationSummary overall={data.overall} />
          </div>
        )}
      </QueryView>

      <QueryView query={stats} skeleton={<ChartSkeleton height={120} />}>
        {data => (
          <JudgePanel
            active={active}
            range={range}
            judgeAvailable={data.judgeAvailable}
            job={data.job}
            onRunStarted={handleRunStarted}
            onRunChanged={refetch}
          />
        )}
      </QueryView>

      <QueryView
        query={stats}
        skeleton={
          <Card index={2} title={t("settingsPage.stats.frustration.modelsCardTitle")}>
            <ChartSkeleton height={340} />
            <TableSkeleton rows={6} />
          </Card>
        }
      >
        {data => <FrustrationModelsSection models={data.byModel} stale={stats.stale} />}
      </QueryView>
    </div>
  );
}

function rate(part: number, whole: number): string {
  return whole > 0 ? formatPercent(part / whole) : "–";
}

function FrustrationSummary({ overall }: { overall: FrustrationCounts }) {
  const { t } = useTranslation();
  const regex = overall.messages - overall.judged;
  return (
    <StatGrid min={170}>
      <Stat
        label={t("settingsPage.stats.frustration.statMessages")}
        title={t("settingsPage.stats.frustration.statMessagesTitle")}
        value={formatInteger(overall.messages)}
      />
      <Stat
        label={t("settingsPage.stats.frustration.statJudgeCoverage")}
        title={t("settingsPage.stats.frustration.statJudgeCoverageTitle")}
        value={rate(overall.judged, overall.messages)}
        hint={t("settingsPage.stats.frustration.hintJudgedRegex", {
          judged: formatInteger(overall.judged),
          regex: formatInteger(regex),
        })}
      />
      <Stat
        label={t("settingsPage.stats.frustration.statAnnoyed")}
        title={t("settingsPage.stats.frustration.statAnnoyedTitle")}
        value={rate(overall.annoyed, overall.messages)}
        hint={t("settingsPage.stats.frustration.countMessages", { count: formatInteger(overall.annoyed) })}
      />
      <Stat
        label={t("settingsPage.stats.frustration.statAtAssistant")}
        title={t("settingsPage.stats.frustration.statAtAssistantTitle")}
        value={rate(overall.atAssistant, overall.messages)}
        hint={t("settingsPage.stats.frustration.countMessages", { count: formatInteger(overall.atAssistant) })}
      />
      <Stat
        label={t("settingsPage.stats.frustration.statAngry")}
        title={t("settingsPage.stats.frustration.statAngryTitle")}
        value={rate(overall.angry, overall.messages)}
        hint={t("settingsPage.stats.frustration.countMessages", { count: formatInteger(overall.angry) })}
      />
    </StatGrid>
  );
}

function familyKey(row: FrustrationModelStats): string {
  return `${row.modelClass}/${row.family ?? "unclassified"}`;
}

function isMostlyRegex(row: FrustrationModelStats): boolean {
  return row.messages > 0 && row.judged / row.messages < MIN_JUDGED_SHARE;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function assignFamilyColors(models: readonly FrustrationModelStats[]): Map<string, string> {
  const keys = [...new Set(models.map(familyKey))].sort();
  const taken = new Set<number>();
  const colors = new Map<string, string>();
  for (const key of keys) {
    let slot = hashString(key) % SERIES_COLORS.length;
    for (let probe = 0; probe < SERIES_COLORS.length && taken.has(slot); probe++) {
      slot = (slot + 1) % SERIES_COLORS.length;
    }
    taken.add(slot);
    colors.set(key, SERIES_COLORS[slot]);
  }
  return colors;
}

function layerColor(hue: string, layer: Layer): string {
  if (layer === "angry") return `color-mix(in srgb, ${hue} 55%, black)`;
  if (layer === "other") return `color-mix(in srgb, ${hue} 32%, transparent)`;
  return hue;
}

const LAYER_KEYS = ["angry", "assistant", "other"] as const;
type Layer = (typeof LAYER_KEYS)[number];

function layerCount(row: FrustrationModelStats, layer: Layer): number {
  if (layer === "angry") return row.angry;
  if (layer === "assistant") return row.atAssistant - row.angry;
  return row.annoyed - row.atAssistant;
}

function percent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

interface FamilyOption {
  key: string;
  label: string;
  messages: number;
}

function FrustrationModelsSection({ models, stale }: { models: FrustrationModelStats[]; stale: boolean }) {
  const { t } = useTranslation();
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [hiddenFamilies, toggleFamily] = useHiddenSeries();
  const [showSmall, setShowSmall] = useState(false);
  const [hideRegex, setHideRegex] = useState(false);

  const familyColors = useMemo(() => assignFamilyColors(models), [models]);

  const classes = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of models) totals.set(row.modelClass, (totals.get(row.modelClass) ?? 0) + row.messages);
    return totals;
  }, [models]);

  const defaultClass = useMemo(() => {
    let best: string | null = null;
    let bestMessages = -1;
    for (const [modelClass, messages] of classes) {
      if (messages > bestMessages) {
        best = modelClass;
        bestMessages = messages;
      }
    }
    return best ?? ALL_CLASSES;
  }, [classes]);

  const activeClass =
    selectedClass !== null && (selectedClass === ALL_CLASSES || classes.has(selectedClass))
      ? selectedClass
      : defaultClass;

  const classOptions = useMemo(
    () => [
      {
        value: ALL_CLASSES,
        label: t("settingsPage.stats.frustration.allOption"),
        title: t("settingsPage.stats.frustration.allOptionTitle"),
      },
      ...[...classes].map(([modelClass, messages]) => ({
        value: modelClass,
        label: modelClass,
        title: t("settingsPage.stats.frustration.countMessages", { count: formatInteger(messages) }),
      })),
    ],
    [classes, t],
  );

  const inClass = useMemo(
    () => (activeClass === ALL_CLASSES ? models : models.filter(row => row.modelClass === activeClass)),
    [models, activeClass],
  );

  const families = useMemo(() => {
    const byKey = new Map<string, FamilyOption>();
    for (const row of inClass) {
      const key = familyKey(row);
      const existing = byKey.get(key);
      if (existing) {
        existing.messages += row.messages;
        continue;
      }
      const family = row.family ?? t("settingsPage.stats.frustration.unclassifiedFamily");
      byKey.set(key, {
        key,
        label: activeClass === ALL_CLASSES ? `${row.modelClass} · ${family}` : family,
        messages: row.messages,
      });
    }
    return [...byKey.values()];
  }, [inClass, activeClass]);

  const visibleFamilies = useMemo(
    () => inClass.filter(row => !hiddenFamilies.has(familyKey(row))),
    [inClass, hiddenFamilies],
  );
  const smallCount = visibleFamilies.filter(row => row.messages < MIN_MESSAGES).length;
  const regexCount = visibleFamilies.filter(isMostlyRegex).length;
  const rows = useMemo(
    () =>
      visibleFamilies.filter(
        row => (showSmall || row.messages >= MIN_MESSAGES) && !(hideRegex && isMostlyRegex(row)),
      ),
    [visibleFamilies, showSmall, hideRegex],
  );

  if (models.length === 0) {
    return (
      <Card index={2} title={t("settingsPage.stats.frustration.modelsCardTitle")} stale={stale}>
        <EmptyState
          title={t("settingsPage.stats.frustration.emptyNoMessages")}
          hint={t("settingsPage.stats.frustration.emptyTryLonger")}
        />
      </Card>
    );
  }

  const hasRegexRows = rows.some(isMostlyRegex);

  return (
    <>
      <Card
        index={2}
        title={t("settingsPage.stats.frustration.modelsCardTitle")}
        description={t("settingsPage.stats.frustration.modelsCardDescription")}
        stale={stale}
      >
        <div className="stack frustration-chart-body">
          <div className="frustration-classes">
            <Segmented
              size="sm"
              aria-label={t("settingsPage.stats.frustration.modelClassLabel")}
              options={classOptions}
              value={activeClass}
              onChange={setSelectedClass}
            />
          </div>
          <div className="row frustration-filters">
            <Legend
              items={families.map(family => ({
                key: family.key,
                label: family.label,
                color: familyColors.get(family.key) ?? SERIES_COLORS[0],
                value: formatInteger(family.messages),
              }))}
              hidden={hiddenFamilies}
              onToggle={toggleFamily}
            />
            <span className="frustration-spacer" />
            <label
              className="check"
              title={t("settingsPage.stats.frustration.includeSmallTitle", { count: MIN_MESSAGES })}
            >
              <input type="checkbox" checked={showSmall} onChange={e => setShowSmall(e.target.checked)} />
              {t("settingsPage.stats.frustration.includeSmall", { count: MIN_MESSAGES })}
              {smallCount > 0 ? ` (${smallCount})` : ""}
            </label>
            <label
              className="check"
              title={t("settingsPage.stats.frustration.hideRegexTitle", { percent: MIN_JUDGED_SHARE * 100 })}
            >
              <input type="checkbox" checked={hideRegex} onChange={e => setHideRegex(e.target.checked)} />
              {t("settingsPage.stats.frustration.hideRegex")}
              {regexCount > 0 ? ` (${regexCount})` : ""}
            </label>
          </div>
          <EncodingKey hasRegexRows={hasRegexRows} />
          <FrustrationChart rows={rows} familyColors={familyColors} />
        </div>
      </Card>
      <FrustrationTable rows={rows} familyColors={familyColors} stale={stale} />
    </>
  );
}

function EncodingKey({ hasRegexRows }: { hasRegexRows: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="legend frustration-key">
      <span className="legend-item">
        <span className="swatch frustration-key-swatch" data-variant="angry" />
        {t("settingsPage.stats.frustration.layerAngry")}
      </span>
      <span className="legend-item">
        <span className="swatch frustration-key-swatch" data-variant="assistant" />
        {t("settingsPage.stats.frustration.keyAtAssistant")}
      </span>
      <span className="legend-item">
        <span className="swatch frustration-key-swatch" data-variant="other" />
        {t("settingsPage.stats.frustration.layerOther")}
      </span>
      <span className="legend-item">
        <span className="frustration-key-line" />
        {t("settingsPage.stats.frustration.keyAtAssistantTrend")}
      </span>
      <span
        className="legend-item frustration-key-wide"
        title={t("settingsPage.stats.frustration.hatchedTitle", { percent: MIN_JUDGED_SHARE * 100 })}
      >
        <span className="swatch frustration-key-swatch" data-variant="hatch" />
        {t("settingsPage.stats.frustration.hatchedNote", {
          suffix: hasRegexRows ? t("settingsPage.stats.frustration.hatchedSuffix") : "",
        })}
      </span>
      <span className="legend-item dim">{t("settingsPage.stats.frustration.hueNote")}</span>
    </div>
  );
}

function FrustrationChart({
  rows,
  familyColors,
}: {
  rows: FrustrationModelStats[];
  familyColors: Map<string, string>;
}) {
  const { t } = useTranslation();
  const layerLabels: Record<Layer, string> = {
    angry: t("settingsPage.stats.frustration.layerAngry"),
    assistant: t("settingsPage.stats.frustration.layerAssistant"),
    other: t("settingsPage.stats.frustration.layerOther"),
  };
  const series = useMemo((): ChartSeries[] => {
    const groups = new Map<string, { family: string; regex: boolean; slots: number[] }>();
    rows.forEach((row, i) => {
      const family = familyKey(row);
      const regex = isMostlyRegex(row);
      const id = `${family}|${regex ? "regex" : "judged"}`;
      const group = groups.get(id);
      if (group) group.slots.push(i);
      else groups.set(id, { family, regex, slots: [i] });
    });
    const out: ChartSeries[] = [];
    for (const layer of LAYER_KEYS) {
      for (const [id, group] of groups) {
        const values: (number | null)[] = rows.map(() => null);
        for (const i of group.slots) values[i] = percent(layerCount(rows[i], layer), rows[i].messages);
        out.push({
          key: `${layer}|${id}`,
          label: layerLabels[layer],
          color: layerColor(familyColors.get(group.family) ?? SERIES_COLORS[0], layer),
          values,
          pattern: group.regex ? "hatch" : undefined,
        });
      }
    }
    out.push({
      key: "trend",
      label: t("settingsPage.stats.frustration.trendLabel"),
      color: "var(--ink-1)",
      values: rows.map(row => percent(row.atAssistant, row.messages)),
      kind: "line",
      tooltip: false,
    });
    return out;
  }, [rows, familyColors, layerLabels, t]);

  if (rows.length === 0) {
    return (
      <div className="frustration-chart-empty">
        <EmptyState title={t("settingsPage.stats.frustration.emptyNoMatch")} />
      </div>
    );
  }

  return (
    <Chart
      slots={rows.length}
      tickLabel={i => rows[i].label}
      series={series}
      height={340}
      format={v => `${v}%`}
      formatTooltip={v => `${v.toFixed(1)}%`}
      showTotal={false}
      emptyLabel={t("settingsPage.stats.frustration.chartEmpty")}
      tooltipExtra={i => {
        const row = rows[i];
        return (
          <div className="frustration-tooltip-extra">
            <div className="chart-tooltip-row chart-tooltip-total">
              <span className="chart-tooltip-label">{t("settingsPage.stats.frustration.tooltipAnnoyed")}</span>
              <span className="chart-tooltip-value">{rate(row.annoyed, row.messages)}</span>
            </div>
            <div className="micro dim">
              {t("settingsPage.stats.frustration.tooltipMeta", {
                messages: formatInteger(row.messages),
                judged: formatInteger(row.judged),
                judgedRate: rate(row.judged, row.messages),
                fallback: isMostlyRegex(row) ? t("settingsPage.stats.frustration.tooltipFallback") : "",
              })}
            </div>
          </div>
        );
      }}
    />
  );
}

function FrustrationTable({
  rows,
  familyColors,
  stale,
}: {
  rows: FrustrationModelStats[];
  familyColors: Map<string, string>;
  stale: boolean;
}) {
  const { t } = useTranslation();
  const columns = useMemo(
    (): Column<FrustrationModelStats>[] => [
      {
        key: "model",
        header: t("settingsPage.stats.frustration.colModel"),
        sort: row => row.label,
        render: row => (
          <span className="row" title={row.key}>
            <span
              className="swatch"
              style={{ background: familyColors.get(familyKey(row)) ?? SERIES_COLORS[0] }}
            />
            <span className="cell-primary">{row.label}</span>
          </span>
        ),
      },
      {
        key: "ids",
        header: t("settingsPage.stats.frustration.colModelIds"),
        wrap: true,
        render: row => <span className="mono micro dim">{row.models.join(", ")}</span>,
      },
      {
        key: "messages",
        header: t("settingsPage.stats.frustration.colMessages"),
        align: "right",
        sort: row => row.messages,
        render: row => <span className="num">{formatInteger(row.messages)}</span>,
      },
      {
        key: "judged",
        header: t("settingsPage.stats.frustration.colJudged"),
        align: "right",
        sort: row => (row.messages > 0 ? row.judged / row.messages : 0),
        render: row =>
          isMostlyRegex(row) ? (
            <span
              className="row frustration-judged"
              title={t("settingsPage.stats.frustration.regexBadgeTitle")}
            >
              <Badge tone="warn">{t("settingsPage.stats.frustration.badgeRegex")}</Badge>
              <span className="num dim">{rate(row.judged, row.messages)}</span>
            </span>
          ) : (
            <span className="num">{rate(row.judged, row.messages)}</span>
          ),
      },
      {
        key: "annoyed",
        header: t("settingsPage.stats.frustration.colAnnoyed"),
        align: "right",
        sort: row => percent(row.annoyed, row.messages),
        render: row => (
          <span className="num" title={t("settingsPage.stats.frustration.countMessages", { count: formatInteger(row.annoyed) })}>
            {rate(row.annoyed, row.messages)}
          </span>
        ),
      },
      {
        key: "atAssistant",
        header: t("settingsPage.stats.frustration.colAtAssistant"),
        align: "right",
        sort: row => percent(row.atAssistant, row.messages),
        render: row => (
          <span className="num" title={t("settingsPage.stats.frustration.countMessages", { count: formatInteger(row.atAssistant) })}>
            {rate(row.atAssistant, row.messages)}
          </span>
        ),
      },
      {
        key: "angry",
        header: t("settingsPage.stats.frustration.colAngry"),
        align: "right",
        sort: row => percent(row.angry, row.messages),
        render: row => (
          <span className={row.angry > 0 ? "num tone-bad" : "num"} title={t("settingsPage.stats.frustration.countMessages", { count: formatInteger(row.angry) })}>
            {rate(row.angry, row.messages)}
          </span>
        ),
      },
    ],
    [familyColors, t],
  );

  return (
    <Card
      index={3}
      title={t("settingsPage.stats.frustration.tableTitle")}
      description={t("settingsPage.stats.frustration.tableDescription")}
      flush
      stale={stale}
    >
      <Table
        rows={rows}
        rowKey={row => row.key}
        columns={columns}
        dense
        empty={<EmptyState title={t("settingsPage.stats.frustration.emptyNoMatch")} />}
      />
    </Card>
  );
}
