import { memo, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { OpenSession, UserItem } from "../../types/session";
import { activeOpen, sendNowQueueMsg, editQueueMsg, dropQueueMsg, requeueSteerMsg, useAppStore } from "../../store";
import { useCopyFeedback } from "../main/sidebar/util";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import { atMentions } from "../../lib/at-mentions";
import { stripQuote } from "../../lib/conversation-quote";
import ImageLightbox from "./ImageLightbox";
import { FadeBox } from "./parts";
import { t } from "../../i18n";

// Left-side action group of a pending-consumption bubble: queued state (send now / edit /
// delete) | steer state (edit / requeue to top)
function PendingActs({ item }: { item: UserItem }) {
  const s = activeOpen();
  const mk = (title: string, ic: string, fn: (sess: OpenSession, item: UserItem) => void) => (
    <button
      className="q-btn"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (s) fn(s, item);
      }}
    >
      <Icon name={ic} size={15} />
    </button>
  );
  return (
    <div className="qk-acts">
      {item.pending === "steer" ? (
        <>
          {mk(t("chat.editBackToComposer"), "pencil", editQueueMsg)}
          {mk(t("chat.requeueTop"), "down", requeueSteerMsg)}
        </>
      ) : (
        <>
          {mk(t("chat.sendNow"), "upload", sendNowQueueMsg)}
          {mk(t("chat.editBackToComposer"), "pencil", editQueueMsg)}
          {mk(t("common.delete"), "trash", dropQueueMsg)}
        </>
      )}
    </div>
  );
}

// The fork button that used to appear on hover of historical user messages with an entryId
// has been removed: forking now hangs at the end of a turn's output (see TurnActs.jsx);
// only the queued/steer action group remains beside the bubble.
// pending is a captured mutation snapshot (T2): applySteerConsumed flips it in place
export default memo(function UserMsg({ item, fk, branch }: { item: UserItem; fk?: string; pending?: UserItem["pending"]; branch?: ReactNode }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Annotations ride in the sent prompt text; the bubble shows the user's own words only
  const body = stripQuote(item.text);
  const [draft, setDraft] = useState(body);
  const { copied, copy } = useCopyFeedback();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const images = item.images ?? [];
  // @file mentions the base auto-read: chips on top, tokens stripped from the text
  const mention = atMentions(body, item.attachments);
  const lightboxList = images.map((img, i) => ({
    src: img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`,
    name: t("chat.imageN", { n: i + 1 }),
  }));

  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const streaming = useAppStore((st) => !!((st.activePath ? st.openSessions.get(st.activePath) : undefined)?.streaming));
  const editing = useAppStore((st) => st.editingEntryId !== null && st.editingEntryId === item.entryId);
  // Grayed rather than hidden while unavailable (entryId not yet backfilled / session
  // streaming), same policy as TurnActs' canFork, so the hover row does not jump
  const canEdit = !item.pending && !item.automation && !!item.entryId && !!sessionId && !streaming;
  const canSend = draft.trim() !== "" || images.length > 0;

  // Enter the edit state with the caret at the end (a plain autoFocus can park it at the start)
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editing]);

  // Focus entering the main composer cancels the edit: the in-place box only owns the
  // keyboard until the user goes back to the input
  useEffect(() => {
    if (!editing) return;
    const onFocusIn = (ev: FocusEvent) => {
      if (ev.target instanceof HTMLElement && ev.target.closest("#composer")) {
        useAppStore.setState({ editingEntryId: null });
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [editing]);

  const sendEdit = () => {
    if (!canEdit || !item.entryId || !sessionId) return;
    const text = draft.trim();
    // Stash the payload: the session_edited failure landing restores it into the
    // composer, so the edited text is never silently lost
    useAppStore.setState({ editingEntryId: null, pendingEditText: { sessionId, text, images: item.images ?? null } });
    useAppStore.getState().send({ type: "edit_resend", sessionId, entryId: item.entryId, text, images: item.images ?? [] });
  };

  const onTaKeyDown = (ev: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // The global shortcut router (Esc abort route / hub gestures) must not see keys typed here
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      useAppStore.setState({ editingEntryId: null });
      return;
    }
    if (ev.key !== "Enter" || ev.shiftKey) return;
    // WebKit marks the candidate-commit Enter keyCode 229 with isComposing already
    // false (BUG-031; the composer's ComposerPlugin carries the field evidence).
    if (ev.nativeEvent.isComposing || ev.nativeEvent.keyCode === 229) {
      ev.preventDefault();
      return;
    }
    if (!canSend) return;
    ev.preventDefault();
    sendEdit();
  };

  // Queued/steer pending-consumption message: hover shows the action group to the left of
  // the bubble (once consumed, pending clears and it becomes an ordinary historical message)
  const delivery = item.automation;
  const cls = item.pending ? "user-bubble pending" : delivery ? "user-bubble delivery" : "user-bubble";
  // Edit stays available on remote clients: edit_resend only appends a sibling branch
  // (see REMOTE_WRITE_DENYLIST), so it is not a read-only violation
  const showEditBtn = !item.pending && !item.automation && !editing;
  return (
    <div className="msg user" data-fk={fk || undefined}>
      <div className={cls}>
        {images.length > 0 && (
          <div className="user-msg-images mb-2 flex flex-wrap gap-2">
            {images.map((img, idx) => {
              const src = img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`;
              return (
                <div
                  key={idx}
                  className="group relative cursor-pointer overflow-hidden rounded-md border border-line bg-card hover:opacity-90 transition-opacity"
                  onClick={() => setLightboxIndex(idx)}
                  title={t("chat.clickToZoom")}
                >
                  <img
                    src={src}
                    alt={`attachment-${idx}`}
                    className={
                      images.length === 1
                        ? "max-w-[320px] w-auto h-auto object-contain rounded-md block"
                        : "user-msg-img-tile object-cover rounded-md block"
                    }
                  />
                  <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white text-xs">
                    <Icon name="search" size={14} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {mention.paths.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {mention.paths.map((p) => (
              <span className="atchip" key={p} title={p}>
                <span className="at-ic">
                  <Icon name={fileTypeIcon(p)} />
                </span>
                <span className="at-name">{p.split("/").pop() || p}</span>
              </span>
            ))}
          </div>
        )}
        {delivery ? (
          // Scheduler delivery: a card header instead of a plain bubble, so it never passes
          // for typed input. The header is the way back to the task that sent it (the
          // transcript stores the automation id/title, not just the text).
          <button
            className="ud-head"
            title={t("chat.openAutomation", { title: delivery.title })}
            onClick={(e) => {
              e.stopPropagation();
              useAppStore.getState().openAutomationEditor(delivery.id);
            }}
          >
            <Icon name="clock" size={12} />
            <span className="ud-kind">{t("chat.automationTaskLabel")}</span>
            <span className="ud-sep">/</span>
            <span className="ud-task">{delivery.title || t("chat.automationDelivery")}</span>
            <Icon name="chevronRight" size={12} className="ud-go" />
          </button>
        ) : null}
        {editing ? (
          <div className="ub-edit">
            <textarea
              ref={taRef}
              value={draft}
              rows={Math.max(2, Math.min(10, draft.split("\n").length))}
              aria-label={t("chat.editResend")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onTaKeyDown}
            />
            <button className="q-btn" title={t("chat.editResendSend")} disabled={!canSend} onClick={sendEdit}>
              <Icon name="upload" size={15} />
            </button>
          </div>
        ) : mention.text ? (
          <FadeBox className="user-msg-text whitespace-pre-wrap">{mention.text}</FadeBox>
        ) : null}
        {item.pending ? <PendingActs item={item} /> : null}
      </div>
      {branch || showEditBtn || (body && !editing) || editing ? (
        <div className="ub-actions">
          {branch}
          {showEditBtn ? (
            <button
              className="ub-edit-btn q-btn"
              title={canEdit ? t("chat.editResend") : item.entryId ? t("chat.editWhileStreaming") : t("chat.editAfterSaved")}
              disabled={!canEdit}
              onClick={(e) => {
                e.stopPropagation();
                if (!canEdit || !item.entryId) return;
                setDraft(body);
                useAppStore.setState({ editingEntryId: item.entryId });
              }}
            >
              <Icon name="pencil" size={13} />
            </button>
          ) : null}
          {body && !editing ? (
            <button
              className="ub-copy q-btn"
              title={t("chat.copyMsg")}
              onClick={(e) => {
                e.stopPropagation();
                void copy(mention.text || "").catch(() => useAppStore.getState().toast(t("chat.copyFailed")));
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxList}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
});
