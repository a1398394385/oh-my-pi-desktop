// Session entry tree utility functions and type definitions, shared by the right-panel
// SessionTreePage and the main-area MainSessionTree.

// Session entry tree node (get_entry_tree response)
export interface EntryNode {
  id: string;
  text?: string;
  label?: string;
  ts?: string; // ISO time (displayed via fmtAgo)
  kind?: string;
  role?: string;
  userReq?: boolean;
  isSettings?: boolean;
  emptyAssistant?: boolean;
  children?: EntryNode[];
}

// Flattened render row (indentation/connectors/rails computed before filtering)
export interface FlatRow {
  node: EntryNode;
  depth: number;
  gutters: boolean[]; // whether each level has a vertical rail (true = │)
  connector: string; // branch connector ("├── " / "└── "; empty string for linear chains)
}

// Filter modes (a same-named subset of the core's treeFilterMode; labels resolve via i18n keys)
export const FILTERS: [string, string][] = [
  ["default", "chat.filterDefault"],
  ["no-tools", "chat.filterNoTools"],
  ["user-only", "chat.filterUserOnly"],
  ["all", "chat.filterAll"],
];

// Compute the active root→leaf path id set (the leaf may not be in the tree, in which case
// the set is empty and the tree has no highlight)
export function activePathIds(roots: EntryNode[], leafId: string | null): Set<string> {
  const ids = new Set<string>();
  if (!leafId) return ids;
  const dfs = (node: EntryNode, trail: string[]): boolean => {
    trail.push(node.id);
    if (node.id === leafId) {
      for (const id of trail) ids.add(id);
      return true;
    }
    for (const child of node.children ?? []) {
      if (dfs(child, trail)) return true;
    }
    trail.pop();
    return false;
  };
  for (const root of roots) {
    if (dfs(root, [])) break;
  }
  return ids;
}

// Flatten the whole tree (indentation/connectors/rails computed before filtering; hidden
// rows do not affect the tree shape of the remaining rows — same as the core):
// only true branch points (siblings > 1) add depth; linear chains stay in the same column
// as their head. Siblings on the active branch are sorted first.
export function flattenRows(roots: EntryNode[], activeIds: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (nodes: EntryNode[], depth: number, gutters: boolean[]): void => {
    const ordered = [...nodes].sort((a, b) => Number(activeIds.has(b.id)) - Number(activeIds.has(a.id)));
    ordered.forEach((node, i) => {
      const isLast = i === ordered.length - 1;
      const branched = ordered.length > 1;
      rows.push({ node, depth, gutters, connector: branched ? (isLast ? "└── " : "├── ") : "" });
      walk(node.children ?? [], branched ? depth + 1 : depth, branched ? [...gutters, !isLast] : gutters);
    });
  };
  walk(roots, 0, []);
  return rows;
}

// Row filtering (semantics aligned with the core's #applyFilter).
export function passesFilter(node: EntryNode, mode: string): boolean {
  switch (mode) {
    case "all":
      return true;
    case "user-only":
      return !!node.userReq;
    case "no-tools":
      return !node.isSettings && !node.emptyAssistant && !(node.kind === "message" && node.role === "toolResult");
    default: // default: hide bookkeeping entries and non-leaf assistants without text
      return !node.isSettings && !node.emptyAssistant;
  }
}

// Role → row style class (colors go through style.css tokens)
export function roleClass(node: EntryNode): string {
  if (node.kind !== "message") return "st-sys";
  if (node.role === "user") return "st-user";
  if (node.role === "assistant") return "st-asst";
  if (node.role === "toolResult" || node.role === "bashExecution") return "st-tool";
  return "st-sys";
}

// Snap target of the "current" badge
export function badgeTargetId(roots: EntryNode[], leafId: string | null, filter: string): string | null {
  if (!leafId) return null;
  const byId = new Map<string, EntryNode>();
  const parentOf = new Map<string, string | null>();
  const walk = (n: EntryNode, parentId: string | null): void => {
    byId.set(n.id, n);
    parentOf.set(n.id, parentId);
    (n.children ?? []).forEach((c) => walk(c, n.id));
  };
  roots.forEach((r) => walk(r, null));
  let id: string | null = byId.has(leafId) ? leafId : null;
  while (id) {
    const n = byId.get(id)!;
    if (passesFilter(n, filter)) return n.id;
    id = parentOf.get(id) ?? null;
  }
  return leafId;
}

// Recursively filter children: a child that itself fails the filter recursively promotes
// its descendants that pass
export function getFilteredChildren(node: EntryNode, filter: string): EntryNode[] {
  const result: EntryNode[] = [];
  const search = (children: EntryNode[]) => {
    for (const c of children) {
      if (passesFilter(c, filter)) {
        result.push(c);
      } else if (c.children && c.children.length > 0) {
        search(c.children);
      }
    }
  };
  if (node.children) search(node.children);
  return result;
}

// Waterfall item: a node item or a fork-selection item
export type StreamItem =
  | {
      type: "node";
      node: EntryNode;
      isLeaf: boolean;
      onPath: boolean;
    }
  | {
      type: "fork";
      parentId: string;
      options: EntryNode[];
      selectedId: string;
    };

// Compute the single-line waterfall sequence starting from the roots
export function buildStreamSequence(
  roots: EntryNode[],
  leafId: string | null,
  activeIds: Set<string>,
  selectedBranches: Map<string, string>,
  filter: string
): StreamItem[] {
  const sequence: StreamItem[] = [];

  const filteredRoots: EntryNode[] = [];
  const collectRoots = (nodes: EntryNode[]) => {
    for (const n of nodes) {
      if (passesFilter(n, filter)) {
        filteredRoots.push(n);
      } else if (n.children && n.children.length > 0) {
        collectRoots(n.children);
      }
    }
  };
  collectRoots(roots);

  if (filteredRoots.length === 0) return sequence;

  let curr: EntryNode | undefined;
  if (filteredRoots.length === 1) {
    curr = filteredRoots[0];
  } else {
    const rootForkId = "__roots__";
    let selectedId = selectedBranches.get(rootForkId);
    let chosen = filteredRoots.find((r) => r.id === selectedId);
    if (!chosen) {
      chosen = filteredRoots.find((r) => activeIds.has(r.id)) || filteredRoots[0];
      selectedBranches.set(rootForkId, chosen.id);
    }
    sequence.push({
      type: "fork",
      parentId: rootForkId,
      options: filteredRoots,
      selectedId: chosen.id,
    });
    curr = chosen;
  }

  const visited = new Set<string>();
  while (curr && !visited.has(curr.id)) {
    visited.add(curr.id);
    sequence.push({
      type: "node",
      node: curr,
      isLeaf: curr.id === leafId,
      onPath: activeIds.has(curr.id),
    });

    const children = getFilteredChildren(curr, filter);
    if (children.length === 0) break;

    if (children.length === 1) {
      curr = children[0];
    } else {
      let selectedId = selectedBranches.get(curr.id);
      let chosen = children.find((c) => c.id === selectedId);
      if (!chosen) {
        chosen = children.find((c) => activeIds.has(c.id)) || children[0];
        selectedBranches.set(curr.id, chosen.id);
      }
      sequence.push({
        type: "fork",
        parentId: curr.id,
        options: children,
        selectedId: chosen.id,
      });
      curr = chosen;
    }
  }

  return sequence;
}

// Estimate the step count of a branch along its default/selected path
export function countBranchSteps(
  node: EntryNode,
  selectedBranches: Map<string, string>,
  activeIds: Set<string>,
  filter: string
): number {
  let count = 1;
  let curr = node;
  const visited = new Set<string>();
  while (curr && !visited.has(curr.id)) {
    visited.add(curr.id);
    const children = getFilteredChildren(curr, filter);
    if (children.length === 0) break;
    count += 1;
    const nextId = selectedBranches.get(curr.id);
    let nextNode = nextId ? children.find((c) => c.id === nextId) : undefined;
    if (!nextNode) {
      nextNode = children.find((c) => activeIds.has(c.id)) || children[0];
    }
    curr = nextNode;
  }
  return count;
}

// Waterfall section: each fork point plus the sub-branch node set below it forms one section
export interface StreamSection {
  fork: Extract<StreamItem, { type: "fork" }> | null;
  nodes: Extract<StreamItem, { type: "node" }>[];
}

// Split the flat waterfall sequence into independent sections at fork points, keeping the
// upper half still while the area below switches independently
export function splitSequenceIntoSections(sequence: StreamItem[]): StreamSection[] {
  const sections: StreamSection[] = [];
  let currentFork: Extract<StreamItem, { type: "fork" }> | null = null;
  let currentNodes: Extract<StreamItem, { type: "node" }>[] = [];

  for (const item of sequence) {
    if (item.type === "fork") {
      if (currentFork !== null || currentNodes.length > 0) {
        sections.push({ fork: currentFork, nodes: currentNodes });
      }
      currentFork = item;
      currentNodes = [];
    } else {
      currentNodes.push(item);
    }
  }

  if (currentFork !== null || currentNodes.length > 0) {
    sections.push({ fork: currentFork, nodes: currentNodes });
  }

  return sections;
}


