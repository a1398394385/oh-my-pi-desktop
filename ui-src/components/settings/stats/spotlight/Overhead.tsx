/**
 * What shaping costs besides tokens: Spotlight's failures and the time tool
 * calls waited on them, the latency shaping adds to a call, and Spotlight's own
 * request time and bill. A failed call leaves the cut to the no-score fallback,
 * so a high failure rate means the page's comparisons partly measure fallback.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BarList } from "../charts";
import { formatCost, formatDurationMs, formatElapsed, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats, SpotlightOverhead } from "../types";
import { Badge, Card, EmptyState, errorRateTone, Stat, StatGrid } from "../ui";
import { formatShare } from "./meta";

/** p50 with p90 beside it, dim; `–` when there is no sample. */
function Percentiles({ p50, p90 }: { p50: number | null; p90: number | null }): ReactNode {
  if (p50 === null || !Number.isFinite(p50)) return "–";
  return (
    <span>
      {formatDurationMs(p50)}
      <span className="dim"> / {p90 === null ? "–" : formatDurationMs(p90)}</span>
    </span>
  );
}

export function Overhead({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
  const { t } = useTranslation();
  const overhead: SpotlightOverhead = stats.overhead;
  const rate = overhead.failureRate;
  const tone = rate === null ? "ok" : errorRateTone(rate);
  const waitedMs = Number.isFinite(overhead.failedWaitMs) ? overhead.failedWaitMs : 0;
  const unsigned = overhead.failureCauses.find(cause => cause.cause === "no_credential");
  const causes = overhead.failureCauses.filter(cause => cause.results > 0);

  // Codes whose words don't read well; any other code shows its own words.
  const causeLabel = (cause: string): string => {
    const http = /^http_(\d+)$/.exec(cause);
    if (http) return t("settingsPage.stats.spotlight.overhead.cause.http", { status: http[1] });
    if (cause === "no_credential") return t("settingsPage.stats.spotlight.overhead.cause.noCredential");
    if (cause === "transport") return t("settingsPage.stats.spotlight.overhead.cause.transport");
    return cause.replaceAll("_", " ");
  };

  return (
    <Card
      title={t("settingsPage.stats.spotlight.overhead.title")}
      description={t("settingsPage.stats.spotlight.overhead.description")}
      footer={t("settingsPage.stats.spotlight.overhead.footer")}
      stale={stale}
    >
      {!(overhead.results > 0) ? (
        <EmptyState title={t("settingsPage.stats.spotlight.overhead.empty")} />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <StatGrid>
            <Stat
              label={t("settingsPage.stats.spotlight.overhead.results")}
              value={formatInteger(overhead.results)}
              hint={t("settingsPage.stats.spotlight.overhead.resultsHint")}
            />
            <Stat
              label={t("settingsPage.stats.spotlight.overhead.failures")}
              value={
                rate === null ? (
                  "–"
                ) : (
                  <Badge tone={errorRateTone(rate)} mono>
                    {formatShare(rate)}
                  </Badge>
                )
              }
              hint={t("settingsPage.stats.spotlight.overhead.failuresHint")}
            />
            <Stat
              label={t("settingsPage.stats.spotlight.overhead.failedWait")}
              value={waitedMs > 0 ? formatElapsed(waitedMs) : "–"}
              hint={t("settingsPage.stats.spotlight.overhead.failedWaitHint")}
            />
            <Stat
              label={t("settingsPage.stats.spotlight.overhead.shapeLatency")}
              value={<Percentiles p50={overhead.shapeMsP50} p90={overhead.shapeMsP90} />}
              hint={t("settingsPage.stats.spotlight.overhead.shapeLatencyHint")}
            />
            <Stat
              label={t("settingsPage.stats.spotlight.overhead.spotlightLatency")}
              value={<Percentiles p50={overhead.spotlightMsP50} p90={overhead.spotlightMsP90} />}
              hint={t("settingsPage.stats.spotlight.overhead.spotlightLatencyHint")}
            />
            <Stat
              label={t("settingsPage.stats.spotlight.overhead.usd")}
              value={Number.isFinite(overhead.spotlightUsd) ? formatCost(overhead.spotlightUsd) : "–"}
              hint={t("settingsPage.stats.spotlight.overhead.usdHint")}
            />
          </StatGrid>

          {causes.length > 0 && (
            <div>
              <div className="section-label" title={t("settingsPage.stats.spotlight.overhead.causesHint")}>
                {t("settingsPage.stats.spotlight.overhead.causes")}
              </div>
              <BarList
                items={causes.map(cause => ({
                  key: cause.cause,
                  label: (
                    <span
                      title={t("settingsPage.stats.spotlight.overhead.causeResults", {
                        count: formatInteger(cause.results),
                      })}
                    >
                      {causeLabel(cause.cause)}
                    </span>
                  ),
                  value: cause.share,
                  display: formatShare(cause.share),
                  color: "var(--bad)",
                }))}
              />
            </div>
          )}

          {rate !== null && tone !== "ok" && (
            <p className={`micro tone-${tone}`} role="note">
              {t("settingsPage.stats.spotlight.overhead.callout.head", { share: formatShare(rate) })}{" "}
              {t("settingsPage.stats.spotlight.overhead.callout.body")}
              {waitedMs > 0 &&
                ` ${t("settingsPage.stats.spotlight.overhead.callout.waited", { elapsed: formatElapsed(waitedMs) })}`}
              {unsigned !== undefined &&
                ` ${t("settingsPage.stats.spotlight.overhead.callout.noCredential", {
                  share: formatShare(unsigned.share),
                })}`}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
