// 会话树页（TUI /tree 的右栏版）：会话内条目树（rewind/fork 留下的兄弟分支同文件共存），
// 活跃路径（根→当前叶）高亮，点击节点跳转到该点（可带分支摘要）；被放弃路径保留为兄弟分支。
// 数据：get_entry_tree 懒加载（切会话后旧数据视为过期，对齐 BranchTreePage 模式）；
// 过滤语义对齐底座 tree-selector：默认 / 无工具 / 仅用户 / 全部。
import { useState } from "react";
import { S, useStore, notify, send, activeOpen, rightState, toast } from "../../store";
import { fmtAgo } from "./helpers";

// 会话条目树节点（get_entry_tree 回包；字段以本页实际读取为准）
interface EntryNode {
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
interface FlatRow {
  node: EntryNode;
  depth: number;
  gutters: boolean[]; // 每层是否有竖导轨（true = │）
  connector: string; // 分支连接符（"├── "/"└── "，线性链为空串）
}

// 过滤模式（与底座 treeFilterMode 同名的子集，label 为中文）
const FILTERS: [string, string][] = [
  ["default", "默认"],
  ["no-tools", "无工具"],
  ["user-only", "仅用户"],
  ["all", "全部"],
];

// 计算根→叶子的活跃路径 id 集合（叶可能不在树里，此时为空集，树无高亮）
function activePathIds(roots: EntryNode[], leafId: string | null): Set<string> {
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
function flattenRows(roots: EntryNode[], activeIds: Set<string>): FlatRow[] {
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

// 行过滤（语义对齐底座 #applyFilter）。leaf 不做特批：落在簿记节点（典型：auto-thinking
// 的 model_usage）上时该行直接隐藏——「当前」徽标经 badgeTargetId 吸附到最近可见消息祖先，
// 位置标记不丢（底座 TUI 是强制显示 leaf，这里故意不同：空节点显示出来没有信息量）
function passesFilter(node: EntryNode, mode: string): boolean {
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
function roleClass(node: EntryNode): string {
  if (node.kind !== "message") return "st-sys";
  if (node.role === "user") return "st-user";
  if (node.role === "assistant") return "st-asst";
  if (node.role === "toolResult" || node.role === "bashExecution") return "st-tool";
  return "st-sys";
}

// 「当前」徽标吸附点：leaf 落在当前过滤下隐藏的节点（典型：auto-thinking 的 model_usage，
// 底座 navigateTree 对 user 目标 rewind past 时 leaf 停在 user 的父节点）时，徽标上溯到
// 最近一条可见祖先——不限类型：compaction 这类默认过滤下可见的转折点本身就是位置标记，
// 停在它上面。纯视觉——leaf 行原样保留、导航语义不变
function badgeTargetId(roots: EntryNode[], leafId: string | null, filter: string): string | null {
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
    const n = byId.get(id)!; // 断言：id 来自 byId/parentOf 键集合，必存在
    if (passesFilter(n, filter)) return n.id;
    id = parentOf.get(id) ?? null;
  }
  return leafId; // 兜底：没有可见祖先就挂在 leaf 自己
}

export default function SessionTreePage() {
  useStore();
  const s = activeOpen();
  const [filter, setFilter] = useState<string>("default");
  const [confirmNode, setConfirmNode] = useState<EntryNode | null>(null); // 待跳转节点
  if (!s) {
    return <div className="placeholder">（无活跃会话）</div>;
  }
  const tree = rightState.entryTree;
  const stale = !tree || tree.sessionId !== s.sessionId; // 切换会话后旧数据视为过期
  if (stale && !rightState.entryTreePending) {
    rightState.entryTreePending = true;
    rightState.entryTreeFor = s.sessionId; // 回包未带 sessionId 时归属用
    send({ type: "get_entry_tree", sessionId: s.sessionId });
  }
  if (stale) {
    return <div className="placeholder">加载中…</div>;
  }
  const roots = tree.roots ?? [];
  if (roots.length === 0) {
    return <div className="bt-empty">会话还没有任何条目。</div>;
  }
  const activeIds = activePathIds(roots, tree.leafId);
  const rows = flattenRows(roots, activeIds).filter((r) => passesFilter(r.node, filter));
  const badgeId = badgeTargetId(roots, tree.leafId, filter);
  const navigate = (summarize: boolean) => {
    const node = confirmNode!; // 断言：仅确认弹窗打开时可点（confirmNode 非空）
    setConfirmNode(null);
    rightState.entryTreeNav = true;
    send({ type: "navigate_tree", sessionId: s.sessionId, entryId: node.id, summarize });
    notify(); // 立即禁用行点击（回包前）
  };
  return (
    <div className="st-page">
      <div className="st-bar">
        <div className="mcp-type-pills">
          {FILTERS.map(([v, label]) => (
            <button key={v} type="button" className={"mcp-type-pill" + (filter === v ? " on" : "")} onClick={() => setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="st-list">
        {rows.map(({ node, gutters, connector }) => {
          const isLeaf = node.id === tree.leafId;
          const onPath = activeIds.has(node.id);
          return (
            <button
              key={node.id}
              className={"st-row" + (onPath ? " on-path" : "") + (isLeaf ? " leaf" : "")}
              title={node.text}
              disabled={rightState.entryTreeNav}
              onClick={() => {
                if (isLeaf) {
                  toast("已在当前位置");
                  return;
                }
                setConfirmNode(node);
              }}
            >
              <span className="st-prefix" aria-hidden>
                {gutters.map((g, i) => (
                  <span key={i} className="st-rail">
                    {g ? "│" : " "}
                  </span>
                ))}
                {connector ? <span className="st-conn">{connector}</span> : null}
              </span>
              <span className={"st-text " + roleClass(node)}>
                {onPath ? <span className="st-dot">•</span> : null}
                {node.label ? <span className="st-label">[{node.label}] </span> : null}
                {node.text || "（空）"}
              </span>
              {node.id === badgeId ? <span className="st-leaf">当前</span> : null}
              {node.ts ? <span className="st-ts">{fmtAgo(node.ts)}</span> : null}
            </button>
          );
        })}
        {rows.length === 0 ? <div className="bt-empty">当前过滤条件下没有条目。</div> : null}
      </div>
      {confirmNode ? (
        <div
          className="lp-mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmNode(null);
          }}
        >
          <div className="lp-box">
            <div className="lp-msg">跳转到所选节点？</div>
            <div className="cf-msg st-confirm-text">{confirmNode.label ? `[${confirmNode.label}] ` : ""}{confirmNode.text}</div>
            <div className="lp-row">
              <button className="save-btn" onClick={() => setConfirmNode(null)}>
                取消
              </button>
              <button className="save-btn" disabled={rightState.entryTreeNav} onClick={() => navigate(false)}>
                跳转
              </button>
              <button className="save-btn" disabled={rightState.entryTreeNav} onClick={() => navigate(true)}>
                跳转并摘要
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
