import { useState } from "react";
import type { OpenSession } from "../../store";
import type { UserItem } from "../../types/session";
import { activeOpen, sendNowQueueMsg, editQueueMsg, dropQueueMsg, requeueSteerMsg } from "../../store";
import Icon from "../../Icon";
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
export default function UserMsg({ item, fk }: { item: UserItem; fk?: string }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const images = item.images ?? [];
  const lightboxList = images.map((img, i) => ({
    src: img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`,
    name: t("chat.imageN", { n: i + 1 }),
  }));

  // Queued/steer pending-consumption message: hover shows the action group to the left of
  // the bubble (once consumed, pending clears and it becomes an ordinary historical message)
  const cls = item.pending ? "user-bubble pending" : "user-bubble";
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
                        ? "max-w-[320px] max-h-[240px] w-auto h-auto object-contain rounded-md block"
                        : "w-24 h-24 object-cover rounded-md block"
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
        {item.text ? <FadeBox className="user-msg-text whitespace-pre-wrap">{item.text}</FadeBox> : null}
        {item.pending ? <PendingActs item={item} /> : null}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxList}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
