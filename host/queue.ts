// Queued message domain (v14/v15 queue system): the user-message view of the
// followUp/steering queues, parking (protects the whole queue from the
// injection boundary drain), per-turn release, send-now/release/delete.
// Base queue entries carry hidden companions (image descriptions / magic
// keyword notices); operations always extract them as a group.
// 18.5: every agent-side queue mutation notifies onQueueChange subscribers
// (realtime queued-frame push lives in session-lifecycle.ts), so the handlers
// below no longer snapshot queued texts nor call sendQueued after mutating —
// only turn_end keeps one explicit push as the final calibration.
import {
  isUserQueuedMessage,
  isHiddenUserCompanion,
  toRestoredQueuedMessage,
} from "./bootstrap.ts";
import { sessions, stampEvent, type PoolEntry } from "./state.ts";
import { hostI18n } from "./i18n/host.ts";

function sendQueued(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const agent = entry.session.agent;
  // Consumed-pending suppression (see PoolEntry.consumedPending): the base's
  // preparation claim keeps a dequeued message visible in the peek views, and
  // the claim's release fires no onQueueChange — without this filter the
  // realtime queued frame would re-add an already-consumed message to the
  // queue card for the whole turn (until the agent_end calibration).
  const view = (list: readonly any[]) =>
    list
      .filter((m) => isUserQueuedMessage(m))
      .map((m) => toRestoredQueuedMessage(m))
      .filter((m) => !entry.consumedPending.has(m.text));
  const followUp = [...view(agent.peekFollowUpQueue()), ...view(entry.parkedFollowUp)];
  const steering = view(agent.peekSteeringQueue());
  ws.send(JSON.stringify(stampEvent({ type: "queued", sessionId, followUp, steering })));
}

// Trim the base followUp queue to at most 1 user message: from the 2nd on
// (with their leading hidden companions) entries move into the parked
// staging area, preventing the current run's injection boundary from
// carrying the whole queue away at once
function parkFollowUpTail(entry: PoolEntry) {
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  let n = 0;
  let cut = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === 2) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return;
  let start = cut;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  entry.parkedFollowUp.push(...queue.filter((_, i) => i >= start));
  // Single-queue replace (18.4.4): only the followUp side changes, and the
  // mutation itself fires onQueueChange, which pushes the queued frame
  agent.replaceQueue("followUp", queue.filter((_, i) => i < start));
}

// Extract the pi-th user message from the parked staging (with its leading hidden companions); returns the extracted elements
function extractParkedAt(entry: PoolEntry, pi: number): any[] {
  const parked = entry.parkedFollowUp;
  let n = -1;
  let target = -1;
  for (let i = 0; i < parked.length; i++) {
    if (!isUserQueuedMessage(parked[i])) continue;
    if (++n === pi) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(hostI18n.t("errors.queue.parkedNotFound", { index: pi }));
  let start = target;
  while (start > 0 && isHiddenUserCompanion(parked[start - 1])) start--;
  const extracted = parked.slice(start, target + 1);
  entry.parkedFollowUp = parked.filter((_, i) => i < start || i > target);
  return extracted;
}

// Release the parked head (with leading companions) back into the agent queue. Queue entries keep their original enqueued structure, so returning them directly preserves images etc.
function releaseOneParked(entry: PoolEntry): any[] {
  const u = entry.parkedFollowUp.findIndex((m) => isUserQueuedMessage(m));
  if (u < 0) return [];
  const released = entry.parkedFollowUp.slice(0, u + 1);
  entry.parkedFollowUp = entry.parkedFollowUp.slice(u + 1);
  return released;
}

// Remove the index-th user message and its immediately preceding hidden companions (image descriptions etc.); returns the filtered new array
function removeUserMessage(queue: readonly any[], index: number): any[] {
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(hostI18n.t("errors.queue.messageNotFound", { index }));
  let start = target;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  return queue.filter((_, i) => i < start || i > target);
}

function handlePeekQueued(ws: { send(data: string): unknown }, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  sendQueued(ws, sessionId, entry);
}

function handleDropQueued(
  _ws: { send(data: string): unknown },
  sessionId: string,
  which: "followUp" | "steering",
  index?: number,
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  const agent = entry.session.agent;
  const queue = which === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
  let next: any[];
  if (index === undefined) {
    // Clear all: drop only user messages and their hidden companions, keep system notices (goal/plan/budget etc.)
    next = queue.filter((m) => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m));
    if (which === "followUp") entry.parkedFollowUp = [];
  } else if (which === "followUp" && index >= queue.filter((m) => isUserQueuedMessage(m)).length) {
    // Back half of the full view: the target lives in the parked staging. A
    // stale index (degenerate-idle ghost: the message was consumed by a direct
    // turn while the client still showed it queued, BUG-080) resolves to
    // nothing — idempotent no-op instead of parkedNotFound; the replaceQueue
    // below still pushes a fresh queued frame to recalibrate the client.
    const parkedIndex = index - queue.filter((m) => isUserQueuedMessage(m)).length;
    if (parkedIndex < entry.parkedFollowUp.filter((m) => isUserQueuedMessage(m)).length) {
      extractParkedAt(entry, parkedIndex);
    }
    next = queue;
  } else {
    next = removeUserMessage(queue, index);
  }
  // Single-queue replace (18.4.4): the untouched queue keeps its live claims,
  // and every branch above funnels into one mutation that fires onQueueChange
  // (realtime queued push). Parked-only branches still replace the base queue
  // with itself, which notifies unconditionally — no explicit push needed.
  agent.replaceQueue(which, next);
}

// Send now: turn the index-th followUp entry (full view, including parked
// staging) into a steer injection;
// park all remaining queued messages so this run injects only the clicked
// one
async function handleSendNow(_ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  const queueUserCount = queue.filter((m) => isUserQueuedMessage(m)).length;
  let restored;
  if (index < queueUserCount) {
    let n = -1;
    let target = -1;
    for (let i = 0; i < queue.length; i++) {
      if (!isUserQueuedMessage(queue[i])) continue;
      if (++n === index) {
        target = i;
        break;
      }
    }
    if (target < 0) throw new Error(hostI18n.t("errors.queue.messageNotFound", { index }));
    restored = toRestoredQueuedMessage(queue[target]);
    agent.replaceQueue("followUp", removeUserMessage(queue, index));
  } else {
    // Target lives in the parked staging: extract it and re-enqueue via steer (images re-described by the SDK; rare path)
    const [msg] = extractParkedAt(entry, index - queueUserCount).filter((m) => isUserQueuedMessage(m));
    restored = toRestoredQueuedMessage(msg);
  }
  // steer() enqueues into the steering queue and parkFollowUpTail trims the
  // base queue — both fire onQueueChange, so the queued frame goes out live
  await entry.session.steer(restored.text, restored.images);
  parkFollowUpTail(entry);
}

// Reorder: move the from-th user message group (with its leading hidden
// companions) to the to-th slot of the full view (agent queue + parked
// staging). The move behaves like Array.splice(from, 1) + splice(to, 0, m):
// down = after the target group, up = before it.
function handleReorderQueued(ws: { send(data: string): unknown }, sessionId: string, from: number, to: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  const agent = entry.session.agent;
  const merged = [...agent.peekFollowUpQueue(), ...entry.parkedFollowUp];
  const groups: { start: number; end: number }[] = [];
  for (let i = 0; i < merged.length; i++) {
    if (!isUserQueuedMessage(merged[i])) continue;
    let start = i;
    while (start > 0 && isHiddenUserCompanion(merged[start - 1])) start--;
    groups.push({ start, end: i });
  }
  if (from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length) {
    // Stale index (the queue was drained/consumed while the client still showed the old rows):
    // recalibrate with an authoritative snapshot instead of silently keeping the optimistic order
    sendQueued(ws, sessionId, entry);
    return;
  }
  const src = groups[from]!;
  const dst = groups[to]!;
  const moved = merged.slice(src.start, src.end + 1);
  const rest = merged.filter((_, i) => i < src.start || i > src.end);
  // dst indices shift left by moved.length when the source sat before it
  rest.splice(from < to ? dst.end + 1 - moved.length : dst.start, 0, ...moved);
  // Re-split at the same boundary parkFollowUpTail uses (base keeps < 2 user messages)
  let cut = rest.length;
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    if (!isUserQueuedMessage(rest[i])) continue;
    if (++n === 2) {
      cut = i;
      while (cut > 0 && isHiddenUserCompanion(rest[cut - 1])) cut--;
      break;
    }
  }
  entry.parkedFollowUp = rest.slice(cut);
  agent.replaceQueue("followUp", rest.slice(0, cut));
}

// Requeue: move the index-th steer-queue entry back to the top of followUp (dropping the steer marker)
function handleRequeue(_ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  const agent = entry.session.agent;
  const queue = agent.peekSteeringQueue();
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(hostI18n.t("errors.queue.steerNotFound", { index }));
  const moved: any = { ...queue[target] };
  delete moved.steering;
  // Both queues change here (steering loses the entry, followUp gains it at
  // the top), so the two-queue replaceQueues stays: one atomic mutation, one
  // onQueueChange notification, and listeners never observe the message in
  // both queues or in neither
  agent.replaceQueues(removeUserMessage(queue, index), [moved, ...agent.peekFollowUpQueue()]);
  // moved becomes the single 1st entry of the base queue; the former queue head retreats to the parked head (keeping FIFO order)
  parkFollowUpTail(entry);
}

export { sendQueued, parkFollowUpTail, releaseOneParked, handlePeekQueued, handleDropQueued, handleSendNow, handleRequeue, handleReorderQueued };
