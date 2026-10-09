// Subagent page: card list + click into detail.
// List card reuses the Agent Hub roster row style (.hub-row in main-hub.css); the detail
// reuses the Agent Hub inspector (HubDetail from HubDetailPage) under a back-to-list button.
// Detail skeleton (must keep): #rightBody gets the detail class, rb-head fixed (back button),
// scrolling rb-scroll carries the inspector.
import { useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump } from "../../../store";
import { HubDetail } from "./HubDetailPage";
import { SubControls, SteerInput } from "../../shared/agent/SubControls";
import { usageSegments, timeSegments, modelShort, subStatus } from "../../shared/agent/subShared";
import type { SubagentState } from "../../../types/session";

// Repaint once per second while any visible subagent streams: host durationMs only arrives
// throttled at 500ms boundaries, a live elapsed figure needs a local clock (same pattern as
// SessionStatsBar)
function useTick(active: boolean) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(bump, 1000);
    return () => clearInterval(timer);
  }, [active]);
}

export default function SubagentPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const selectedSubagent = useAppStore((st) => st.selectedSubagent);
  const anyStreaming = !!s && [...s.subagents.values()].some((x) => x.streaming);
  useTick(anyStreaming);
  if (!s || s.subagents.size === 0) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noSubagents")}</div>;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    return <SubagentDetail sub={s.subagents.get(selectedSubagent)!} sessionId={s.sessionId} />; // the has() on the previous line guarantees presence
  }
  return (
    <div className="hub-list">
      {[...s.subagents].map(([id, sub]) => (
        <SubCard key={id} id={id} sub={sub} sessionId={s.sessionId} />
      ))}
    </div>
  );
}

// List card: reuses the Agent Hub roster row style (.hub-row), flat surface with
// hover-only highlight (no permanent "on" state on this page)
function SubCard({ id, sub, sessionId }: { id: string; sub: SubagentState; sessionId: string }) {
  const { t } = useTranslation();
  const st = subStatus(sub);
  const segs = usageSegments(sub, t, { model: false });
  const times = timeSegments(sub, t, Date.now());
  const model = modelShort(sub.usage?.resolvedModel);
  // Steer input expands in place below the row (div root: controls are buttons, which cannot
  // nest inside the old <button> root)
  const [steerOpen, setSteerOpen] = useState(false);
  return (
    <div
      className="hub-row"
      onClick={() => {
        // Entrance-animation flag: set in the same setState as selectedSubagent (subscribers
        // read it at render); silent macrotask reset — the reset has no subscribers so no
        // render fires, the kids-in class stays and the animation isn't cut short (old
        // notify semantics)
        useAppStore.setState((st) => ({ selectedSubagent: id, animateSubKids: true }));
        setTimeout(() => {
          useAppStore.setState({ animateSubKids: false });
        }, 0);
      }}
    >
      <span className="hub-row-head">
        <span className={"sub-dot st-" + st}>{st === "running" ? "●" : st === "completed" ? "✓" : st === "failed" ? "✗" : "○"}</span>
        <span className="hub-name">{sub.name ?? sub.agent}</span>
        {sub.streaming ? <SubControls sessionId={sessionId} agentId={id} onSteer={() => setSteerOpen((v) => !v)} /> : null}
        {model ? <span className="hub-model">{model}</span> : null}
      </span>
      <span className="hub-task text-faint">{sub.description || sub.task || sub.text.slice(0, 80) || "…"}</span>
      {segs.length > 0 || times.length > 0 ? (
        <span className="hub-meta text-faint">
          <span className="hub-meta-usage">{segs.join(" · ")}</span>
          <span className="hub-meta-right">{times.join(" · ")}</span>
        </span>
      ) : null}
      {steerOpen && sub.streaming ? <SteerInput sessionId={sessionId} agentId={id} onClose={() => setSteerOpen(false)} /> : null}
    </div>
  );
}

// Detail: back-to-list pinned at top; the Agent Hub inspector (shared with the hub tab's
// linked detail page) scrolls beneath it. Back switches immediately (same as the gitdiff /
// file details — no collapse animation)
function SubagentDetail({ sub, sessionId }: { sub: SubagentState; sessionId: string }) {
  const { t } = useTranslation();
  useTick(!!sub.streaming);
  // The pulse flag is read via getState at render (not subscribed): setting it rides the
  // selectedSubagent write driving this component's render; the silent macrotask reset fires
  // no subscription — the kids-in class survives until the next render, the entrance animation
  // isn't cut short (the first frame after the old notify was true)
  const kids = !!useAppStore.getState().animateSubKids;
  return (
    <>
      <div className={"rb-head" + (kids ? " kids-in" : "")}>
        <button className="self-start mb-1.5 border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-panel-2 hover:text-text" onClick={() => setBump({ selectedSubagent: null })}>
          {t("right.backToList")}
        </button>
      </div>
      <div className={"rb-scroll" + (kids ? " kids-in" : "")}>
        <HubDetail sub={sub} sessionId={sessionId} t={t} />
      </div>
    </>
  );
}
