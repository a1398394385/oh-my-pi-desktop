import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { OpenSession, UserItem } from "../../types/session";
import { activeOpen, editQueueMsg, requeueSteerMsg, useAppStore } from "../../store";
import { useCopyFeedback } from "../main/sidebar/util";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import { atMentions, elementLabel, isDirToken } from "../../lib/at-mentions";
import { splitQuote } from "../../lib/conversation-quote";
import { insertSessionRef } from "../composer/trigger";
import ImageLightbox from "./ImageLightbox";
import { FadeBox } from "./parts";
import { t } from "../../i18n";
import { Chip } from "../composer/AnnotationChips";

/** Local `YYYY-MM-DD HH:MM:SS` — locale-independent, so the digits never reflow between locales. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Steer bubbles awaiting consumption carry edit / requeue-to-top in their own action row
// (same row and spacing as copy); the queue card owns the followUp actions.
// The fork button that used to appear on hover of historical user messages with an entryId
// has been removed: forking now hangs at the end of a turn's output (see TurnActs.jsx).
// pending is a captured mutation snapshot (T2): applySteerConsumed flips it in place
export default memo(function UserMsg({ item, fk, branch }: { item: UserItem; fk?: string; pending?: UserItem["pending"]; branch?: ReactNode }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Bubbles taller than three text lines (images and attachment chips included) carry a
  // fold toggle in their bottom-right corner; folded shows only the message's first line.
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);
  const [folded, setFolded] = useState(false);
  // Measured only while unfolded: a folded bubble's height is the clamped single line, which
  // would flip the toggle off. The observer covers width changes and late-loading images.
  useEffect(() => {
    const el = bubbleRef.current;
    if (!el || folded) return;
    const sync = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setTall(inner > parseFloat(cs.lineHeight) * 3);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [folded]);
  // Everything the prompt carried rides in its text: the bubble shows the user's own
  // words plus one comments chip (blocks quoted from a file / diff pane carry their
  // path + line span inside the card), the host's inlined text attachments, and
  // referenced sessions.
  const { body, notes, sessions, files } = splitQuote(item.text);
  const { copied, copy } = useCopyFeedback();
  const images = item.images ?? [];
  // @file mentions the base auto-read: chips on top, tokens stripped from the text.
  // `?? []` is authoritative: the host only writes `attachments` for files it actually read,
  // so no list means nothing was read and every `@token` here is prose (scoped package names
  // included) and must stay visible.
  const mention = atMentions(body, item.attachments ?? []);
  const lightboxList = images.map((img, i) => ({
    src: img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`,
    name: t("chat.imageN", { n: i + 1 }),
  }));

  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const streaming = useAppStore((st) => !!((st.activePath ? st.openSessions.get(st.activePath) : undefined)?.streaming));
  // Editing happens in the composer (Composer.tsx), not in the bubble: the bubble only
  // carries the "editing below" marker so the two stay visually linked
  const editing = useAppStore((st) => st.editingEntry !== null && st.editingEntry.entryId === item.entryId);
  // Grayed rather than hidden while unavailable (entryId not yet backfilled / session
  // streaming), same policy as TurnActs' canFork, so the hover row does not jump
  const canEdit = !item.pending && !item.automation && !!item.entryId && !!sessionId && !streaming;

  // Queued/steer pending-consumption message: the action row below the bubble carries the
  // steer controls (once consumed, pending clears and it becomes an ordinary message)
  const delivery = item.automation;
  // Steer bubbles awaiting consumption keep their own transient action row; media-only
  // messages and the automation card have no "first line" to fold down to.
  const foldable = tall && !!mention.text && !delivery && item.pending !== "steer";
  const cls = (delivery ? "user-bubble delivery" : "user-bubble") + (foldable ? " foldable" : "") + (folded ? " folded" : "");
  // Edit stays available on remote clients: edit_resend only appends a sibling branch
  // (see REMOTE_WRITE_DENYLIST), so it is not a read-only violation
  const showEditBtn = !item.pending && !item.automation;
  const steerAct = (fn: (sess: OpenSession, item: UserItem) => void) => (e: MouseEvent) => {
    e.stopPropagation();
    const sess = activeOpen();
    if (sess) fn(sess, item);
  };
  return (
    <div className="msg user" data-fk={fk || undefined}>
      <div className={cls} ref={bubbleRef}>
        {notes.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            <Chip list={notes} icon="messageSquareText" label={t("composer.annotateCount", { count: notes.length })} />
          </div>
        )}
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
        {(mention.paths.length > 0 ||
          files.length > 0 ||
          sessions.length > 0 ||
          mention.skills.length > 0 ||
          mention.elements.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {mention.skills.map((name) => (
              <span className="atchip" key={`skill-${name}`} title={`/skill:${name}`}>
                <span className="at-ic">
                  {/* same glyph the composer's skill chip carries (ChipNode) */}
                  <Icon name="skills" />
                </span>
                <span className="at-name">{name}</span>
              </span>
            ))}
            {mention.elements.map((block, i) => (
              <span className="atchip" key={`element-${i}`} title={block}>
                <span className="at-ic">
                  {/* same glyph the composer's picked-element chip carries (ChipNode) */}
                  <Icon name="squareMousePointer" />
                </span>
                <span className="at-name">{elementLabel(block)}</span>
              </span>
            ))}
            {mention.paths.map((p) => (
              <span className="atchip" key={p} title={p}>
                <span className="at-ic">
                  <Icon name={isDirToken(p) ? "folderOpen" : fileTypeIcon(p)} />
                </span>
                <span className="at-name">{p.split("/").pop() || p}</span>
              </span>
            ))}
            {files.map((name, i) => (
              <span className="atchip" key={`attached-${i}`} title={name}>
                <span className="at-ic">
                  <Icon name={fileTypeIcon(name)} />
                </span>
                <span className="at-name">{name}</span>
              </span>
            ))}
            {sessions.map((s, i) => (
              <span className="atchip" key={`session-${i}`} title={s.path}>
                <span className="at-ic">
                  {/* same glyph the composer's session chip carries (ChipNode) */}
                  <Icon name="comment" />
                </span>
                <span className="at-name">{s.title || s.path.split("/").pop()}</span>
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
        {mention.text ? <FadeBox className="user-msg-text whitespace-pre-wrap">{mention.text}</FadeBox> : null}
        {foldable ? (
          <button
            type="button"
            className="ub-fold q-btn"
            title={folded ? t("chat.expandMsg") : t("chat.collapseMsg")}
            aria-expanded={!folded}
            onClick={(e) => {
              e.stopPropagation();
              setFolded((v) => !v);
            }}
          >
            <Icon name={folded ? "chevronDown" : "chevronUp"} size={13} />
          </button>
        ) : null}
      </div>
      {branch || showEditBtn || body || item.pending === "steer" ? (
        <div className={"ub-actions" + (editing ? " show" : "")}>
          {/* Send time: outside the bubble, left end of the same hover row as the icons.
              The delivery card is skipped — its header already names the sender. */}
          {item.ts && !delivery ? <span className="ub-time">{stamp(item.ts)}</span> : null}
          {branch}
          {item.pending === "steer" ? (
            <>
              <button className="q-btn" title={t("chat.editBackToComposer")} onClick={steerAct(editQueueMsg)}>
                <Icon name="pencil" size={13} />
              </button>
              <button className="q-btn" title={t("chat.requeueTop")} onClick={steerAct(requeueSteerMsg)}>
                <Icon name="down" size={13} />
              </button>
            </>
          ) : null}
          {showEditBtn ? (
            editing ? (
              <span className="ub-edit-now">
                <Icon name="pencil" size={13} />
                {t("chat.editingBelow")}
              </span>
            ) : (
              <button
                className="ub-edit-btn q-btn"
                title={canEdit ? t("chat.editResend") : item.entryId ? t("chat.editWhileStreaming") : t("chat.editAfterSaved")}
                disabled={!canEdit}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canEdit || !item.entryId || !sessionId) return;
                  // Edit loads what the user wrote plus every reference the host inlined, so
                  // the chips come back and resubmitting re-inlines the same material.
                  const refs = sessions.map((s) => insertSessionRef(s.path).trim());
                  useAppStore.setState({
                    editingEntry: {
                      entryId: item.entryId,
                      sessionId,
                      text: [body, ...refs].filter(Boolean).join("\n\n"),
                      images: item.images ?? null,
                      notes,
                    },
                  });
                }}
              >
                <Icon name="pencil" size={13} />
              </button>
            )
          ) : null}
          {body ? (
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
