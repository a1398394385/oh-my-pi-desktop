// Queued-message actions (split from store/session.ts to respect its line
// cap): the five user-facing queue operations — drop/edit/send-now/reorder/
// requeue — shared by UserMsg's bubble action group and QueueCard. Pure store state +
import { useAppStore } from "./index";
import { updateSession } from "./session";
import type { HostRequest } from "../types/frames";
import type { OpenSession, SessionItem } from "../types/session";

// Send helper via the ws slice (stable reference, same shape as session.ts's local send)
const send = (obj: HostRequest): void => {
  useAppStore.getState().send(obj);
};

function queueIndexOf(list: { text?: string }[] | undefined, text: string | undefined): number {
  return (list ?? []).findIndex((m) => (m.text || "") === text);
}

// Delete: dequeue + remove the bubble. Queue bubbles are always user entries (the pending marker
// only lands on UserItem); non-user entries hit the early return (never happens at runtime, exists
// only to narrow the discriminated union)
// Identical texts are common once rows carry images (image-only rows all read "[Image]"): the
// queue card passes the row index; other call sites fall back to the text lookup
export function dropQueueMsg(s: OpenSession, item: SessionItem, index?: number): void {
  if (item.role !== "user") return;
  const which = item.pending === "steer" ? "steering" : "followUp";
  const list = which === "steering" ? s.steering : s.queued;
  const i = index ?? queueIndexOf(list, item.text);
  if (i < 0 || !list) return; // when i >= 0 the list must exist (queueIndexOf always returns -1 for undefined)
  send({ type: "drop_queued", sessionId: s.sessionId, queue: which, index: i });
  updateSession(s.sessionId, (next) => {
    const l = which === "steering" ? next.steering : next.queued;
    const ni = index ?? queueIndexOf(l, item.text);
    if (ni >= 0 && l && ni < l.length) l.splice(ni, 1); // re-look up after the update (concurrent frames may have changed the queue meanwhile)
    const j = next.items.lastIndexOf(item);
    if (j >= 0) next.items.splice(j, 1);
  });
}

// Edit: put the content (images included) back into the composer (composerSetSignal is consumed by a Composer effect), then delete
export function editQueueMsg(s: OpenSession, item: SessionItem, index?: number): void {
  const i = index ?? queueIndexOf(s.queued, item.text);
  const images = (i >= 0 ? s.queued?.[i]?.images : undefined) ?? (item.role === "user" ? item.images : undefined);
  useAppStore.getState().setComposerValue(item.text ?? "", images);
  dropQueueMsg(s, item, index);
}

// Send now: switch from queued to steer state. No process truncation, no pre-seal — the split only
// happens at consumption time (steer_consumed seals the whole process above the bubble into a loop
// group); the bubble is pinned by the render layer at the bottom of the message stream
export function sendNowQueueMsg(s: OpenSession, item: SessionItem, index?: number): void {
  const i = index ?? queueIndexOf(s.queued, item.text);
  if (i < 0) return;
  send({ type: "send_now", sessionId: s.sessionId, index: i });
  updateSession(s.sessionId, (next) => {
    const ni = index ?? queueIndexOf(next.queued, item.text);
    // Images ride on the queue row; the synthetic steer bubble/row inherits them
    const images = (ni >= 0 ? next.queued?.[ni]?.images : undefined) ?? (item.role === "user" ? item.images : undefined);
    if (ni >= 0 && next.queued && ni < next.queued.length) next.queued.splice(ni, 1);
    next.steering = next.steering ?? [];
    next.steering.push({ text: item.text, ...(images ? { images } : {}) });
    next.items.push({ role: "user", text: item.text, pending: "steer", ...(images ? { images } : {}) });
  });
}

// Reorder: move the from-th queued message to the to-th slot (queue card drag); mirrors the
// host's splice(from, 1) + splice(to, 0, m) so the optimistic order matches the queued frame
export function reorderQueueMsg(s: OpenSession, from: number, to: number): void {
  const list = s.queued;
  if (!list || from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  send({ type: "reorder_queued", sessionId: s.sessionId, from, to });
  updateSession(s.sessionId, (next) => {
    const l = next.queued;
    if (!l) return;
    const [m] = l.splice(from, 1);
    if (m) l.splice(to, 0, m);
  });
}

// Requeue: switch steer state back to the head of the queue, removing the bubble (the message lives only in the queue card)
export function requeueSteerMsg(s: OpenSession, item: SessionItem): void {
  const i = queueIndexOf(s.steering, item.text);
  if (i < 0) return;
  send({ type: "requeue", sessionId: s.sessionId, index: i });
  updateSession(s.sessionId, (next) => {
    const ni = queueIndexOf(next.steering, item.text);
    // Images ride on the steer row; carry them back into the queue card
    const images = (ni >= 0 ? next.steering?.[ni]?.images : undefined) ?? (item.role === "user" ? item.images : undefined);
    if (ni >= 0 && next.steering) next.steering.splice(ni, 1);
    next.queued = next.queued ?? [];
    next.queued.unshift({ text: item.text, ...(images ? { images } : {}) });
    const j = next.items.lastIndexOf(item);
    if (j >= 0) next.items.splice(j, 1);
  });
}
