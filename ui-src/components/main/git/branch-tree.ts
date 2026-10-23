// Branch / tag tree for the Git page's sidebar: split "feature/x" refs into
// path segments so the list reads as a folder tree, plus the query filter that
// keeps matching refs and their ancestors.

export interface BranchNode {
  /** Path segment shown on this row. */
  name: string;
  /** Full ref name once the node is a ref (also for intermediate folders). */
  full: string;
  /** Whether `full` names an existing branch/tag (clickable as a scope). */
  isBranch: boolean;
  children: BranchNode[];
}

export function buildBranchTree(names: readonly string[]): BranchNode[] {
  const root: BranchNode = { name: "", full: "", isBranch: false, children: [] };
  const byFull = new Map<string, BranchNode>();
  for (const full of names) {
    const segments = full.split("/");
    let node = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let next = byFull.get(prefix);
      if (!next) {
        next = { name: segment, full: prefix, isBranch: false, children: [] };
        byFull.set(prefix, next);
        node.children.push(next);
      }
      node = next;
    }
    node.isBranch = true;
  }
  return root.children;
}

/** Keep only nodes with a ref below matching the query (ancestors survive). */
export function filterTree(nodes: readonly BranchNode[], query: string): BranchNode[] {
  if (!query) return [...nodes];
  const q = query.toLowerCase();
  const walk = (list: readonly BranchNode[]): BranchNode[] => {
    const out: BranchNode[] = [];
    for (const node of list) {
      const children = walk(node.children);
      const hit = node.isBranch && node.full.toLowerCase().includes(q);
      if (hit || children.length > 0) out.push({ ...node, children });
    }
    return out;
  };
  return walk(nodes);
}
