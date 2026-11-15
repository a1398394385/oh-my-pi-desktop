import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getSpotlightDashboardStats } from "../api";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { Compounding } from "../spotlight/Compounding";
import { Coverage } from "../spotlight/Coverage";
import { Economics } from "../spotlight/Economics";
import { FetchBack, FetchBackGaps } from "../spotlight/FetchBack";
import { SpotlightHero } from "../spotlight/Hero";
import { Overhead } from "../spotlight/Overhead";
import { Ranking } from "../spotlight/Ranking";
import { ResultsFeed } from "../spotlight/ResultsFeed";
import { SavingsOverTime, WhereSavingsWent } from "../spotlight/Savings";
import { ShareTrend } from "../spotlight/ShareTrend";
import { Steps } from "../spotlight/Steps";
import { TimeCost } from "../spotlight/TimeCost";
import type { SpotlightAgentScope, TimeRange } from "../types";
import { Card, ChartSkeleton, EmptyState, PageHeader, QueryView, Segmented } from "../ui";

export interface SpotlightRouteProps {
  active: boolean;
  range: TimeRange;
}

/**
 * The experiment's own dashboard: what shaping tool output saved against what pi
 * would have shown unshaped, what it cost, whether Spotlight's heat is doing the
 * work, and where to tune it.
 *
 * Every experiment session shapes, subagents included; the scope switch keeps
 * their very different workloads apart.
 */
export function SpotlightRoute({ active, range }: SpotlightRouteProps) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<SpotlightAgentScope>("all");
  const stats = useQuery(
    ["spotlight", range, agent],
    ({ signal }) => getSpotlightDashboardStats(range, agent, signal),
    { enabled: active },
  );
  const meta = rangeMeta(range);
  const experimentStart = stats.data?.experimentStart ?? null;

  const agentOptions = [
    { value: "all" as const, label: t("settingsPage.stats.spotlight.scope.all"), title: t("settingsPage.stats.spotlight.scope.allHint") },
    { value: "main" as const, label: t("settingsPage.stats.spotlight.scope.main"), title: t("settingsPage.stats.spotlight.scope.mainHint") },
    {
      value: "subagent" as const,
      label: t("settingsPage.stats.spotlight.scope.subagent"),
      title: t("settingsPage.stats.spotlight.scope.subagentHint"),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t("settingsPage.stats.spotlight.title")}
        description={t("settingsPage.stats.spotlight.description", { window: meta.windowLabel })}
        actions={<Segmented aria-label={t("settingsPage.stats.spotlight.scope.label")} options={agentOptions} value={agent} onChange={setAgent} />}
      />

      <QueryView
        query={stats}
        skeleton={<ChartSkeleton height={220} />}
        isEmpty={data => data.sessions === 0 && data.recent.length === 0}
        empty={
          <Card>
            <EmptyState
              title={
                experimentStart === null
                  ? t("settingsPage.stats.spotlight.empty.notRun")
                  : t("settingsPage.stats.spotlight.empty.noSessions", { window: meta.windowLabel })
              }
              hint={
                experimentStart === null
                  ? t("settingsPage.stats.spotlight.empty.enableHint")
                  : t("settingsPage.stats.spotlight.empty.longerRange")
              }
            />
          </Card>
        }
      >
        {data => (
          <>
            <SpotlightHero stats={data} windowLabel={meta.windowLabel} stale={stats.stale} />

            <Section id="spot-saved" title={t("settingsPage.stats.spotlight.section.saved")} hint={t("settingsPage.stats.spotlight.section.savedHint")}>
              <div className="grid-3">
                <SavingsOverTime stats={data} range={range} stale={stats.stale} />
                <WhereSavingsWent stats={data} stale={stats.stale} />
              </div>
              <Compounding stats={data} active={active} stale={stats.stale} />
              <ShareTrend stats={data} range={range} stale={stats.stale} />
            </Section>

            <Section id="spot-cost" title={t("settingsPage.stats.spotlight.section.cost")} hint={t("settingsPage.stats.spotlight.section.costHint")}>
              <TimeCost stats={data} stale={stats.stale} />
              <Overhead stats={data} stale={stats.stale} />
            </Section>

            <Section id="spot-work" title={t("settingsPage.stats.spotlight.section.work")} hint={t("settingsPage.stats.spotlight.section.workHint")}>
              <Ranking stats={data} stale={stats.stale} />
              <FetchBack stats={data} stale={stats.stale} />
              <FetchBackGaps stats={data} stale={stats.stale} />
            </Section>

            <Section id="spot-tune" title={t("settingsPage.stats.spotlight.section.tune")} hint={t("settingsPage.stats.spotlight.section.tuneHint")}>
              <Steps stats={data} stale={stats.stale} />
              <Economics stats={data} stale={stats.stale} />
              <Coverage stats={data} stale={stats.stale} />
              <ResultsFeed rows={data.recent} stale={stats.stale} />
            </Section>
          </>
        )}
      </QueryView>
    </div>
  );
}

interface SectionProps {
  id: string;
  title: string;
  hint: string;
  children: ReactNode;
}

/** One of the page's four questions; each heading opens the cards that answer it. */
function Section({ id, title, hint, children }: SectionProps) {
  return (
    <section className="grid-3" id={id} aria-label={title}>
      <div className="section-label">
        <h2 className="card-title">{title}</h2>
        <p className="card-description">{hint}</p>
      </div>
      {children}
    </section>
  );
}
