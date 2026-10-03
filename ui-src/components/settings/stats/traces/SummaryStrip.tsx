import { useTranslation } from "react-i18next";
import { formatCompact, formatElapsed, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import type { TraceSummary } from "../types";
import { Stat, StatGrid } from "../ui";

export interface SummaryStripProps {
  summary: TraceSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
  const { t } = useTranslation();
  return (
    <StatGrid min={112}>
      <Stat size="sm" label={t("settingsPage.stats.traceView.summary.wallTime")} value={formatElapsed(summary.wallMs)} />
      <Stat
        size="sm"
        label={t("settingsPage.stats.traceView.summary.modelTime")}
        value={formatElapsed(summary.modelMs)}
        hint={
          summary.wallMs > 0
            ? t("settingsPage.stats.traceView.summary.ofWall", { share: formatPercent(summary.modelMs / summary.wallMs) })
            : undefined
        }
      />
      <Stat
        size="sm"
        label={t("settingsPage.stats.traceView.summary.toolTime")}
        value={formatElapsed(summary.toolMs)}
        hint={
          summary.wallMs > 0
            ? t("settingsPage.stats.traceView.summary.ofWall", { share: formatPercent(summary.toolMs / summary.wallMs) })
            : undefined
        }
      />
      <Stat
        size="sm"
        label={t("settingsPage.stats.traceView.summary.idle")}
        value={formatElapsed(summary.idleMs)}
        hint={
          summary.wallMs > 0
            ? t("settingsPage.stats.traceView.summary.ofWall", { share: formatPercent(summary.idleMs / summary.wallMs) })
            : undefined
        }
      />
      <Stat size="sm" label={t("settingsPage.stats.traceView.summary.turns")} value={formatInteger(summary.turns)} />
      <Stat
        size="sm"
        label={t("settingsPage.stats.traceView.summary.requests")}
        value={formatInteger(summary.requests)}
        hint={t("settingsPage.stats.traceView.summary.toolCalls", { count: summary.toolCalls })}
      />
      <Stat size="sm" label={t("settingsPage.stats.traceView.summary.agents")} value={formatInteger(summary.subagents)} />
      <Stat size="sm" label={t("settingsPage.stats.traceView.summary.tokens")} value={formatCompact(summary.totalTokens)} />
      <Stat size="sm" label={t("settingsPage.stats.traceView.summary.cost")} value={formatEstimatedCost(summary.costTotal, summary.unpricedRequests)} />
    </StatGrid>
  );
}
