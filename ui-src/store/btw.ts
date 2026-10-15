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
  /** Topic id the composer follows up in; null = composer starts a new topic */
  btwReplyTo: string | null;
  btwSetDraft(text: string): void;
  btwReplyToTopic(id: string | null): void;
  btwLoad(sessionId: string): void;
  btwSend(sessionId: string, question: string): void;
  btwCancelTopic(sessionId: string, recordId: string): void;
  btwPromoteTopic(sessionId: string, recordId: string): void;
}

export const createBtwSlice: StateCreator<AppStore, [], [], BtwSlice> = (set, get) => ({
  btwTopics: new Map(),
  btwDraft: "",
  btwReplyTo: null,
  btwSetDraft(text) {
    set({ btwDraft: text });
  },
  btwReplyToTopic(id) {
    set({ btwReplyTo: id });
  },
  btwLoad(sessionId) {
    get().send({ type: "btw_history", sessionId });
  },
  btwSend(sessionId, question) {
    const st = get();
    if (!question.trim()) return;
    st.send({ type: "btw_ask", sessionId, question, recordId: st.btwReplyTo ?? undefined });
    set({ btwDraft: "", btwReplyTo: null });
  },
  btwCancelTopic(sessionId, recordId) {
    get().send({ type: "btw_cancel", sessionId, recordId });
  },
  btwPromoteTopic(sessionId, recordId) {
    get().send({ type: "btw_promote", sessionId, recordId });
  },
});
