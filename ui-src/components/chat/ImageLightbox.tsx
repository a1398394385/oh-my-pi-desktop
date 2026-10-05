// Full-size image lightbox preview: exit via background click / ESC / the close button,
// previous/next switching, and download.
import { useEffect, useState } from "react";
import Icon from "../../Icon";
import { t } from "../../i18n";

export interface LightboxImage {
  src: string;
  name?: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  initialIndex?: number;
  onClose: () => void;
}

export default function ImageLightbox({ images, initialIndex = 0, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const total = images.length;
  const current = images[index];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && total > 1) {
        setIndex((i) => (i - 1 + total) % total);
      } else if (e.key === "ArrowRight" && total > 1) {
        setIndex((i) => (i + 1) % total);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [total, onClose]);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none"
      data-modal="lightbox"
      onClick={onClose}
      data-tauri-drag-region="false"
    >
      {/* Top action bar */}
      <div
        className="absolute top-3 right-4 flex items-center gap-2 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        {total > 1 && (
          <span className="text-xs text-white/70 px-2 py-1 bg-black/40 rounded-md">
            {index + 1} / {total}
          </span>
        )}
        <a
          href={current.src}
          download={current.name || `image-${index + 1}.png`}
          className="icon-btn bg-black/40 text-white/80 hover:text-white hover:bg-black/60 rounded-md p-1.5 transition-colors"
          title={t("chat.downloadImage")}
        >
          <Icon name="download" size={16} />
        </a>
        <button
          className="icon-btn bg-black/40 text-white/80 hover:text-white hover:bg-black/60 rounded-md p-1.5 transition-colors"
          title={t("chat.closeEsc")}
          onClick={onClose}
        >
          <Icon name="xmark" size={16} />
        </button>
      </div>

      {/* Switch to previous */}
      {total > 1 && (
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 icon-btn bg-black/40 hover:bg-black/70 text-white p-2.5 rounded-full transition-colors z-10"
          title={t("chat.prevImage")}
          onClick={(e) => {
            e.stopPropagation();
            setIndex((i) => (i - 1 + total) % total);
          }}
        >
          <Icon name="chevronLeft" size={20} />
        </button>
      )}

      {/* Main image body */}
      <div
        className="max-w-[92vw] max-h-[90vh] flex items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={current.src}
          alt={current.name || t("chat.previewImage")}
          className="max-w-full max-h-[90vh] object-contain rounded-md shadow-2xl transition-transform"
        />
      </div>

      {/* Switch to next */}
      {total > 1 && (
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 icon-btn bg-black/40 hover:bg-black/70 text-white p-2.5 rounded-full transition-colors z-10"
          title={t("chat.nextImage")}
          onClick={(e) => {
            e.stopPropagation();
            setIndex((i) => (i + 1) % total);
          }}
        >
          <Icon name="chevronRight" size={20} />
        </button>
      )}
    </div>
  );
}
