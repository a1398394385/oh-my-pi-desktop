// Drag handle between two Git-page panes. Three separators exist: the
// commit-detail column width (x, measured from the right edge), the
// graph/branch split in the center column (y) and the commit-info/files split in
// the detail column (y).
//
// The drag writes a CSS variable straight onto the `.gp-body` host instead of
// going through React state: the page renders a multi-thousand-row branch tree,
// and a state update per mousemove would re-render all of it. The saved size is
// committed once on release.
import { useEffect, useRef } from "react";
import { useAppStore } from "../../../store";

export type SplitKind = "rightw" | "center" | "right";

interface SplitConfig {
  axis: "x" | "y";
  cssVar: string;
  storageKey: string;
  min: number;
  className: string;
  /** Pane measured by the drag: the previous sibling, or the next one on the right edge. */
  target: "prev" | "next";
  /** Dragging left grows the pane (the detail column sits on the right edge). */
  invert: boolean;
}

/** Center column never gets narrower than this while dragging a side column. */
const MIN_CENTER = 480;

const SPLIT: Record<SplitKind, SplitConfig> = {
  rightw: { axis: "x", cssVar: "--gp-right-w", storageKey: "omp-gp-right-w", min: 200, className: "gp-split-right", target: "next", invert: true },
  center: { axis: "y", cssVar: "--gp-center-top", storageKey: "omp-gp-center-top", min: 140, className: "gp-split-y", target: "prev", invert: false },
  right: { axis: "y", cssVar: "--gp-right-top", storageKey: "omp-gp-right-top", min: 120, className: "gp-split-y", target: "prev", invert: false },
};

export default function SplitHandle({ kind }: { kind: SplitKind }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cfg = SPLIT[kind];

  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>(".gp-body");
    if (!host) return;
    try {
      const saved = Number(localStorage.getItem(cfg.storageKey));
      if (Number.isFinite(saved) && saved > 0) host.style.setProperty(cfg.cssVar, `${Math.round(saved)}px`);
    } catch {
      // private mode / quota: the default size is fine
    }
  }, [cfg]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const host = handle.closest<HTMLElement>(".gp-body");
    const panel = (cfg.target === "prev" ? handle.previousElementSibling : handle.nextElementSibling) as HTMLElement | null;
    if (!host || !panel) return;
    const box = host.getBoundingClientRect();
    const startSize = cfg.axis === "x" ? panel.offsetWidth : panel.offsetHeight;
    const startPos = cfg.axis === "x" ? e.clientX : e.clientY;
    // The graph column keeps at least MIN_CENTER px, the stacked panes 140px.
    const max =
      cfg.axis === "x"
        ? Math.max(cfg.min, box.width - MIN_CENTER)
        : Math.max(cfg.min, box.height - 140);
    const zoom = useAppStore.getState().zoomLevel || 1;
    const move = (ev: MouseEvent) => {
      const raw = ((cfg.axis === "x" ? ev.clientX : ev.clientY) - startPos) / zoom;
      const delta = cfg.invert ? -raw : raw;
      const next = Math.round(Math.min(max, Math.max(cfg.min, startSize + delta)));
      host.style.setProperty(cfg.cssVar, `${next}px`);
    };
    const dragClass = cfg.axis === "x" ? "gp-resizing-x" : "gp-resizing-y";
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove(dragClass);
      const current = Number.parseFloat(host.style.getPropertyValue(cfg.cssVar));
      if (Number.isFinite(current)) {
        try {
          localStorage.setItem(cfg.storageKey, String(Math.round(current)));
        } catch {
          // ignore: the run-time size still applies
        }
      }
    };
    document.body.classList.add(dragClass);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  return <div ref={ref} className={cfg.className} role="separator" onMouseDown={onMouseDown} />;
}
