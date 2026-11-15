/**
 * What the cut cost in agent time: how much of the experiment sessions' model
 * time went into requests that only fetched cut output back, and how much wall
 * time tool calls spent shaping. Answers whether the added turns matter next to
 * the sessions' total request time.
 */
import { useTranslation } from "react-i18next";
import { formatElapsed, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats } from "../types";
import { Card, EmptyState, Stat, StatGrid } from "../ui";
import { formatShare } from "./meta";

export function TimeCost({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
  const { t } = useTranslation();
  const row = stats.timeCost;
  // Recompute instead of trusting `row.share`: it is null until the backend has
  // an agent time to divide by, and the two component shares need the same guard.
  const share = row.agentMs > 0 ? (row.fetchBackMs + row.shapeMs) / row.agentMs : null;
  const fetchShare = row.agentMs > 0 ? row.fetchBackMs / row.agentMs : null;
  const shapeShare = row.agentMs > 0 ? row.shapeMs / row.agentMs : null;

  return (
    <Card
      title={t("settingsPage.stats.spotlight.timeCost.title")}
      description={t("settingsPage.stats.spotlight.timeCost.description")}
      footer={t("settingsPage.stats.spotlight.timeCost.footer")}
      stale={stale}
    >
      {!(row.agentMs > 0) ? (
        <EmptyState title={t("settingsPage.stats.spotlight.timeCost.empty")} />
      ) : (
        <StatGrid>
          <Stat
            label={t("settingsPage.stats.spotlight.timeCost.modelTime")}
            value={formatElapsed(row.agentMs)}
            hint={t("settingsPage.stats.spotlight.timeCost.modelTimeHint")}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.timeCost.fetchBackMs")}
            value={formatElapsed(row.fetchBackMs)}
            hint={t("settingsPage.stats.spotlight.timeCost.shareOfModelTime", { share: formatShare(fetchShare) })}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.timeCost.fetchBackTurns")}
            value={formatInteger(row.fetchBackTurns)}
            hint={t("settingsPage.stats.spotlight.timeCost.fetchBackTurnsHint")}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.timeCost.shapeMs")}
            value={formatElapsed(row.shapeMs)}
            hint={t("settingsPage.stats.spotlight.timeCost.shareOfModelTime", { share: formatShare(shapeShare) })}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.timeCost.share")}
            value={formatShare(share)}
            hint={t("settingsPage.stats.spotlight.timeCost.shareHint")}
          />
        </StatGrid>
      )}
    </Card>
  );
}
