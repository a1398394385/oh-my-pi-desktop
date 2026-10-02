// Subagent page: card list + click into detail.
// Detail skeleton (finalized today, must keep): #rightBody gets the detail class, rb-head
// fixed (back + name/status), scrolling rb-scroll carries the process stream.
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump } from "../../store";
import { inlineCodeHtml } from "./helpers";
import { Spin } from "../chat/parts";
import type { SubagentState, SubagentToolCall } from "../../types/session";

// Subagent entries and tool rows uniformly use the store's shared types (types/session.ts);
// fields per this page's reads

export default function SubagentPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const selectedSubagent = useAppStore((st) => st.selectedSubagent);
  if (!s || s.subagents.size === 0) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.noSubagents")}</div>;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    return <SubagentDetail sub={s.subagents.get(selectedSubagent)!} />; // the has() on the previous line guarantees presence
  }
  return (
    <>
      {[...s.subagents].map(([id, sub]) => (
        <button
          key={id}
          className={"sub-card " + (sub.streaming ? "running" : sub.status)}
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
          <div className="flex items-center gap-1.5 text-ui-base text-text">
            <span className="sub-dot">
              {sub.streaming ? "●" : sub.status === "completed" ? "✓" : sub.status === "failed" ? "✗" : "○"}
            </span>
            <span>{sub.agent}</span>
          </div>
          <div className="text-ui-sm text-faint mt-1 line-clamp-2">{sub.description || sub.text.slice(0, 60) || "…"}</div>
        </button>
      ))}
    </>
  );
}

// Detail: back + name/status pinned at top; the process stream (tool rows + current text) scrolls
function SubagentDetail({ sub }: { sub: SubagentState }) {
  const { t } = useTranslation();
  const headRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The pulse flag is read via getState at render (not subscribed): setting it rides the
  // selectedSubagent write driving this component's render; the silent macrotask reset fires
  // no subscription — the kids-in class survives until the next render, the entrance animation
  // isn't cut short (the first frame after the old notify was true)
  const kids = !!useAppStore.getState().animateSubKids;
  const back = () => {
    // Collapse: detail content lifts away (0.3s) then switches back to the list
    for (const el of [headRef.current, scrollRef.current]) el?.classList.add("lift");
    setTimeout(() => {
      setBump({ selectedSubagent: null });
    }, 310);
  };
  return (
    <>
      <div ref={headRef} className={"rb-head" + (kids ? " kids-in" : "")}>
        <button className="self-start mb-1.5 border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-panel-2 hover:text-text" onClick={back}>
          {t("right.backToList")}
        </button>
        <div className="text-ui-sm text-faint mb-1.5 break-all">
          {sub.agent} · {sub.status}
        </div>
      </div>
      <div ref={scrollRef} className={"rb-scroll flex flex-col gap-2" + (kids ? " kids-in" : "")}>
        {sub.tools.map((t, i) => (
          <ToolLine key={i} t={t} />
        ))}
        {(sub.text || sub.streaming) && (
          <div
            className={"step-title" + (sub.streaming ? " flash" : "")}
            dangerouslySetInnerHTML={{ __html: inlineCodeHtml(sub.text || "…") }}
          />
        )}
      </div>
    </>
  );
}

// Lightweight tool-row summary: first readable arg among command / path / pattern etc.
function toolSummary(t: SubagentToolCall): string {
  // args is unknown on the store side (host pass-through); this page reads only these summary fields
  const a = (t.args || {}) as { command?: string; path?: string; pattern?: string; files?: string[] };
  return a.command || a.path || a.pattern || a.files?.[0] || t.files?.[0] || "";
}

// TODO(tool-row-wave): the full tool-row visuals (per-label rendering from tool-labels.js)
// depend on the old core.js; to be unified and reused after the main chat area (chat-wave) is
// translated; for now rendered as "label + summary" rows
function ToolLine({ t }: { t: SubagentToolCall }) {
  const sum = toolSummary(t);
  return (
    <div className="act read">
      <span className="lbl">{t.name}</span>
      {sum ? (
        <span className="path" title={sum}>
          {sum}
        </span>
      ) : null}
      {t.running ? <Spin /> : null}
    </div>
  );
}
