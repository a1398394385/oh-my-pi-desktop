// Git manager RPC bus: reqId-correlated git_graph / git_commit_detail /
// git_commit_file_diff calls for the middle-column Git page. The page owns its
// render state, so this bus stays outside zustand (same rationale as
// store/worktree.ts: one-shot reads, no render subscription); landing happens
// in store/wsHandlers/git-graph.ts.
//
// Page-open latency: results are memoized in-memory (`graphMemo`) so reopening
// the page or switching back to a scope renders the previous snapshot at once
// while a background refetch revalidates it. The host keeps its own short-TTL
// graph cache, so the revalidation usually costs no subprocess either.
import { useAppStore } from "./index";
import { t } from "../i18n";
import { expandRightPanel } from "../components/main/right/tabs";
import type {
  CommitFileDiffFrame,
  GitCommitDetailFrame,
  GitGraphFrame,
  HostRequest,
} from "../types/frames";

type GitGraphReply = GitGraphFrame | GitCommitDetailFrame | CommitFileDiffFrame;

interface Pending {
  resolve: (frame: GitGraphReply) => void;
  timer: NodeJS.Timeout | number;
}

const TIMEOUT_MS = 30_000;
/** Memo cap: a page worth of scopes per project, bounded so long runs cannot grow it forever. */
const MEMO_MAX = 40;
let seq = 0;
const pending = new Map<number, Pending>();
const graphMemo = new Map<string, GitGraphFrame>();

function memoKey(cwd: string, scope: string, limit: number): string {
  return `${cwd}\x00${scope}\x00${limit}`;
}

/** Last graph snapshot for (project, scope, limit), or null. */
export function cachedGitGraph(cwd: string, scope: string, limit: number): GitGraphFrame | null {
  return graphMemo.get(memoKey(cwd, scope, limit)) ?? null;
}

function rememberGraph(key: string, frame: GitGraphFrame): void {
  if (graphMemo.size >= MEMO_MAX) {
    const oldest = graphMemo.keys().next();
    if (!oldest.done) graphMemo.delete(oldest.value);
  }
  graphMemo.set(key, frame);
}

/** Send one graph-domain request and resolve with its reply frame (rejects on timeout / no ws). */
async function graphRequest(payload: { type: string; [key: string]: unknown }): Promise<GitGraphReply> {
  const st = useAppStore.getState();
  if (!st.ws || st.ws.readyState !== 1) throw new Error(t("gitPage.notConnected"));
  const reqId = ++seq;
  const { promise, resolve, reject } = Promise.withResolvers<GitGraphReply>();
  const timer = setTimeout(() => {
    pending.delete(reqId);
    reject(new Error(t("gitPage.timeout")));
  }, TIMEOUT_MS);
  pending.set(reqId, { resolve, timer });
  st.send({ ...payload, reqId } as HostRequest);
  return promise;
}

/** Read the commit graph of one project (scope = "" spans every ref, a branch/tag restricts to its history). */
export async function fetchGitGraph(input: {
  cwd: string;
  scope?: string;
  limit?: number;
  force?: boolean;
}): Promise<GitGraphFrame> {
  const frame = (await graphRequest({ type: "git_graph", ...input })) as GitGraphFrame;
  if (frame.ok) {
    rememberGraph(memoKey(input.cwd, input.scope ?? "", input.limit ?? frame.commits?.length ?? 0), frame);
  }
  return frame;
}

/** Read one commit's message, numstat rows and ancestor count. */
export function fetchGitCommitDetail(input: { cwd: string; oid: string }): Promise<GitCommitDetailFrame> {
  return graphRequest({ type: "git_commit_detail", ...input }) as Promise<GitCommitDetailFrame>;
}

/** Read one file's patch inside a commit. */
export function fetchGitCommitFileDiff(input: {
  cwd: string;
  oid: string;
  path: string;
}): Promise<CommitFileDiffFrame> {
  return graphRequest({ type: "git_commit_file_diff", ...input }) as Promise<CommitFileDiffFrame>;
}

/** Landing pad for graph-domain reply frames (called from wsHandlers/git-graph.ts). */
export function landGitGraphFrame(msg: GitGraphReply): void {
  const p = pending.get(msg.reqId);
  if (!p) return; // stale or foreign reqId (host restart) — drop silently
  pending.delete(msg.reqId);
  clearTimeout(p.timer);
  p.resolve(msg);
}

/**
 * Git page → right panel: show one file's patch of a commit. The target is
 * written to the store first (the tab renders it immediately), then the
 * request fills in the diff; a stale reply (user picked another file) is
 * dropped by comparing the target identity.
 */
export function openCommitFileDiff(input: { cwd: string; oid: string; path: string; oldPath?: string }): void {
  useAppStore.setState({ commitDiff: { ...input, diff: "", loading: true, error: null } });
  expandRightPanel("commitdiff");
  fetchGitCommitFileDiff(input)
    .then((frame) => {
      const cur = useAppStore.getState().commitDiff;
      if (!cur || cur.oid !== input.oid || cur.path !== input.path) return;
      useAppStore.setState({
        commitDiff: {
          ...input,
          diff: frame.diff ?? "",
          loading: false,
          error: frame.ok ? null : (frame.error ?? t("gitPage.failed")),
        },
      });
    })
    .catch((e) => {
      const cur = useAppStore.getState().commitDiff;
      if (!cur || cur.oid !== input.oid || cur.path !== input.path) return;
      useAppStore.setState({
        commitDiff: { ...input, diff: "", loading: false, error: e instanceof Error ? e.message : String(e) },
      });
    });
}
