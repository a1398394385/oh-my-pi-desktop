// /btw side-conversation frame landings: topic checkpoints, answer deltas, and history
// snapshots. Containers are replaced with fresh references (zustand re-render contract).
import { useAppStore } from "../index";
import { openRightTab } from "../../components/main/right/tabs";
import type { BtwRecord } from "../../types/frames";
import type { HandlerSlice } from "./types";

/** Insert/replace one topic in the session's list, keeping newest-first order. */
function upsertTopic(sessionId: string, record: BtwRecord): void {
  useAppStore.setState((s) => {
    const list = s.btwTopics.get(sessionId) ?? [];
    const next = list.some((r) => r.id === record.id)
      ? list.map((r) => (r.id === record.id ? record : r))
      : [...list, record];
    next.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { btwTopics: new Map(s.btwTopics).set(sessionId, next) };
  });
}

export const btwHandlers = {
  btw_history(msg) {
    useAppStore.setState((s) => ({ btwTopics: new Map(s.btwTopics).set(msg.sessionId, msg.records) }));
  },
  btw_record(msg) {
    upsertTopic(msg.sessionId, msg.record);
  },
  btw_delta(msg) {
    useAppStore.setState((s) => {
      const list = s.btwTopics.get(msg.sessionId);
      if (!list) return {};
      const next = list.map((r) => {
        if (r.id !== msg.recordId) return r;
        // Delta appends to the latest turn (the running one): follow-up chain else opening turn
        if (r.followUps?.length) {
          return { ...r, followUps: [...r.followUps.slice(0, -1), { ...r.followUps[r.followUps.length - 1]!, answer: r.followUps[r.followUps.length - 1]!.answer + msg.delta }] };
        }
        return { ...r, answer: r.answer + msg.delta };
      });
      return { btwTopics: new Map(s.btwTopics).set(msg.sessionId, next) };
    });
  },
  // /btw pulls up the Side Chat panel (openRightTab also expands the collapsed panel)
  open_right_tab(msg) {
    openRightTab(msg.name);
  },
} as const satisfies HandlerSlice;

export type BtwFrames = "btw_history" | "btw_record" | "btw_delta" | "open_right_tab";
