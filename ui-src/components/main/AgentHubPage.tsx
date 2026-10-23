// Agent Hub middle card (TUI parity): replaces the chat stream while open. Roster of the
// session's subagents in Flat/By-parent modes with the TUI's row layout (status glyph +
// name, model badge right, task line, metrics line), an aggregate usage summary, and the
// keybind bar at the top. Selection links to the right sidebar's hub detail page; Enter
// bridges into the regular subagent tab; x kills via kill_subagent.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, openSessionByPath } from "../../store";
import { expandRightPanel } from "./right/tabs";
import { HubRow, RosterHead, useRosterRows, useRosterTick } from "../shared/agent/subRoster";

const DOUBLE_LEFT_MS = 500;

export default function AgentHub() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const hubSel = useAppStore((st) => st.hubSel);
  const hubMode = useAppStore((st) => st.hubMode);
  // Repaint the age column once per second while anything streams
  useRosterTick(s);
  const rows = useRosterRows(s);
  const lastLeftAt = useRef(0);

  // Keep the selection on a live row: default to the first row, recover when rows shrink
  useEffect(() => {
    const st = useAppStore.getState();
    if (!st.hubSel || !rows.some((r) => r.id === st.hubSel)) {
      st.setHubSel(rows[0]?.id ?? null);
    }
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
        case "t":
          e.preventDefault();
          st.toggleHubMode();
          return;
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          // Open the subagent session (or fallback to subagent detail tab) and leave the hub
          const id = st.hubSel;
          if (!id) return;
          const sub = s?.subagents.get(id);
          if (sub?.sessionFile) {
            st.closeHub();
            openSessionByPath(sub.sessionFile);
            return;
          }
          st.closeHub();
          expandRightPanel("subagent", { selectedSubagent: id });
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

  const hints: [string, string][] = [
    ["j/k", t("right.hubKeySelect")],
    ["⏎", t("right.hubKeyOpen")],
    ["t", t("right.hubKeyTree")],
    ["x", t("right.hubKeyKill")],
    ["←←/Esc", t("right.hubKeyClose")],
  ];

  return (
    <div id="agentHub">
      {/* Keybind bar at the top (requirement: every shortcut's action shown here) */}
      <div className="hub-keys">
        <span className="hub-title">{t("right.hubTitle")}</span>
        {hints.map(([key, label]) => (
          <span className="hub-key" key={key}>
            <kbd>{key}</kbd>
            {label}
          </span>
        ))}
        {backBtn}
      </div>
      {/* Roster header: mode toggle + status counts, then the aggregate usage line */}
      <RosterHead s={s} />
      {/* Roster rows */}
      <div className="hub-list" role="listbox">
        {rows.map((row) => (
          <HubRow key={row.id} row={row} flat={hubMode === "flat"} selected={row.id === hubSel} onSelect={() => useAppStore.getState().setHubSel(row.id)} sessionId={s.sessionId} t={t} />
        ))}
      </div>
    </div>
  );
}
