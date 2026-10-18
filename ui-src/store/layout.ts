// Narrow single-column layout slice (remote-control spec §4.3): which page owns the
// viewport on ≤768px screens — session list, chat, or the right panel — plus the
// media-query listener driving `narrow`. Navigation follows the ZCode remote model:
// no persistent bottom tabs, every page replaces the previous one (the chat header
// carries back/panel entries, picking a session jumps to chat).
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { setBump, useAppStore } from "./index";

export type MobileCol = "left" | "main" | "right";

// Phone baseline (narrow only): the phone layout reads ~20% too large at the desktop
// scale, so the narrow UI pins zoom level 100% to that 80% visual size. The store keeps
// the raw user-facing level (100% on the zoom control); everything that converts between
// visual pixels (getBoundingClientRect) and layout px must go through effZoom().
export const NARROW_ZOOM_BASE = 0.8;

/** Effective DOM zoom factor: raw zoom level × narrow baseline. */
export function effZoom(): number {
  const st = useAppStore.getState();
  return (st.zoomLevel || 1) * (st.narrow ? NARROW_ZOOM_BASE : 1);
}

/** Same factor as a store selector (components that render a zoom-dependent style). */
export function useEffZoom(): number {
  return useAppStore((s) => (s.zoomLevel || 1) * (s.narrow ? NARROW_ZOOM_BASE : 1));
}

export interface LayoutSlice {
  /** Page shown when `narrow`: session list ("left"), chat ("main") or right panel ("right") */
  mobileCol: MobileCol;
  /** Viewport ≤768px (matchMedia "(max-width: 768px)"); drives App's one-column render */
  narrow: boolean;
  setMobileCol(col: MobileCol): void;
}

// Remote-mode predicate (spec §4.1): outside the Tauri shell and not the ?preview=1 debug
// page = a browser remote client; a ?ws= dev direct-connect is a local channel instead
// (.has() form kept identical to ws.ts/Composer.tsx so an invalid port degrades the same
// way in all three). This duplicate keeps App/slices free of a ws.ts import cycle.
export const REMOTE =
  !window.__TAURI__?.core?.invoke &&
  !new URLSearchParams(location.search).has("preview") &&
  !new URLSearchParams(location.search).has("ws");

const narrowMql = window.matchMedia("(max-width: 768px)");
// setBump (not bare set) so the listener update flows through the store's named write entry
// like every other state transition.
narrowMql.addEventListener("change", () => setBump({ narrow: narrowMql.matches }));

export const createLayoutSlice: StateCreator<AppStore, [], [], LayoutSlice> = (set) => ({
  // A remote client lands on the session list first (ZCode's task home); a desktop window
  // dragged narrow keeps whatever it was showing.
  mobileCol: narrowMql.matches && REMOTE ? "left" : "main",
  narrow: narrowMql.matches,
  setMobileCol(col) {
    set({ mobileCol: col });
  },
});
