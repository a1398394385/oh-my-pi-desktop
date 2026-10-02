// Goal bar: the topmost stacked bar above the composer (rendered by App before
// QueueCard, shifting up as queued messages grow).
// The stacking geometry reuses the queue-card recipe (margin -28px pull-up +
// padding-bottom 28px fallback + top-only rounded corners, bottom edge pressed
// by the next card); 10px narrower than the composer on each side, no
// corner-filler block. Single row: truncated objective + elapsed time /
// consumed cost / pause-resume / delete; clicking the bar expands the full
// objective upward (icon clicks do not trigger expansion).
// Pause/resume transform in place (mapping to /goal pause, /goal resume); icon
// actions go through the prompt path (the command is consumed locally; the
// optimistic bubble is retracted by command_result).
import { useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../store";
import Icon from "../../Icon";

export default function GoalCard() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const g = s?.goal;
  if (!s || !g) return null;
  const run = Math.round(g.timeUsedSeconds ?? 0);
  const runLabel =
    run >= 3600 ? `${Math.floor(run / 3600)}h${Math.floor((run % 3600) / 60)}m` : run >= 60 ? `${Math.floor(run / 60)}m${run % 60}s` : `${run}s`;
  const paused = !g.enabled;
  return (
    <div
      className={"goal-card" + (expanded ? " open" : "")}
      title={g.objective}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="gc-row">
        <span className="gc-obj">{g.objective}</span>
        <span className="gc-meta">
          <span className="gc-run">{runLabel}</span>
          <span className="gc-cost">${(g.costUsed ?? 0).toFixed(4)}</span>
          <button
            className="plus-btn"
            title={paused ? t("composer.resumeGoal") : t("composer.pauseGoal")}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              send({ type: "prompt", sessionId: s.sessionId, text: paused ? "/goal resume" : "/goal pause" });
            }}
          >
            <Icon name={paused ? "play" : "pause"} size={16} />
          </button>
          <button
            className="plus-btn"
            title={t("composer.dropGoal")}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              send({ type: "prompt", sessionId: s.sessionId, text: "/goal drop" });
            }}
          >
            <Icon name="trash" size={16} />
          </button>
        </span>
      </div>
    </div>
  );
}
