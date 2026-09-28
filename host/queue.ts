// 排队消息域（v14/v15 排队体系）：followUp/steering 两队列的用户消息视图、
// park 暂存（防注入边界 drain 整队）、逐轮放回、立即发送/放回/删除。
// 底座队列元素含隐藏伴随（图片描述/magic keyword notice），操作一律成组摘取。
import {
  isUserQueuedMessage,
  isHiddenUserCompanion,
  toRestoredQueuedMessage,
} from "./bootstrap.ts";
import { sessions, stampEvent, type PoolEntry } from "./state.ts";

function sendQueued(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const agent = entry.session.agent;
  const view = (list: readonly any[]) =>
    list.filter((m) => isUserQueuedMessage(m)).map((m) => toRestoredQueuedMessage(m));
  const followUp = [...view(agent.peekFollowUpQueue()), ...view(entry.parkedFollowUp)];
  const steering = view(agent.peekSteeringQueue());
  // 竞态兜底的快照：完整视图 + steering 用户消息全量（turn_end 时 diff「上次有/现在无/未通知消费」= 被吞）
  entry.queuedTexts = [...followUp, ...steering].map((m) => m.text);
  ws.send(JSON.stringify(stampEvent({ type: "queued", sessionId, followUp, steering })));
}

// 把底座 followUp 队列修剪为最多 1 条用户消息：第 2 条起（含各自前导隐藏伴随）移入
// parked 暂存，防止当前 run 的注入边界把整队消息一次性带走
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

// 从 parked 暂存摘出第 pi 条用户消息（含前导隐藏伴随），返回摘出的元素数组
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
  if (target < 0) throw new Error(`暂存排队消息不存在: ${pi}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(parked[start - 1])) start--;
  const extracted = parked.slice(start, target + 1);
  entry.parkedFollowUp = parked.filter((_, i) => i < start || i > target);
  return extracted;
}

// 放回 parked 首条（含前导伴随）到 agent 队列。队列元素是入队时的原结构，直接回队即保留图片等
function releaseOneParked(entry: PoolEntry): any[] {
  const u = entry.parkedFollowUp.findIndex((m) => isUserQueuedMessage(m));
  if (u < 0) return [];
  const released = entry.parkedFollowUp.slice(0, u + 1);
  entry.parkedFollowUp = entry.parkedFollowUp.slice(u + 1);
  return released;
}

// 移除第 index 条用户消息及其紧邻在前的隐藏伴随（图片描述等），返回过滤后的新数组
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
  if (target < 0) throw new Error(`排队消息不存在: ${index}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  return queue.filter((_, i) => i < start || i > target);
}

function handlePeekQueued(ws: { send(data: string): unknown }, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  sendQueued(ws, sessionId, entry);
}

function handleDropQueued(
  ws: { send(data: string): unknown },
  sessionId: string,
  which: "followUp" | "steering",
  index?: number,
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = which === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
  let next: any[];
  if (index === undefined) {
    // 全清：只清用户消息及其隐藏伴随，保留系统 notice（goal/plan/budget 等）
    next = queue.filter((m) => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m));
    if (which === "followUp") entry.parkedFollowUp = [];
  } else if (which === "followUp" && index >= queue.filter((m) => isUserQueuedMessage(m)).length) {
    // 完整视图后半段：目标在 parked 暂存
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

// 立即发送：把 followUp 第 index 条（完整视图，含 parked 暂存）转为 steer 注入；
// 剩余排队消息全部 park，本轮 run 只注入被点的这一条
async function handleSendNow(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
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
    if (target < 0) throw new Error(`排队消息不存在: ${index}`);
    restored = toRestoredQueuedMessage(queue[target]);
    agent.replaceQueues(agent.peekSteeringQueue(), removeUserMessage(queue, index));
  } else {
    // 目标在 parked 暂存：摘出后经 steer 重新入队（图片经 SDK 重建描述，罕见路径）
    const [msg] = extractParkedAt(entry, index - queueUserCount).filter((m) => isUserQueuedMessage(m));
    restored = toRestoredQueuedMessage(msg);
  }
  await entry.session.steer(restored.text, restored.images);
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
}

// 放回队列：把 steer 队列第 index 条挪回 followUp 顶端（去掉 steer 标记）
function handleRequeue(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
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
  if (target < 0) throw new Error(`steer 消息不存在: ${index}`);
  const moved: any = { ...queue[target] };
  delete moved.steering;
  agent.replaceQueues(removeUserMessage(queue, index), [moved, ...agent.peekFollowUpQueue()]);
  // moved 成为底座队列唯一第 1 条，原队列首条退入 parked 头部（保持 FIFO 顺序）
  parkFollowUpTail(entry);
  sendQueued(ws, sessionId, entry);
}

export { sendQueued, parkFollowUpTail, releaseOneParked, handlePeekQueued, handleDropQueued, handleSendNow, handleRequeue };
