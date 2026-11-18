// Subagent page: roster cards only — no header, no aggregate line (the Agent Hub carries
// those). A card click swaps the list for that child's transcript, read-only: the same row
// renderer the middle column uses, with nothing writable attached.
// Detail skeleton (must keep): rb-head fixed (back + stop), scrolling rb-scroll carries rows.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { useAppStore, setBump } from "../../../store";
import { loadSessionInBackground } from "../../../store/session";
import { renderItems } from "../../chat/items";
import { HubRow, useRosterRows, useRosterTick } from "../../shared/agent/subRoster";
import { sendSubagentControl } from "../../shared/agent/hubExt";
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
  // Detail view hides the roster, whose tick would otherwise repaint the whole page every
  // second next to the detail's own clock.
  useRosterTick(selectedSubagent ? undefined : s);
  const rows = useRosterRows(s);
  // Entrance-animation flag: set in the same setState as selectedSubagent (subscribers
  // read it at render); silent macrotask reset — the reset has no subscribers so no
  // render fires, the kids-in class stays and the animation isn't cut short (old
  // notify semantics)
  const openDetail = (id: string) => {
    useAppStore.setState((st) => ({ selectedSubagent: id, animateSubKids: true }));
    setTimeout(() => {
      useAppStore.setState({ animateSubKids: false });
    }, 0);
  };
  if (!s || s.subagents.size === 0) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noSubagents")}</div>;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    return <SubagentDetail sub={s.subagents.get(selectedSubagent)!} subagentId={selectedSubagent} sessionId={s.sessionId} />; // the has() on the previous line guarantees presence
  }
  return (
    <div className="hub-list" role="listbox">
      {rows.map((row) => (
        <HubRow
          key={row.id}
          row={row}
          stats={false}
          selected={false}
          onSelect={() => openDetail(row.id)}
          onOpen={() => openDetail(row.id)}
          sessionId={s.sessionId}
          t={t}
        />
      ))}
    </div>
  );
}

// Detail: back-to-list on the left, stop only while the child still streams. The body is the
// child transcript rendered read-only through the middle column's own row renderer.
function SubagentDetail({ sub, sessionId, subagentId }: { sub: SubagentState; sessionId: string; subagentId: string }) {
  const { t } = useTranslation();
  useTick(!!sub.streaming);
  // The pulse flag is read via getState at render (not subscribed): setting it rides the
  // selectedSubagent write driving this component's render; the silent macrotask reset fires
  // no subscription — the kids-in class survives until the next render, the entrance animation
  // isn't cut short (the first frame after the old notify was true)
  const kids = !!useAppStore.getState().animateSubKids;
  const path = sub.sessionFile ?? null;
  const session = useAppStore((st) => (path ? st.openSessions.get(path) : undefined));
  const boxRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // A child transcript is not resident until someone opens it: load it in the background so
  // the middle column keeps showing whatever the user was working on.
  useEffect(() => {
    if (path && !session) loadSessionInBackground(path);
  }, [path, session]);
  const items = session?.items;
  // Nested prefix ("ro:"): the top-level branch of renderItems owns the shared branch
  // context (the middle column sets it), and a read-only copy must neither read nor rewrite
  // that context — the distinct prefix keys every lookup out of it.
  const rows = useMemo(() => (items ? renderItems(items, "ro:", []) : []), [items]);
  // Follow the tail while the child streams unless the reader scrolled away.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && follow.current) box.scrollTop = box.scrollHeight;
  });
  return (
    <>
      <div className={"rb-head sub-msg-head" + (kids ? " kids-in" : "")}>
        <button className="border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-hover-fill hover:text-text" onClick={() => setBump({ selectedSubagent: null })}>
          {t("right.backToList")}
        </button>
        {sub.streaming ? (
          <button type="button" className="hub-ibtn" title={t("right.subStopSession")} onClick={() => sendSubagentControl(sessionId, subagentId, "cancel")}>
            <Icon name="stopSolid" size={12} />
          </button>
        ) : null}
      </div>
      <div
        className={"rb-scroll sub-msg-stream" + (kids ? " kids-in" : "")}
        ref={boxRef}
        onScroll={() => {
          const box = boxRef.current;
          if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
        }}
      >
        {!path ? <div className="placeholder">{t("right.subNoTranscript")}</div> : null}
        {path && !session ? <div className="placeholder">{t("right.subMessagesLoading")}</div> : null}
        {path && session && !items?.length ? <div className="placeholder">{t("right.subMessagesEmpty")}</div> : null}
        {rows}
      </div>
    </>
  );
}
