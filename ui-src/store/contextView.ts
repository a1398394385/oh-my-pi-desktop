// Context viewer RPC bus: reqId-correlated context_view_open / context_view_list /
// context_view_entry / context_view_release calls for the standalone context
// viewer. The viewer owns its render state, so this bus stays outside zustand
// (same rationale as store/git-graph.ts: one-shot reads, no render
// subscription); landing happens in store/wsHandlers/contextView.ts.
import { useAppStore } from "./index";
import type {
  ContextViewEntryBodyFrame,
  ContextViewErrorFrame,
  ContextViewIndexFrame,
  ContextViewPageFrame,
  ContextViewReleasedFrame,
  HostRequest,
} from "../types/frames";

type ContextViewReply =
  | ContextViewIndexFrame
  | ContextViewPageFrame
  | ContextViewEntryBodyFrame
  | ContextViewReleasedFrame
  | ContextViewErrorFrame;

interface Pending {
  resolve: (msg: ContextViewReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS = 30_000;
let seq = 0;
const pending = new Map<number, Pending>();

/** Send one viewer request and resolve with its reply frame (rejects on timeout / error reply / no ws). */
function viewerRequest(payload: { type: string; [key: string]: unknown }): Promise<ContextViewReply> {
  const st = useAppStore.getState();
  if (!st.ws || st.ws.readyState !== 1) return Promise.reject(new Error("contextViewer.notConnected"));
  const reqId = ++seq;
  const { promise, resolve, reject } = Promise.withResolvers<ContextViewReply>();
  const timer = setTimeout(() => {
    pending.delete(reqId);
    reject(new Error("contextViewer.timeout"));
  }, TIMEOUT_MS);
  pending.set(reqId, { resolve, timer });
  st.send({ ...payload, reqId } as HostRequest);
  return promise.then((msg) => {
    if ((msg as ContextViewErrorFrame).ok === false)
      throw new Error((msg as ContextViewErrorFrame).error || "contextViewer.error");
    return msg;
  });
}

/** Capture a read-only context snapshot of one session. */
export function fetchContextViewIndex(input: { sessionId: string }): Promise<ContextViewIndexFrame> {
  return viewerRequest({ type: "context_view_open", ...input }) as Promise<ContextViewIndexFrame>;
}

/** One page of entry summaries for a category (or one of its child groups). */
export function fetchContextViewPage(input: {
  sessionId: string;
  snapshotId: string;
  category: string;
  childKey?: string;
  offset?: number;
  search?: string;
  focusEntryId?: string;
}): Promise<ContextViewPageFrame> {
  return viewerRequest({ type: "context_view_list", ...input }) as Promise<ContextViewPageFrame>;
}

/** One page of an entry's body text. */
export function fetchContextViewEntryBody(input: {
  sessionId: string;
  snapshotId: string;
  entryId: string;
  offset?: number;
}): Promise<ContextViewEntryBodyFrame> {
  return viewerRequest({ type: "context_view_entry", ...input }) as Promise<ContextViewEntryBodyFrame>;
}

/** Release the snapshot (viewer close). */
export function releaseContextView(input: { sessionId: string; snapshotId: string }): Promise<ContextViewReleasedFrame> {
  return viewerRequest({ type: "context_view_release", ...input }) as Promise<ContextViewReleasedFrame>;
}

/** Landing pad for viewer reply frames (called from store/wsHandlers/contextView.ts). */
export function landContextViewFrame(msg: ContextViewReply): void {
  const p = pending.get(msg.reqId);
  if (!p) return; // stale or foreign reqId (host restart) — drop silently
  pending.delete(msg.reqId);
  clearTimeout(p.timer);
  p.resolve(msg);
}
