// Queued message card (ported from the old composer.js renderQueueLine): a
// second-level stacked card above the composer.
// Layout replicates the ZCode ConversationQueuePanel: relative z-0 + negative
// margin-bottom pull-up + padding-bottom fallback keeping content visible +
// top-only rounded corners; the .dock below presses on its bottom 28px with
// z-100 (see the "site-wide z-scale" in the ui/style.css file header).
// App renders it as an adjacent sibling before .dock (ZCode bottom dock order
// queue -> composer).
// Messages sent while streaming queue here; the 1st is auto-consumed once the
// current loop finishes processing; each entry can be sent immediately (becomes
// a steer) / edited (back into the composer) / deleted. The steer-state bubble
// action group (requeueSteerMsg) lives on the bubble side, owned by chat-wave;
// only the followUp queue is rendered here.
import { useTranslation } from "react-i18next";
import { useAppStore, sendNowQueueMsg, editQueueMsg, dropQueueMsg } from "../../store";
import type { UserItem } from "../../types/session";
import Icon from "../../Icon";

export default function QueueCard() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const items = s?.queued ?? [];
  if (!s || items.length === 0) return null; // without a session items is always empty; the merged early return matches the original logic
  return (
    <div className="queue-card" id="queueCard">
      {items.map((m: { text?: string }, i: number) => {
        const item: UserItem = { role: "user", text: m.text || "", pending: "queued" }; // pseudo item shared with the bubble actions
        return (
          <div className="qc-row" key={i} title={t("composer.queuedHint")}>
            <span className="qc-dots"><Icon name="dots" size={15} /></span>
            <span className="qc-tx">{m.text || t("composer.noText")}</span>
            <button
              className="q-btn"
              title={t("composer.sendNow")}
              onClick={(e) => { e.stopPropagation(); sendNowQueueMsg(s, item); }}
            ><Icon name="upload" size={15} /></button>
            <button
              className="q-btn"
              title={t("composer.editQueued")}
              onClick={(e) => { e.stopPropagation(); editQueueMsg(s, item); }}
            ><Icon name="pencil" size={15} /></button>
            <button
              className="q-btn"
              title={t("common.delete")}
              onClick={(e) => { e.stopPropagation(); dropQueueMsg(s, item); }}
            ><Icon name="trash" size={15} /></button>
          </div>
        );
      })}
    </div>
  );
}
