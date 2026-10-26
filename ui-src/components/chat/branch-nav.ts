// Branch pager (fork switcher) pure helpers: project the session entry tree +
// active leaf onto the chat bubbles that host an up/k-n-down pager. Store- and
// React-free on purpose — scripts/branch-nav.test.ts runs it directly.
//
// Children order trust: the base builds getTree() children in persistence
// order, then sorts every node's children by entry timestamp
// (SessionEntryIndex.tree, session-manager.ts); roots keep append order. The
// wire order is therefore stable across fetches — no client-side re-sort.

export interface BranchNavNode {
  id: string;
  role?: string;
  text?: string;
  children?: BranchNavNode[];
}

// Fork-point identity + pager numbers for one host bubble.
export interface BranchNavInfo {
  index: number; // 0-based position of the active child among its siblings
  total: number; // sibling count at the fork point
  forkId: string; // parent entry id (ROOT_FORK_ID at root level): survives a sibling switch, anchors the post-switch scroll
  siblingLeaves: string[]; // per sibling, in tree order: deepest leaf id along its default path
}

export interface BranchRenderCtx {
  map: Map<string, BranchNavInfo>;
  // entryId → fk of the latest bubble rendered with it in this pass: a multi-block
  // assistant entry renders several bubbles sharing one entryId; only the last
  // one hosts the pager (decided at React render time, after the traversal done)
  lastFk: Map<string, string>;
}

export const ROOT_FORK_ID = "__roots__";

// Mirror of the store's isJunkPlaceholder (kept local so this module imports nothing)
function junkText(text: string | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

// Would the entry render a visible chat bubble? Only user/assistant text
// messages do; tool calls, bookkeeping entries and textless assistants render
// rows or nothing, so the fork-host search descends past them.
function isBubbleNode(n: BranchNavNode): boolean {
  if (n.role === "user") return true;
  return n.role === "assistant" && !junkText(n.text);
}

// root→leaf path of the active branch; null when the leaf is missing or stale
function findPath(nodes: BranchNavNode[], id: string, out: BranchNavNode[]): boolean {
  for (const n of nodes) {
    out.push(n);
    if (n.id === id) return true;
    if (n.children && findPath(n.children, id, out)) return true;
    out.pop();
  }
  return false;
}

// Deepest leaf along a subtree's default path (first child at every nested fork)
export function deepestLeafId(node: BranchNavNode): string {
  let n = node;
  while (n.children && n.children.length > 0) n = n.children[0];
  return n.id;
}

// Cycle to the adjacent sibling's leaf (wraps around at both ends)
export function cycleSiblingLeaf(leaves: string[], index: number, dir: 1 | -1): string {
  const n = leaves.length;
  return leaves[((index + dir) % n + n) % n];
}

// Walk the active path root→leaf; each fork point's pager mounts on the first
// bubble entry at or below the active fork child. A nearer fork point met
// while descending supersedes the pending one (the older fork gets no host) —
// confirmed design. A fork whose branch holds no bubble at all mounts nothing.
export function computeBranchNav(roots: BranchNavNode[], leafId: string | null): Map<string, BranchNavInfo> {
  const path: BranchNavNode[] = [];
  const map = new Map<string, BranchNavInfo>();
  if (!leafId || !findPath(roots, leafId, path)) return map;
  let fork: BranchNavInfo | null = null;
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    // identity search is safe: path nodes are the tree's own objects
    const sibs = i === 0 ? roots : path[i - 1].children ?? [];
    if (sibs.length > 1) {
      fork = {
        index: sibs.indexOf(node),
        total: sibs.length,
        forkId: i === 0 ? ROOT_FORK_ID : path[i - 1].id,
        siblingLeaves: sibs.map(deepestLeafId),
      };
    }
    if (fork && isBubbleNode(node)) {
      map.set(node.id, fork);
      fork = null;
    }
  }
  return map;
}

// Post-switch scroll request: a pager click records the fork point plus the
// tree/session it ran against; once the rebuilt transcript + refetched tree
// land, MessagePage scrolls to the new branch's host bubble of the SAME fork.
// An unchanged tree reference after the receipt means the navigation failed
// and the request is dropped.
export interface BranchScrollPending {
  forkId: string;
  sessionId: string;
  treeRef: unknown;
}
let pendingScroll: BranchScrollPending | null = null;

export function setPendingBranchScroll(p: BranchScrollPending): void {
  pendingScroll = p;
}

export function getPendingBranchScroll(): BranchScrollPending | null {
  return pendingScroll;
}

export function clearPendingBranchScroll(): void {
  pendingScroll = null;
}
