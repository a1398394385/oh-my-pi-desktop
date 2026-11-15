/**
 * Spotlight's headline answer: what the experiment saved against `plain`, in
 * tokens and dollars, the sample that claim rests on, and the two caveats that
 * qualify it (the plain baseline and tools whose holdout baseline is thin).
 */
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats } from "../types";
import { Card, Stat, StatGrid } from "../ui";
import { foldTools, formatInterval, formatShare, formatSignedCompact, formatSignedCost } from "./meta";

export interface SpotlightHeroProps {
  stats: SpotlightDashboardStats;
  /** Prose window ("the last 7 days"). */
  windowLabel: string;
  stale: boolean;
}

export function SpotlightHero({ stats, windowLabel, stale }: SpotlightHeroProps) {
  const { t } = useTranslation();
  const { gross, clawback, adjusted } = stats;
  const net = adjusted.netTokens.value;
  const netUsd = adjusted.netUsd.value;
  const tokenInterval = formatInterval(adjusted.netTokens, formatSignedCompact);
  const usdInterval = formatInterval(adjusted.netUsd, formatSignedCost);
  const excessInterval = formatInterval(adjusted.excessTokens, formatCompact);
  // A tool's baseline only matters when it has cuts to adjust.
  const thin = adjusted.byTool
    .filter((row) => row.cuts > 0 && row.holdouts < adjusted.minHoldouts)
    .map((row) => row.tool);
  const thinFold = foldTools(thin);
  const thinNames =
    thinFold.rest.length > 0
      ? [...thinFold.listed, t("settingsPage.stats.spotlight.hero.moreTools", { count: thinFold.rest.length })]
      : thin;
  const overstated = gross.fullSavedTokens > 0 ? 1 - gross.savedTokens / gross.fullSavedTokens : null;

  return (
    <Card stale={stale}>
      <div className="grid">
        <StatGrid min={170}>
          <Stat
            label={t("settingsPage.stats.spotlight.hero.netSaved", { window: windowLabel })}
            title={t("settingsPage.stats.spotlight.hero.netSavedTitle")}
            value={net === null ? "–" : formatSignedCompact(net)}
            hint={
              tokenInterval === ""
                ? t("settingsPage.stats.spotlight.hero.intervalPending")
                : t("settingsPage.stats.spotlight.hero.interval", { interval: tokenInterval })
            }
          />
          <Stat
            label={t("settingsPage.stats.spotlight.hero.netUsd")}
            title={t("settingsPage.stats.spotlight.hero.netUsdTitle")}
            value={netUsd === null ? "–" : formatSignedCost(netUsd)}
            hint={
              usdInterval === ""
                ? t("settingsPage.stats.spotlight.hero.intervalPending")
                : t("settingsPage.stats.spotlight.hero.interval", { interval: usdInterval })
            }
          />
          <Stat
            label={t("settingsPage.stats.spotlight.hero.gross")}
            title={t("settingsPage.stats.spotlight.hero.grossTitle")}
            value={formatSignedCompact(gross.savedTokens)}
            hint={t("settingsPage.stats.spotlight.hero.grossHint", {
              share: formatShare(gross.ofToolOutput),
              shaped: formatInteger(gross.shaped),
              results: formatInteger(gross.results),
            })}
          />
          <Stat
            label={t("settingsPage.stats.spotlight.hero.excess")}
            title={t("settingsPage.stats.spotlight.hero.excessTitle")}
            value={adjusted.excessTokens.value === null ? "–" : formatSignedCompact(-adjusted.excessTokens.value)}
            hint={
              <>
                {t("settingsPage.stats.spotlight.hero.excessHint", { tokens: formatCompact(clawback.tokens) })}
                {excessInterval !== "" &&
                  ` · ${t("settingsPage.stats.spotlight.hero.excessInterval", { interval: excessInterval })}`}
              </>
            }
          />
          <Stat
            label={t("settingsPage.stats.spotlight.hero.sessions")}
            title={t("settingsPage.stats.spotlight.hero.sessionsTitle")}
            value={formatInteger(stats.sessions)}
            hint={t("settingsPage.stats.spotlight.hero.sessionsHint", {
              holdouts: formatInteger(stats.holdouts),
              scoreFree: formatInteger(stats.scoreFree),
            })}
          />
        </StatGrid>

        <div className="grid">
          <p className="card-description">
            {t("settingsPage.stats.spotlight.hero.plainNote")}
            {gross.fullSavedTokens > gross.savedTokens && (
              <>
                {" "}
                {t("settingsPage.stats.spotlight.hero.overstateLead")}{" "}
                <s className="mono">{formatCompact(gross.fullSavedTokens)}</s>
                {t("settingsPage.stats.spotlight.hero.overstateTail", { share: formatShare(overstated) })}
              </>
            )}
          </p>
          {gross.widerThanPlain > 0 && (
            <p className="card-description">
              {t("settingsPage.stats.spotlight.hero.widerNote", { results: formatInteger(gross.widerThanPlain) })}
            </p>
          )}
          {gross.estimatedPlain > 0 && (
            <p className="card-description">
              {t("settingsPage.stats.spotlight.hero.estimatedNote", { results: formatInteger(gross.estimatedPlain) })}
            </p>
          )}
          {thin.length > 0 && (
            <p className="card-description row" role="note">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                {t("settingsPage.stats.spotlight.hero.thinWarning", {
                  tools: thinNames.join(", "),
                  min: formatInteger(adjusted.minHoldouts),
                })}
              </span>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
