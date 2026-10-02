// Single zustand store (P3 wave 2: slice composition). AppStore = the intersection composition of
// six slices; fields and initial values moved over from store.ts with zero field renames.
// Module-level functions in the slice files close over this file's useAppStore (runtime calls,
// no load-time evaluation — ESM-cycle safe).
import { create } from "zustand";
import { createUiSlice, type UiSlice } from "./ui";
import { createSessionSlice, type SessionSlice } from "./session";
import { createProjectsSlice, type ProjectsSlice } from "./projects";
import { createRightSlice, type RightSlice } from "./right";
import { createSettingsSlice, type SettingsSlice } from "./settings";
import { createWsSlice, type WsSlice } from "./ws";

export interface AppStore extends UiSlice, SessionSlice, ProjectsSlice, RightSlice, SettingsSlice, WsSlice {}

export const useAppStore = create<AppStore>()((...a) => ({
  ...createUiSlice(...a),
  ...createSessionSlice(...a),
  ...createProjectsSlice(...a),
  ...createRightSlice(...a),
  ...createSettingsSlice(...a),
  ...createWsSlice(...a),
}));

/** Write helper (a passthrough alias of zustand setState; kept as a named entry for component ergonomics and later convergence) */
export function setBump(partial: Partial<AppStore>): void {
  useAppStore.setState(partial);
}

// Note: no global subscribe auto-fallback — a set inside a subscribe callback (even microtask-
// deferred) cascades synchronously with React 19's useSyncExternalStore into an infinite loop
// (#185 / async variant, both reproduced); render triggering always goes through explicit
// setState swapping values/references.