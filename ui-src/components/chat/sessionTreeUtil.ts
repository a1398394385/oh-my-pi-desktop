// 会话条目树工具函数与类型定义，供右栏 SessionTreePage 与主区域 MainSessionTree 共享复用。

// 会话条目树节点（get_entry_tree 回包）
export interface EntryNode {
  id: string;
  text?: string;
  label?: string;
  ts?: string; // ISO 时间（fmtAgo 展示）
  kind?: string;
  role?: string;
  userReq?: boolean;
  isSettings?: boolean;
  emptyAssistant?: boolean;
  children?: EntryNode[];
}

// 压平后的渲染行（缩进/连接符/导轨在过滤前算好）
export interface FlatRow {
  node: EntryNode;
  depth: number;
  gutters: boolean[]; // 每层是否有竖导轨（true = │）
  connector: string; // 分支连接符（"├── "/"└── "，线性链为空串）
}

// 过滤模式（与底座 treeFilterMode 同名的子集，label 为中文）
export const FILTERS: [string, string][] = [
  ["default", "chat.filterDefault"],
  ["no-tools", "chat.filterNoTools"],
  ["user-only", "chat.filterUserOnly"],
  ["all", "chat.filterAll"],
];

// 计算根→叶子的活跃路径 id 集合（叶可能不在树里，此时为空集，树无高亮）
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

// 全树压平（过滤前算好缩进/连接符/导轨，隐藏行不影响剩余行的树形——与底座一致）：
// 只有真分支点（兄弟 >1）才加深度；线性链保持与头部同列。active 分支排的兄弟最前。
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

// 行过滤（语义对齐底座 #applyFilter）。
export function passesFilter(node: EntryNode, mode: string): boolean {
  switch (mode) {
    case "all":
      return true;
    case "user-only":
      return !!node.userReq;
    case "no-tools":
      return !node.isSettings && !node.emptyAssistant && !(node.kind === "message" && node.role === "toolResult");
    default: // default：隐藏 bookkeeping 条目与无文本的非叶 assistant
      return !node.isSettings && !node.emptyAssistant;
  }
}

// 角色 → 行样式类（颜色走 style.css token）
export function roleClass(node: EntryNode): string {
  if (node.kind !== "message") return "st-sys";
  if (node.role === "user") return "st-user";
  if (node.role === "assistant") return "st-asst";
  if (node.role === "toolResult" || node.role === "bashExecution") return "st-tool";
  return "st-sys";
}

// 「当前」徽标吸附点
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

// 递归过滤子节点：若子节点本身不满足过滤，则递归提升其满足过滤的后代节点
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

// 瀑布流单项：节点项 或 分叉选择项
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

// 计算从根节点出发的单线瀑布流序列
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

// 估算某个分支沿默认/选定路径的步数
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

// 瀑布流分段：每个分叉点及其下方所属的子分支节点集合作为一个 section
export interface StreamSection {
  fork: Extract<StreamItem, { type: "fork" }> | null;
  nodes: Extract<StreamItem, { type: "node" }>[];
}

// 将扁平瀑布流序列按分叉点切分为独立段落，保持上半部分不动、下方区域独立切换
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


