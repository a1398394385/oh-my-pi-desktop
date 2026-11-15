// Attachment row (ported from the old composer.js renderAttachRow): image
// attachments render as thumbnail preview cards (the base64 payload is already
// in the store) and open the shared chat lightbox on click, text-like files
// keep the icon chip; data comes from pendingFiles, nothing renders when empty
// (equivalent to the old hidden).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump } from "../../store";
import { type PendingAnnotation } from "../../store/annotations";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import ImageLightbox from "../chat/ImageLightbox";
import AnnotationChips from "./AnnotationChips";

// Stable empty reference: a fresh [] in the selector would re-render every store write
const NO_ANNOTATIONS: PendingAnnotation[] = [];

// A pending attachment (structural subset of a pendingFiles element; see
// types/session for the full shape)
type PendingFile = { id: number; name?: string; kind: string; mime?: string; data?: string };

export default function AttachRow() {
  const { t } = useTranslation();
  const pendingFiles = useAppStore((st) => st.pendingFiles);
  const annotations = useAppStore((st) => st.annotations[st.activePath ?? ""] ?? NO_ANNOTATIONS);
  // Editing a sent message shows that message's images here (they ride edit_resend, not the
  // draft's attachments), so the user can see and drop what is about to be resent.
  const editImages = useAppStore((st) => st.editingEntry?.images ?? null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [editZoom, setEditZoom] = useState<number | null>(null);
  const srcOfEdit = (i: number) => {
    const img = editImages?.[i];
    return img ? (img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`) : "";
  };
  const dropEditImage = (i: number) =>
    useAppStore.setState((st) =>
      st.editingEntry
        ? { editingEntry: { ...st.editingEntry, images: st.editingEntry.images?.filter((_, j) => j !== i) ?? null } }
        : {},
    );
  if (pendingFiles.length === 0 && annotations.length === 0 && !editImages?.length) return null;
  const images = pendingFiles.filter((f: PendingFile) => f.kind === "image");
  const srcOf = (f: PendingFile) => `data:${f.mime || "image/png"};base64,${f.data}`;
  const remove = (f: PendingFile) =>
    setBump({ pendingFiles: pendingFiles.filter((it: PendingFile) => it.id !== f.id) });
  return (
    <div className="attach-row" id="attachRow">
      {annotations.length > 0 && <AnnotationChips list={annotations} />}
      {editImages?.map((img, i) => (
        <span className="at-thumb" key={`edit-${i}`}>
          <button
            type="button"
            className="group relative block h-full w-full cursor-pointer overflow-hidden rounded-md border-0 bg-transparent p-0"
            onClick={() => setEditZoom(i)}
            title={t("chat.clickToZoom")}
          >
            <img src={srcOfEdit(i)} alt="" draggable={false} className="block h-full w-full object-cover" />
          </button>
          <button className="atchip-x" title={t("composer.remove")} onClick={() => dropEditImage(i)}>
            ×
          </button>
        </span>
      ))}
      {pendingFiles.map((f: PendingFile) =>
        f.kind === "image" ? (
          <span className="at-thumb" key={f.id} title={f.name}>
            <button
              type="button"
              className="group relative block h-full w-full cursor-pointer overflow-hidden rounded-md border-0 bg-transparent p-0"
              onClick={() => setZoom(images.findIndex((im: PendingFile) => im.id === f.id))}
              title={t("chat.clickToZoom")}
            >
              <img src={srcOf(f)} alt={f.name} draggable={false} className="block h-full w-full object-cover" />
              <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Icon name="search" size={14} />
              </span>
            </button>
            <button className="atchip-x" title={t("composer.remove")} onClick={() => remove(f)}>×</button>
          </span>
        ) : (
          <span className="atchip" key={f.id}>
            <span className="at-ic"><Icon name={fileTypeIcon(f.name)} /></span>
            <span className="at-name" title={f.name}>{f.name}</span>
            <button className="atchip-x" title={t("composer.remove")} onClick={() => remove(f)}>×</button>
          </span>
        ),
      )}
      {editZoom !== null && editImages && editImages.length > 0 && (
        <ImageLightbox
          images={editImages.map((_, i) => ({ src: srcOfEdit(i), name: "" }))}
          initialIndex={editZoom}
          onClose={() => setEditZoom(null)}
        />
      )}
      {zoom !== null && images.length > 0 && (
        <ImageLightbox
          images={images.map((f) => ({ src: srcOf(f), name: f.name }))}
          initialIndex={zoom}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
