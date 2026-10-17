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
// a steer) / edited (back into the composer) / deleted / reordered via the
// per-row up/down arrows (always visible; edge rows keep the fixed slot width).
// The steer-state bubble action group (requeueSteerMsg) lives on the bubble
// side, owned by chat-wave; only the followUp queue is rendered here.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, sendNowQueueMsg, editQueueMsg, dropQueueMsg, reorderQueueMsg } from "../../store";
import type { UserItem } from "../../types/session";
import Icon from "../../Icon";
import ImageLightbox, { type LightboxImage } from "../chat/ImageLightbox";

// Horizontal scrollable queue text: wheel converts to horizontal scroll (React's
// onWheel is passive at the root, so it rides a manual listener, same recipe as
// ExtensionsPage pills) and edge fades (ql/qr classes, same three-state recipe as
// .ro-body.rt/.rb) only cover sides with hidden content.
function QcText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const canL = el.scrollLeft > 1;
      const canR = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      el.classList.toggle("ql", canL);
      el.classList.toggle("qr", canR);
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", sync);
      el.removeEventListener("wheel", onWheel);
    };
  }, [text]);
  return <span ref={ref} className="qc-tx">{text}</span>;
}

export default function QueueCard() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const items = s?.queued ?? [];
  // Image preview target (queue rows show chips, not thumbnails)
  const [viewer, setViewer] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  if (!s || items.length === 0) return null; // without a session items is always empty; the merged early return matches the original logic
  return (
    <div className="queue-card" id="queueCard">
      {items.map((m, i) => {
        const item: UserItem = {
          role: "user",
          text: m.text || "",
          pending: "queued",
          ...(m.images ? { images: m.images } : {}),
        }; // pseudo item shared with the bubble actions
        // Edge rows hide the unavailable direction; the slot keeps its two-slot width either way
        const canUp = i > 0;
        const canDown = i < items.length - 1;
        const single = items.length === 1;
        return (
          <div className="qc-row" key={i} title={t("composer.queuedHint")}>
            <span className="qc-sortctl">
              {(canUp || single) && (
                <button
                  className="q-btn"
                  title={t("composer.moveUp")}
                  disabled={!canUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    reorderQueueMsg(s, i, i - 1);
                  }}
                >
                  <Icon name="moveUp" size={14} />
                </button>
              )}
              {(canDown || single) && (
                <button
                  className="q-btn"
                  title={t("composer.moveDown")}
                  disabled={!canDown}
                  onClick={(e) => {
                    e.stopPropagation();
                    reorderQueueMsg(s, i, i + 1);
                  }}
                >
                  <Icon name="moveDown" size={14} />
                </button>
              )}
            </span>
            {(m.images ?? []).map((_, k) => (
              <button
                className="q-btn qc-img"
                key={`img-${k}`}
                title={t("chat.clickToZoom")}
                onClick={(e) => {
                  e.stopPropagation();
                  setViewer({
                    images: (m.images ?? []).map((x, n) => ({
                      src: x.data.startsWith("data:") ? x.data : `data:${x.mimeType || "image/png"};base64,${x.data}`,
                      name: t("chat.imageN", { n: n + 1 }),
                    })),
                    index: k,
                  });
                }}
              >
                <Icon name="image" size={14} />
              </button>
            ))}
            <QcText text={m.text || t("composer.noText")} />
            <button
              className="q-btn"
              title={t("composer.sendNow")}
              onClick={(e) => { e.stopPropagation(); sendNowQueueMsg(s, item, i); }}
            ><Icon name="upload" size={14} /></button>
            <button
              className="q-btn"
              title={t("composer.editQueued")}
              onClick={(e) => { e.stopPropagation(); editQueueMsg(s, item, i); }}
            ><Icon name="pencil" size={14} /></button>
            <button
              className="q-btn"
              title={t("common.delete")}
              onClick={(e) => { e.stopPropagation(); dropQueueMsg(s, item, i); }}
            ><Icon name="trash" size={14} /></button>
          </div>
        );
      })}
      {viewer && (
        <ImageLightbox images={viewer.images} initialIndex={viewer.index} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
