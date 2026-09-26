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
  ["default", "默认"],
  ["no-tools", "无工具"],
  ["user-only", "仅用户"],
  ["all", "全部"],
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
