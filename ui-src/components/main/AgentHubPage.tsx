// Agent Hub middle card: replaces the chat stream while open. Flat roster of the session's
// subagents (projected rows from subRoster) at standard density (the deck's minimal density
// is sidebar-only), an overview/command segmented control and the status filter pills in the
// top bar, and the aggregate usage stats at the bar's right edge. Selection links to the
// right sidebar's hub detail page; Enter bridges into the regular subagent tab; x kills via
// kill_subagent. The back button and the grouping toggle live in the shared headerbar
// (MainHeader) while the hub is open.
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../store";
import { HubUsage, StatusTabs, useRosterRows, useRosterTick, openSubagentSession, treeDepth, HubPageCard } from "../shared/agent/subRoster";

const DOUBLE_LEFT_MS = 500;

export default function AgentHub() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const hubSel = useAppStore((st) => st.hubSel);
  const grouping = useAppStore((st) => st.hubGrouping);
  const hubView = useAppStore((st) => st.hubView);
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

  // The back button lives in the shared headerbar while the hub is open (same slot the
  // subagent detail page uses), so neither the empty state nor the top bar carries one here.

  if (!s || s.subagents.size === 0) {
    return (
      <div id="agentHub" className="hub-empty text-faint text-ui-base">
        {t("right.hubEmpty")}
      </div>
    );
  }

  return (
    <div id="agentHub">
      {/* Top bar: the overview/command segmented control (the sidebar's .seg switch with two
          slots), the status filter pills, and the labeled aggregate stats row pinned to the
          right edge — the same five-cell line the right sidebar's subagent page renders in
          its pulse header. No plate of its own; the pills and the control carry the chrome. */}
      <div className="hub-topbar">
        <div
          className="seg hub-seg"
          role="tablist"
          style={{ "--seg-i": hubView === "command" ? 1 : 0, "--seg-n": 2 } as CSSProperties}
        >
          <button
            type="button"
            role="tab"
            data-view="overview"
            className={hubView === "overview" ? "on" : ""}
            aria-selected={hubView === "overview"}
            onClick={() => useAppStore.getState().setHubView("overview")}
          >
            {t("right.hubTabOverview")}
          </button>
          <button
            type="button"
            role="tab"
            data-view="command"
            className={hubView === "command" ? "on" : ""}
            aria-selected={hubView === "command"}
            onClick={() => useAppStore.getState().setHubView("command")}
          >
            {t("right.hubTabCommand")}
          </button>
        </div>
        <StatusTabs s={s} />
        <div className="hub-stats">
          <HubUsage s={s} />
        </div>
      </div>
      {hubView === "command" ? (
        <div className="hub-comms-soon">{t("right.adTabSoon")}</div>
      ) : (
        <div className="hub-list" role="listbox">
          {rows.map((row) => {
            // Tree grouping indents by ancestry depth, so a subagent's subagent nests further
            const depth = grouping === "tree" ? treeDepth(rows, row) : 0;
            return (
              <div key={row.id} style={depth ? { paddingLeft: depth * 14 } : undefined}>
                <HubPageCard
                  row={row}
                  selected={row.id === hubSel}
                  onSelect={() => useAppStore.getState().setHubSel(row.id)}
                  t={t}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
