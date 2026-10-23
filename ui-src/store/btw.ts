// /btw side-conversation slice: per-session topics, the composer draft, and the RPC senders.
// Frame landings (btw_delta/btw_record/btw_history) live in store/wsHandlers/btw.ts and mutate
// this slice's state via useAppStore.setState with fresh Map/record references.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { BtwRecord } from "../types/frames";

export interface BtwSlice {
  /** sessionId → topics, newest first (from btw_history plus live btw_record checkpoints) */
  btwTopics: Map<string, BtwRecord[]>;
  btwDraft: string;
  btwSetDraft(text: string): void;
  /** Topic the panel should open directly (set by a /btw ask); consumed by BtwPage. */
  btwFocus: string | null;
  btwFocusTopic(recordId: string | null): void;
  /** Bumped when a bare /btw (no question) asks the panel for the topic directory;
   * btwFocus cannot express that because its null already means "no signal". */
  btwRootSeq: number;
  btwShowRoot(): void;
  btwLoad(sessionId: string): void;
  /** `recordId` follows up in that topic; undefined starts a new one. */
  btwSend(sessionId: string, question: string, recordId?: string): void;
  btwCancelTopic(sessionId: string, recordId: string): void;
  btwPromoteTopic(sessionId: string, recordId: string): void;
}

export const createBtwSlice: StateCreator<AppStore, [], [], BtwSlice> = (set, get) => ({
  btwTopics: new Map(),
  btwDraft: "",
  btwSetDraft(text) {
    set({ btwDraft: text });
  },
  btwFocus: null,
  btwFocusTopic(recordId) {
    set({ btwFocus: recordId });
  },
  btwRootSeq: 0,
  btwShowRoot() {
    set((st) => ({ btwRootSeq: st.btwRootSeq + 1 }));
  },
  btwLoad(sessionId) {
    get().send({ type: "btw_history", sessionId });
  },
  btwSend(sessionId, question, recordId) {
    if (!question.trim()) return;
    get().send({ type: "btw_ask", sessionId, question, recordId });
    set({ btwDraft: "" });
  },
  btwCancelTopic(sessionId, recordId) {
    get().send({ type: "btw_cancel", sessionId, recordId });
  },
  btwPromoteTopic(sessionId, recordId) {
    get().send({ type: "btw_promote", sessionId, recordId });
  },
});
