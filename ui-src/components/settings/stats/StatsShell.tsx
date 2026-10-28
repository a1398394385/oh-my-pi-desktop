import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { rangeMeta, TIME_RANGES } from "./data/range";
import { LiveChip } from "./LiveChip";
import { type DashboardSection, useNav } from "./nav";
import {
  AcpRoute,
  CostsRoute,
  ErrorsRoute,
  FrustrationRoute,
  GainRoute,
  ModelsRoute,
  OverviewRoute,
  ProjectsRoute,
  ProvidersRoute,
  RequestsRoute,
  ToolsRoute,
  TracesRoute,
} from "./routes";
import type { TimeRange } from "./types";
import { RequestDrawer, Segmented } from "./ui";

export function StatsShell() {
  const { t } = useTranslation();
  const nav = useNav();
  const rangeOptions = useMemo(
    () =>
      TIME_RANGES.map((range, i) => ({
        value: range,
        label: rangeMeta(range).label,
        title: `${rangeMeta(range).windowLabel} (${i + 1})`,
      })),
    [],
  );
  const [section, setSection] = useState<DashboardSection>("overview");
  const [range, setRange] = useState<TimeRange>("7d");
  const [session, setSession] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);

  const closeDrawer = useCallback(() => setSelectedRequestId(null), []);

  // The request drawer jumps into the trace view of the same session; without
  // switching the section the trace view would stay unmounted.
  const openTrace = useCallback((sessionFile: string) => {
    setSession(sessionFile);
    setSection("traces");
  }, []);

  const mounted = useRef(new Set<DashboardSection>());
  mounted.current.add(section);

  const handleNavigate = useCallback((target: string) => {
    const valid = nav.flatMap(g => g.items).some(i => i.id === target);
    if (valid) {
      setSection(target as DashboardSection);
    }
  }, [nav]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) return;
      // Number keys pick the time range; the range chip's tooltip shows the index.
      const rangeIndex = Number(e.key) - 1;
      if (rangeIndex >= 0 && rangeIndex < TIME_RANGES.length) {
        e.preventDefault();
        setRange(TIME_RANGES[rangeIndex]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderRoute = (target: DashboardSection) => {
    const active = target === section;
    switch (target) {
      case "overview":
        return (
          <OverviewRoute
            active={active}
            range={range}
            onRequestClick={setSelectedRequestId}
            onNavigate={handleNavigate}
          />
        );
      case "requests":
        return <RequestsRoute active={active} range={range} onRequestClick={setSelectedRequestId} />;
      case "errors":
        return <ErrorsRoute active={active} range={range} onRequestClick={setSelectedRequestId} />;
      case "traces":
        return <TracesRoute active={active} session={session} onOpenSession={setSession} />;
      case "models":
        return <ModelsRoute active={active} range={range} />;
      case "providers":
        return <ProvidersRoute active={active} range={range} />;
      case "costs":
        return <CostsRoute active={active} range={range} />;
      case "tools":
        return <ToolsRoute active={active} range={range} />;
      case "frustration":
        return <FrustrationRoute active={active} range={range} />;
      case "projects":
        return <ProjectsRoute active={active} range={range} />;
      case "gain":
        return <GainRoute active={active} range={range} />;
      case "acp":
        return <AcpRoute active={active} range={range} />;
    }
  };

  return (
    <div className="stats-container">
      <div className="stats-top-actions">
        <div className="stats-range-row">
          <Segmented
            options={rangeOptions}
            value={range}
            onChange={setRange}
            aria-label={t("settingsPage.stats.shell.timeRange")}
            size="sm"
          />
          <LiveChip />
        </div>
      </div>

      <div className="stats-layout">
        <aside className="stats-nav" aria-label={t("settingsPage.stats.shell.navSections")}>
          {nav.map(group => (
            <div key={group.heading} className="stats-nav-group">
              <div className="stats-nav-heading">{group.heading}</div>
              {group.items.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`stats-nav-item ${item.id === section ? "on" : ""}`}
                  onClick={() => setSection(item.id)}
                >
                  <item.icon size={15} className="stats-nav-icon" />
                  <span className="stats-nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="stats-main-panel">
          {[...mounted.current].map(target => (
            <div key={target} hidden={target !== section} className="stats-route-container">
              {renderRoute(target)}
            </div>
          ))}
        </section>
      </div>

      <RequestDrawer id={selectedRequestId} onClose={closeDrawer} onOpenSession={openTrace} />
    </div>
  );
}
