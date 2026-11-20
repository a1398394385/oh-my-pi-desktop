// Subagent page: the deck's crew list — pane head (crew count, grouping/density, fullscreen),
// aggregate pulse line, status pills, then the cards. A card click swaps the list for that
// child's sheet; the sheet's close button returns here.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { useAppStore, setBump } from "../../../store";
import { HubRow, HubUsage, StatusTabs, useRosterRows, useRosterTick, treeDepth } from "../../shared/agent/subRoster";
import AgentSheet from "../../shared/agent/AgentSheet";

export default function SubagentPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const selectedSubagent = useAppStore((st) => st.selectedSubagent);
  const density = useAppStore((st) => st.hubDensity);
  const grouping = useAppStore((st) => st.hubGrouping);
  // Crew/comms view switch. Comms has no host channel yet: the tab renders a placeholder.
  const [view, setView] = useState<"crew" | "comms">("crew");
  // Detail view hides the roster, whose tick would otherwise repaint the whole page every
  // second next to the detail's own clock.
  useRosterTick(selectedSubagent ? undefined : s);
  const rows = useRosterRows(s);
  if (!s || s.subagents.size === 0) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noSubagents")}</div>;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    return (
      <div className="rb-scroll">
        <AgentSheet
          sub={s.subagents.get(selectedSubagent)!} // the has() above guarantees presence
          subagentId={selectedSubagent}
          sessionId={s.sessionId}
          onClose={() => setBump({ selectedSubagent: null })}
        />
      </div>
    );
  }
  return (
    <>
      <div className="hub-pulse">
        <HubUsage s={s} />
      </div>
      <div className="ad-pane-head">
        <span className="ad-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "crew"}
            className={"ad-tab" + (view === "crew" ? " active" : "")}
            onClick={() => setView("crew")}
          >
            {t("right.adCrew")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "comms"}
            className={"ad-tab" + (view === "comms" ? " active" : "")}
            onClick={() => setView("comms")}
          >
            {t("right.adComms")}
          </button>
        </span>
        <span className="ad-seg" role="group" aria-label={t("right.adGrouping")}>
          <button
            type="button"
            className={grouping === "tree" ? "active" : ""}
            aria-pressed={grouping === "tree"}
            title={t("right.adGroupingTree")}
            onClick={() => useAppStore.getState().setHubGrouping("tree")}
          >
            <Icon name="tree" size={13} />
          </button>
          <button
            type="button"
            className={grouping === "status" ? "active" : ""}
            aria-pressed={grouping === "status"}
            title={t("right.adGroupingStatus")}
            onClick={() => useAppStore.getState().setHubGrouping("status")}
          >
            <Icon name="list" size={13} />
          </button>
        </span>
        <span className="ad-seg" role="group" aria-label={t("right.adDensity")}>
          <button
            type="button"
            className={density === "standard" ? "active" : ""}
            aria-pressed={density === "standard"}
            title={t("right.adDensityStandard")}
            onClick={() => useAppStore.getState().setHubDensity("standard")}
          >
            <Icon name="list" size={13} />
          </button>
          <button
            type="button"
            className={density === "minimal" ? "active" : ""}
            aria-pressed={density === "minimal"}
            title={t("right.adDensityMinimal")}
            onClick={() => useAppStore.getState().setHubDensity("minimal")}
          >
            <Icon name="sort" size={13} />
          </button>
        </span>
        <button type="button" className="hub-ibtn" title={t("right.adFullscreen")} aria-label={t("right.adFullscreen")} onClick={() => useAppStore.getState().openHub()}>
          <Icon name="externalOpen" size={14} />
        </button>
      </div>
      {view === "comms" ? (
        <div className="hub-comms-soon">{t("right.adCommsSoon")}</div>
      ) : (
        <>
          <div className="hub-filter">
            <StatusTabs s={s} />
          </div>
          <div className="hub-list" role="listbox">
            {rows.map((row) => {
              // Tree grouping indents by ancestry depth, so a subagent's subagent nests further
              const depth = grouping === "tree" ? treeDepth(rows, row) : 0;
              return (
                <div key={row.id} style={depth ? { paddingLeft: depth * 14 } : undefined}>
                  <HubRow
                    row={row}
                    selected={false}
                    minimal={density === "minimal"}
                    onSelect={() => setBump({ selectedSubagent: row.id })}
                    onOpen={() => setBump({ selectedSubagent: row.id })}
                    t={t}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
