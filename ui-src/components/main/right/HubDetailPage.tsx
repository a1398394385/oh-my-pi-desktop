// Agent Hub linked detail page (right sidebar): the sheet for the selected agent, or the swarm
// summary when nothing is selected. Mirrors the deck's right column.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import AgentSheet from "../../shared/agent/AgentSheet";
import AgentSummary from "../../shared/agent/AgentSummary";

export default function HubDetailPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const hubSel = useAppStore((st) => st.hubSel);
  const sub = hubSel ? s?.subagents.get(hubSel) : undefined;
  // Rescroll to top when the selection changes (sheet lengths differ wildly)
  useEffect(() => {
    document.querySelector(".rb-scroll")?.scrollTo({ top: 0 });
  }, [hubSel]);
  if (!s || s.subagents.size === 0) {
    return <div className="py-3 text-faint text-ui-base">{t("right.hubEmpty")}</div>;
  }
  return (
    <div className="rb-scroll">
      {sub && hubSel ? <AgentSheet key={hubSel} sub={sub} subagentId={hubSel} sessionId={s.sessionId} /> : <AgentSummary s={s} />}
    </div>
  );
}
