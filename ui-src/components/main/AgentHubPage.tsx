// Agent Hub middle card: replaces the chat stream while open. Flat roster of the session's
// subagents (projected rows from subRoster), status filter pills in the top bar, and the
// aggregate usage summary above the list. Selection links to the right sidebar's hub detail
// page; Enter bridges into the regular subagent tab; x kills via kill_subagent.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { useAppStore, send } from "../../store";
import { HubRow, HubUsage, StatusTabs, useRosterRows, useRosterTick, openSubagentSession } from "../shared/agent/subRoster";

const DOUBLE_LEFT_MS = 500;

export default function AgentHub() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const hubSel = useAppStore((st) => st.hubSel);
  const density = useAppStore((st) => st.hubDensity);
  const grouping = useAppStore((st) => st.hubGrouping);
  // Repaint the age column once per second while anything streams
  useRosterTick(s);
  const rows = useRosterRows(s);
  const lastLeftAt = useRef(0);

  // Drop a selection that no longer exists; never auto-select, because the sidebar's empty
  // state is the swarm summary (the deck's own rule).
  useEffect(() => {
    const st = useAppStore.getState();
    if (st.hubSel && !rows.some((r) => r.id === st.hubSel)) st.setHubSel(null);
  }, [rows]);

  // Hub keybinds: capture phase so j/k never land in the (hidden) composer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useAppStore.getState();
      const sel = (d: number) => {
        const cur = rows.findIndex((r) => r.id === st.hubSel);
        const next = rows[Math.max(0, Math.min(cur + d, rows.length - 1))];
        if (next) st.setHubSel(next.id);
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          sel(1);
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          sel(-1);
          return;
        case "ArrowLeft": {
          e.preventDefault();
          // Double-tap ← closes the hub (the open gesture in reverse, TUI parity)
          const now = Date.now();
          if (now - lastLeftAt.current <= DOUBLE_LEFT_MS) st.closeHub();
          else lastLeftAt.current = now;
          return;
        }
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          // Open the subagent session (or fallback to subagent detail tab) and leave the hub
          const id = st.hubSel;
          if (id) openSubagentSession(id, s?.subagents.get(id));
          return;
        }
        case "x": {
          e.preventDefault();
          const id = st.hubSel;
          const sub = id ? s?.subagents.get(id) : undefined;
          if (!id || !sub || !sub.streaming) return;
          send({ type: "kill_subagent", subagentId: id });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, s]);

  // Mouse exit (the keybinds live only in the keybind bar below)
  const backBtn = (
    <button type="button" className="subagent-return-btn ml-auto" onClick={() => useAppStore.getState().closeHub()}>
      {t("chat.backToParentSession")}
    </button>
  );

  if (!s || s.subagents.size === 0) {
    return (
      <div id="agentHub" className="hub-empty text-faint text-ui-base">
        {t("right.hubEmpty")}
        {backBtn}
      </div>
    );
  }

  return (
    <div id="agentHub">
      {/* Top bar: title, status filter pills, back button. No plate of its own — the pills
          carry the only chrome (the old keybind row's background and hints are gone; the
          shortcuts themselves still work). */}
      <div className="hub-topbar">
        <span className="hub-title">{t("right.hubTitle")}</span>
        <StatusTabs s={s} />
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
        {backBtn}
      </div>
      <HubUsage s={s} />
      <div className="hub-list" role="listbox">
        {rows.map((row) => (
          // Tree grouping indents children under their parent; the sort itself stays status-first
          <div key={row.id} style={grouping === "tree" && row.sub.parent && row.sub.parent !== "main" ? { paddingLeft: 14 } : undefined}>
            <HubRow
              row={row}
              stats
              selected={row.id === hubSel}
              minimal={density === "minimal"}
              onSelect={() => useAppStore.getState().setHubSel(row.id)}
              sessionId={s.sessionId}
              t={t}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
