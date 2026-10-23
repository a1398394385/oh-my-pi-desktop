// Collab live-sharing slice: per-session collab state (role/links/participants)
// landed from collab_state frames, plus the dialog flag and the four RPC
// senders. Frame landing lives in store/wsHandlers/collab.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { CollabRpcState } from "../types/frames";

export interface CollabSlice {
  /** sessionId → latest collab_state payload (absent = never shared) */
  collabStates: Map<string, CollabRpcState>;
  /** In-flight collab_start/join/leave (set by senders, cleared by the reply frame) */
  collabBusy: boolean;
  /** Last collab op failure for the dialog's inline display (at = change key) */
  collabError: { sessionId: string; message: string; at: number } | null;
  collabOpen: boolean;
  collabOpenDialog(): void;
  collabCloseDialog(): void;
  collabRefresh(sessionId: string): void;
  collabStart(sessionId: string, relayUrl?: string): void;
  collabJoin(sessionId: string, link: string): void;
  collabLeave(sessionId: string): void;
}

export const createCollabSlice: StateCreator<AppStore, [], [], CollabSlice> = (set, get) => ({
  collabStates: new Map(),
  collabBusy: false,
  collabError: null,
  collabOpen: false,
  collabOpenDialog() {
    set({ collabOpen: true, collabError: null });
  },
  collabCloseDialog() {
    set({ collabOpen: false });
  },
  collabRefresh(sessionId) {
    get().send({ type: "collab_state", sessionId });
  },
  collabStart(sessionId, relayUrl) {
    set({ collabBusy: true, collabError: null });
    get().send({ type: "collab_start", sessionId, ...(relayUrl?.trim() ? { relayUrl: relayUrl.trim() } : {}) });
  },
  collabJoin(sessionId, link) {
    set({ collabBusy: true, collabError: null });
    get().send({ type: "collab_join", sessionId, link });
  },
  collabLeave(sessionId) {
    set({ collabBusy: true, collabError: null });
    get().send({ type: "collab_leave", sessionId });
  },
});
