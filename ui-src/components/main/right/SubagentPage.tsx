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
  const density = useAppStore((st) => st.deckDensity);
  const grouping = useAppStore((st) => st.deckGrouping);
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
        {/* Grouping toggle: one icon button whose icon names the TARGET mode — the same
            in-place-switch convention and icon pair (orgChart/sort) as the hub's headerbar
            toggle, parked where the old two-button segment sat. */}
        <button
          type="button"
          className="hub-ibtn"
          title={grouping === "tree" ? t("right.adGroupingStatus") : t("right.adGroupingTree")}
          aria-pressed={grouping === "tree"}
          onClick={() => useAppStore.getState().setDeckGrouping(grouping === "tree" ? "status" : "tree")}
        >
          <Icon name={grouping === "tree" ? "sort" : "orgChart"} size={14} />
        </button>
        {/* Density toggle: same single-button treatment (icon = the density a click
            switches to; menu = minimal one-row, rows = standard cards). */}
        <button
          type="button"
          className="hub-ibtn"
          title={density === "standard" ? t("right.adDensityMinimal") : t("right.adDensityStandard")}
          aria-pressed={density === "minimal"}
          onClick={() => useAppStore.getState().setDeckDensity(density === "standard" ? "minimal" : "standard")}
        >
          <Icon name={density === "standard" ? "menu" : "rows"} size={14} />
        </button>
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
