// Full-size image lightbox preview: exit via background click / ESC / the close button,
// previous/next switching, zoom (buttons, wheel, double-click, +/- keys) with panning at
// scale > 1, and download.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
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

/** Zoom bounds: below 1 the image shrinks below its fit size (useful for tall shots), above it grows well past the viewport. */
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
/** Wheel/key step. */
const ZOOM_STEP = 0.25;
/** Panning is pointless until the image overflows the viewport. */
const PANNABLE_AT = 1.001;

export default function ImageLightbox({ images, initialIndex = 0, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Pointer drag state lives in refs: it changes every move event and must not re-render.
  const drag = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const total = images.length;
  const current = images[index];
  const panning = scale > PANNABLE_AT;

  // Reset the viewport whenever the displayed image changes (next/prev, or a new list).
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [index]);

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s * factor).toFixed(3))));
  }, []);
  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && total > 1) {
        setIndex((i) => (i - 1 + total) % total);
      } else if (e.key === "ArrowRight" && total > 1) {
        setIndex((i) => (i + 1) % total);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(1 + ZOOM_STEP * 2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(1 / (1 + ZOOM_STEP * 2));
      } else if (e.key === "0") {
        e.preventDefault();
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [total, onClose, zoomBy, resetView]);

  if (!current) return null;

  // Ctrl/⌘+wheel is the platform gesture for zooming (macOS pinch, Windows trackpad pinch);
  // a bare wheel stays a background click (closing) as before.
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    zoomBy(e.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panning || e.button !== 0) return;
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none"
      data-modal="lightbox"
      onClick={onClose}
      onWheel={onWheel}
      data-tauri-drag-region="false"
    >
      {/* Top action bar */}
      <div
        className="absolute top-3 right-4 flex items-center gap-2 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-0.5 bg-black/40 rounded-md px-0.5">
          <button
            className="icon-btn text-white/80 hover:text-white hover:bg-black/60 rounded-md p-1.5 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            title={t("chat.zoomOut")}
            disabled={scale <= MIN_SCALE}
            onClick={() => zoomBy(1 / (1 + ZOOM_STEP))}
          >
            <Icon name="zoomOut" size={16} />
          </button>
          <button
            className="icon-btn text-white/70 hover:text-white rounded-md px-1 min-w-[3.25rem] tabular-nums transition-colors"
            title={t("chat.resetZoom")}
            onClick={resetView}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            className="icon-btn text-white/80 hover:text-white hover:bg-black/60 rounded-md p-1.5 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            title={t("chat.zoomIn")}
            disabled={scale >= MAX_SCALE}
            onClick={() => zoomBy(1 + ZOOM_STEP)}
          >
            <Icon name="zoomIn" size={16} />
          </button>
        </div>
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
          onDoubleClick={(e) => {
            e.stopPropagation();
            // Double-click toggles between fit and 2x — the viewer convention.
            if (scale > PANNABLE_AT) resetView();
            else zoomBy(2);
          }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="max-w-full max-h-[90vh] object-contain rounded-md shadow-2xl select-none"
          style={
            panning
              ? { transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: "grab" }
              : { transform: `scale(${scale})` }
          }
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