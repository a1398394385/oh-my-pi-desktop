// Action group at the bottom-left of a turn's output end: copy this reply + fork from
// here + this turn's end time.
// Forking goes through branch_session (slices the history entries from the root to this
// assistant node, copying them into a brand-new session file).
// The anchor entryId is backfilled by the host after persisting (translate.ts).
import { memo, useSyncExternalStore } from "react";
import type { AssistantItem } from "../../types/session";
import { useAppStore } from "../../store/index";
import { patchActiveItem } from "./parts";
import { useCopyFeedback, useSuccessFlash } from "../main/sidebar/util";
import Icon from "../../Icon";
import { t } from "../../i18n";
import { t as i18nT } from "../../i18n";
import { beginOneShot, cancelOneShot, getOneShotKey, subscribeOneShot } from "../../lib/speechOut";

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

// entryId/endMs are captured mutation snapshots (T2): turn_end backfills them in place
export default memo(function TurnActs({
  item,
  reply,
}: {
  item: AssistantItem;
  /** Full merged turn output: one reply can arrive as several assistant items (text, tool
   *  calls, then a closing line) that render as one block, and item.text only holds the tail. */
  reply: string;
  entryId?: string;
  endMs?: number;
}) {
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  // Forking is unavailable while entryId is not yet backfilled (not persisted during live
  // streaming): grayed out rather than hidden, to avoid layout jumps
  const canFork = !!item.entryId && !item.branching;
  const { copied, copy } = useCopyFeedback();
  const { flashed: forked, flash: flashForked } = useSuccessFlash();
  // Reading state is global (one clip at a time): only the turn that started it lights up.
  const speakKey = item.entryId ?? `t${item.ts ?? 0}b${item.block ?? 0}`;
  const speaking = useSyncExternalStore(subscribeOneShot, getOneShotKey, getOneShotKey) === speakKey;
  return (
    <div className="turn-acts">
      {/* Column-capped inner box (same max-width + auto-margin mechanism as .turn-flow):
          WebKit computes padding-calc centering and margin-auto centering
          inconsistently inside a zoomed subtree, so the row stays full-width
          (BUG-030 selection fill) while this inner box carries the column cap. */}
      <div className="turn-acts-in">
        <button
          className="q-btn"
          title={t("chat.copyReply")}
          onClick={(e) => {
            e.stopPropagation();
            void copy(reply).catch(() => useAppStore.getState().toast(t("chat.copyFailed")));
          }}
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
        <button
          className="q-btn"
          title={item.entryId ? t("chat.branchFromHere") : t("chat.branchAfterSaved")}
          disabled={!canFork}
          onClick={(e) => {
            e.stopPropagation();
            if (!canFork || !sessionId) return;
            patchActiveItem(item, (it) => { it.branching = true; }); // stays disabled across full redraws (the flag lives with the item data)
            flashForked(); // receipt-driven switch waits for this flash (applyForkReceipt), so the check is actually seen
            useAppStore.getState().send({ type: "branch_session", sessionId, entryId: item.entryId });
          }}
        >
          <Icon name={forked ? "check" : "fork"} />
        </button>
        {/* Read aloud: the host resolves the speech role (tts model) and answers
            with a clip, or with backend "system" when only the OS voice is set.
            While this turn is being read the button stays lit; clicking again stops it. */}
        <button
          className={speaking ? "q-btn speaking" : "q-btn"}
          title={speaking ? t("chat.stopSpeakReply") : t("chat.speakReply")}
          disabled={!item.text || !sessionId}
          onClick={(e) => {
            e.stopPropagation();
            if (!item.text || !sessionId) return;
            if (speaking) {
              cancelOneShot();
              return;
            }
            const requestId = beginOneShot(speakKey);
            useAppStore.getState().send({ type: "speak_text", sessionId, text: item.text, requestId });
          }}
        >
          <Icon name="speaker" />
        </button>
        {item.endMs ? <span className="turn-acts-time">{fmtClock(item.endMs)}</span> : null}
      </div>
    </div>
  );
});
