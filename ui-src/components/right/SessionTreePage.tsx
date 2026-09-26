// 会话树页（TUI /tree 的右栏版）：会话内条目树（rewind/fork 留下的兄弟分支同文件共存），
// 活跃路径（根→当前叶）高亮，点击节点跳转到该点（可带分支摘要）；被放弃路径保留为兄弟分支。
// 数据：get_entry_tree 懒加载（切会话后旧数据视为过期，对齐 BranchTreePage 模式）；
// 过滤语义对齐底座 tree-selector：默认 / 无工具 / 仅用户 / 全部。
import { useEffect, useState } from "react";
import { useAppStore, send, toast } from "../../store";
import { fmtAgo } from "./helpers";
import type { EntryNode } from "../chat/sessionTreeUtil";
import { FILTERS, activePathIds, flattenRows, passesFilter, roleClass, badgeTargetId } from "../chat/sessionTreeUtil";

export default function SessionTreePage() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const [filter, setFilter] = useState<string>("default");
  const [confirmNode, setConfirmNode] = useState<EntryNode | null>(null); // 待跳转节点
  // 过期数据重拉（原渲染体内联请求移此；pending 防重读 getState，回包由 store 落缓存）。
  // 无依赖数组 = 每次渲染后检查，对齐原「渲染体每次重绘检查」语义（请求失败解除 pending 后下次渲染重拉）
  useEffect(() => {
    const st = useAppStore.getState();
    const session = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!session) return;
    const tree = st.rightState.entryTree;
    if (tree && tree.sessionId === session.sessionId) return; // 未过期
    if (st.rightState.entryTreePending) return; // 防重
    useAppStore.setState((st2) => ({
      rightState: { ...st2.rightState, entryTreePending: true, entryTreeFor: session.sessionId }, // 回包未带 sessionId 时归属用
    }));
    send({ type: "get_entry_tree", sessionId: session.sessionId });
  });
  if (!s) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">（无活跃会话）</div>;
  }
  const tree = rightState.entryTree;
  const stale = !tree || tree.sessionId !== s.sessionId; // 切换会话后旧数据视为过期
  if (stale) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">加载中…</div>;
  }
  const roots = tree.roots ?? [];
  if (roots.length === 0) {
    return <div className="py-[18px] px-3.5 text-faint text-ui-base leading-[1.6]">会话还没有任何条目。</div>;
  }
  const activeIds = activePathIds(roots, tree.leafId);
  const rows = flattenRows(roots, activeIds).filter((r) => passesFilter(r.node, filter));
  const badgeId = badgeTargetId(roots, tree.leafId, filter);
  const navigate = (summarize: boolean) => {
    const node = confirmNode!; // 断言：仅确认弹窗打开时可点（confirmNode 非空）
    setConfirmNode(null);
    // 置位随 setState 渲染立即禁用行点击（原 notify 语义），回包由 session_navigated 复位
    useAppStore.setState((st) => ({ rightState: { ...st.rightState, entryTreeNav: true } }));
    send({ type: "navigate_tree", sessionId: s.sessionId, entryId: node.id, summarize });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="pt-1.5 px-2">
        <div className="mcp-type-pills">
          {FILTERS.map(([v, label]) => (
            <button key={v} type="button" className={"mcp-type-pill" + (filter === v ? " on" : "")} onClick={() => setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pt-1 px-2 pb-2">
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
                  <span key={i} className="inline-block w-[3ch]">
                    {g ? "│" : " "}
                  </span>
                ))}
                {connector ? <span className="text-faint">{connector}</span> : null}
              </span>
              <span className={"st-text " + roleClass(node)}>
                {onPath ? <span className="text-accent mr-1">•</span> : null}
                {node.label ? <span className="text-yellow">[{node.label}] </span> : null}
                {node.text || "（空）"}
              </span>
              {node.id === badgeId ? <span className="flex-none text-ui-xs text-accent border border-accent rounded-sm px-[5px] leading-4">当前</span> : null}
              {node.ts ? <span className="flex-none text-ui-xs text-faint">{fmtAgo(node.ts)}</span> : null}
            </button>
          );
        })}
        {rows.length === 0 ? <div className="py-[18px] px-3.5 text-faint text-ui-base leading-[1.6]">当前过滤条件下没有条目。</div> : null}
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
