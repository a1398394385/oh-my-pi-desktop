// Worktree RPC bus: request/response correlation for the worktree domain
// (create/status/remove). The ws is push-frame based, so callers get a Promise
// resolved by the matching reply frame (reqId echo); landing happens in
// store/wsHandlers/worktree.ts → landWorktreeFrame. Kept outside zustand on
// purpose (same rationale as terminal.ts): one-shot dialog traffic, no render
// subscription — the dialogs own their local state.
import { useAppStore } from "./index";
import { t } from "../i18n";
import type { HostRequest } from "../types/frames";

// Reply-frame shapes this bus lands on. These mirror the host wire frames
// 1:1 — the HostFrame union members are hooked up by integration (the wire
// interfaces must be kept identical to these).
export interface WorktreeCreatedReply {
  type: "worktree_created";
  reqId: number;
  ok: boolean;
  path?: string;
  branch?: string;
  baseCwd?: string;
  error?: string;
  code?: string;
}

export interface WorktreeStatusReply {
  type: "worktree_status_result";
  reqId: number;
  ok: boolean;
  path: string;
  exists: boolean;
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  error?: string;
  code?: string;
}

export interface WorktreeRemovedReply {
  type: "worktree_removed";
  reqId: number;
  ok: boolean;
  error?: string;
  code?: string;
  staged?: number;
  unstaged?: number;
  untracked?: number;
}

export type WorktreeReplyFrame = WorktreeCreatedReply | WorktreeStatusReply | WorktreeRemovedReply;

interface Pending {
  resolve: (frame: WorktreeReplyFrame) => void;
  timer: NodeJS.Timeout | number;
}

const TIMEOUT_MS = 60_000; // worktree add can be slow on large repos
let seq = 0;
const pending = new Map<number, Pending>();

/** Send one worktree_* request and resolve with its reply frame (rejects on timeout / no ws). */
async function worktreeRequest(payload: { type: string; [key: string]: unknown }): Promise<WorktreeReplyFrame> {
  const st = useAppStore.getState();
  if (!st.ws || st.ws.readyState !== 1) throw new Error(t("worktree.notConnected"));
  const reqId = ++seq;
  const { promise, resolve, reject } = Promise.withResolvers<WorktreeReplyFrame>();
  const timer = setTimeout(() => {
    pending.delete(reqId);
    reject(new Error(t("worktree.timeout")));
  }, TIMEOUT_MS);
  pending.set(reqId, { resolve, timer });
  // The wire contract gains the worktree_* methods at integration time (see
  // HostRequestMethod); cast keeps this file compiling before hook-up.
  st.send({ ...payload, reqId } as unknown as HostRequest);
  return promise;
}

export async function worktreeCreate(input: { name: string; baseRef: "HEAD" | "default"; baseCwd: string }): Promise<WorktreeCreatedReply> {
  return worktreeRequest({ type: "worktree_create", ...input }) as Promise<WorktreeCreatedReply>;
}

export function worktreeStatus(path: string): Promise<WorktreeStatusReply> {
  return worktreeRequest({ type: "worktree_status", path }) as Promise<WorktreeStatusReply>;
}

export function worktreeRemove(path: string, force: boolean): Promise<WorktreeRemovedReply> {
  return worktreeRequest({ type: "worktree_remove", path, force }) as Promise<WorktreeRemovedReply>;
}

/** Landing pad for worktree_* reply frames (called from wsHandlers/worktree.ts). */
export function landWorktreeFrame(msg: WorktreeReplyFrame): void {
  const p = pending.get(msg.reqId);
  if (!p) return; // stale or foreign reqId (host restart) — drop silently
  pending.delete(msg.reqId);
  clearTimeout(p.timer);
  p.resolve(msg);
}
