// Action group at the bottom-left of a turn's output end: copy this reply + fork from
// here + this turn's end time.
// Forking goes through branch_session (slices the history entries from the root to this
// assistant node, copying them into a brand-new session file).
// The anchor entryId is backfilled by the host after persisting (translate.ts).
import type { AssistantItem } from "../../types/session";
import { useAppStore } from "../../store/index";
import { patchActiveItem } from "./parts";
import { copyText } from "../sidebar/util";
import Icon from "../../Icon";
import { t } from "../../i18n";
import { t as i18nT } from "../../i18n";

// End time: same-day shows only HH:MM (same format as the limits reset time in
// CtxCard/ModelPage); other days prepend month and day
function fmtClock(ms: number) {
  const t = new Date(ms);
  const now = new Date();
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  return sameDay ? hm : i18nT("chat.clockDate", { m: t.getMonth() + 1, d: t.getDate(), hm });
}

export default function TurnActs({ item }: { item: AssistantItem }) {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  // Forking is unavailable while entryId is not yet backfilled (not persisted during live
  // streaming): grayed out rather than hidden, to avoid layout jumps
  const canFork = !!item.entryId && !item.branching;
  return (
    <div className="turn-acts">
      <button
        className="q-btn"
        title={t("chat.copyReply")}
        onClick={(e) => {
          e.stopPropagation();
          copyText(item.text || "").then(
            () => useAppStore.getState().toast(t("chat.replyCopied")),
            () => useAppStore.getState().toast(t("chat.copyFailed")),
          );
        }}
      >
        <Icon name="copy" />
      </button>
      <button
        className="q-btn"
        title={item.entryId ? t("chat.branchFromHere") : t("chat.branchAfterSaved")}
        disabled={!canFork}
        onClick={(e) => {
          e.stopPropagation();
          if (!canFork || !s) return;
          patchActiveItem(item, (it) => { it.branching = true; }); // stays disabled across full redraws (the flag lives with the item data)
          useAppStore.getState().send({ type: "branch_session", sessionId: s.sessionId, entryId: item.entryId });
        }}
      >
        <Icon name="fork" />
      </button>
      {item.endMs ? <span className="turn-acts-time">{fmtClock(item.endMs)}</span> : null}
    </div>
  );
}
