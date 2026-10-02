// Queued message domain (v14/v15 queue system): the user-message view of the
// followUp/steering queues, parking (protects the whole queue from the
// injection boundary drain), per-turn release, send-now/release/delete.
// Base queue entries carry hidden companions (image descriptions / magic
// keyword notices); operations always extract them as a group.
import {
  isUserQueuedMessage,
  isHiddenUserCompanion,
  toRestoredQueuedMessage,
} from "./bootstrap.ts";
import { sessions, stampEvent, type PoolEntry } from "./state.ts";
import { hostI18n } from "../ui-src/i18n/host.ts";

function sendQueued(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const agent = entry.session.agent;
  const view = (list: readonly any[]) =>
    list.filter((m) => isUserQueuedMessage(m)).map((m) => toRestoredQueuedMessage(m));
  const followUp = [...view(agent.peekFollowUpQueue()), ...view(entry.parkedFollowUp)];
  const steering = view(agent.peekSteeringQueue());
  // Snapshot for race-condition backstop: full view + all steering user messages (at turn_end, diff "had last time / gone now / consumption not notified" = swallowed)
  entry.queuedTexts = [...followUp, ...steering].map((m) => m.text);
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
  agent.replaceQueues(agent.peekSteeringQueue(), queue.filter((_, i) => i < start));
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
  ws: { send(data: string): unknown },
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
    // Back half of the full view: the target lives in the parked staging
    extractParkedAt(entry, index - queue.filter((m) => isUserQueuedMessage(m)).length);
    next = queue;
  } else {
    next = removeUserMessage(queue, index);
  }
  agent.replaceQueues(
    which === "steering" ? next : agent.peekSteeringQueue(),
    which === "steering" ? agent.peekFollowUpQueue() : next,
  );
  sendQueued(ws, sessionId, entry);
}

// Send now: turn the index-th followUp entry (full view, including parked
// staging) into a steer injection;
// park all remaining queued messages so this run injects only the clicked
// one
async function handleSendNow(ws: { send(data: string): unknown }, sessionId: string, index: number) {
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
    agent.replaceQueues(agent.peekSteeringQueue(), removeUserMessage(queue, index));
  } else {
    // Target lives in the parked staging: extract it and re-enqueue via steer (images re-described by the SDK; rare path)
    const [msg] = extractParkedAt(entry, index - queueUserCount).filter((m) => isUserQueuedMessage(m));
    restored = toRestoredQueuedMessage(msg);
  }
  await entry.session.steer(restored.text, restored.images);
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
}

// Requeue: move the index-th steer-queue entry back to the top of followUp (dropping the steer marker)
function handleRequeue(ws: { send(data: string): unknown }, sessionId: string, index: number) {
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
  agent.replaceQueues(removeUserMessage(queue, index), [moved, ...agent.peekFollowUpQueue()]);
  // moved becomes the single 1st entry of the base queue; the former queue head retreats to the parked head (keeping FIFO order)
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
}

export { sendQueued, parkFollowUpTail, releaseOneParked, handlePeekQueued, handleDropQueued, handleSendNow, handleRequeue };
