// Narrow single-column layout slice (remote-control spec §4.3): which page owns the
// viewport on ≤768px screens — session list, chat, or the right panel — plus the
// media-query listener driving `narrow`. Navigation follows the ZCode remote model:
// no persistent bottom tabs, every page replaces the previous one (the chat header
// carries back/panel entries, picking a session jumps to chat).
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { setBump } from "./index";

export type MobileCol = "left" | "main" | "right";

export interface LayoutSlice {
  /** Page shown when `narrow`: session list ("left"), chat ("main") or right panel ("right") */
  mobileCol: MobileCol;
  /** Viewport ≤768px (matchMedia "(max-width: 768px)"); drives App's one-column render */
  narrow: boolean;
  setMobileCol(col: MobileCol): void;
}

// Remote-mode predicate (spec §4.1): outside the Tauri shell and not the ?preview=1 debug
// page = a browser remote client. Same form as the ws.ts branch (ws.ts owns the connection
// side; this duplicate keeps App/slices free of a ws.ts import cycle).
export const REMOTE = !window.__TAURI__?.core?.invoke && !new URLSearchParams(location.search).has("preview");

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
