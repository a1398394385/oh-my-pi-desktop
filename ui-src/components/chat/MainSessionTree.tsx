// 主区域会话条目树视图：在主内容区全宽呈现会话条目历史树，支持分支导航、跳转回退与多档过滤。
import { useEffect, useState } from "react";
import { useAppStore, send, toast } from "../../store";
import Icon from "../../Icon";
import { fmtAgo } from "../right/helpers";
import type { EntryNode } from "./sessionTreeUtil";
import { FILTERS, activePathIds, flattenRows, passesFilter, roleClass, badgeTargetId } from "./sessionTreeUtil";

export default function MainSessionTree() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const setMainViewMode = useAppStore((st) => st.setMainViewMode);
  const [filter, setFilter] = useState<string>("default");
  const [confirmNode, setConfirmNode] = useState<EntryNode | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 懒加载条目树数据
  useEffect(() => {
    const st = useAppStore.getState();
    const session = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!session) return;
    const tree = st.rightState.entryTree;
    if (tree && tree.sessionId === session.sessionId) return;
    if (st.rightState.entryTreePending) return;
    useAppStore.setState((st2) => ({
      rightState: { ...st2.rightState, entryTreePending: true, entryTreeFor: session.sessionId },
    }));
    send({ type: "get_entry_tree", sessionId: session.sessionId });
  });

  const onRefresh = () => {
    if (!s) return;
    setRefreshing(true);
    useAppStore.setState((st2) => ({
      rightState: { ...st2.rightState, entryTreePending: true, entryTreeFor: s.sessionId },
    }));
    send({ type: "get_entry_tree", sessionId: s.sessionId });
    setTimeout(() => setRefreshing(false), 600);
  };

  // 弹窗打开时 Esc 优先关闭弹窗
  useEffect(() => {
    if (!confirmNode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setConfirmNode(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmNode]);

  if (!s) {
    return (
      <div className="flex-1 flex items-center justify-center text-faint text-ui-base">
        （无活跃会话）
      </div>
    );
  }

  const tree = rightState.entryTree;
  const stale = !tree || tree.sessionId !== s.sessionId;
  if (stale) {
    return (
      <div className="flex-1 flex items-center justify-center text-faint text-ui-base">
        <Icon name="refresh" className="animate-spin mr-2" size={16} />
        加载会话树中…
      </div>
    );
  }

  const roots = tree.roots ?? [];
  if (roots.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-faint text-ui-base gap-2">
        <span>会话还没有任何条目。</span>
        <button
          className="text-accent hover:underline text-ui-sm cursor-pointer"
          onClick={() => setMainViewMode("chat")}
        >
          返回对话
        </button>
      </div>
    );
  }

  const activeIds = activePathIds(roots, tree.leafId);
  const rows = flattenRows(roots, activeIds).filter((r) => passesFilter(r.node, filter));
  const badgeId = badgeTargetId(roots, tree.leafId, filter);

  const navigate = (summarize: boolean) => {
    const node = confirmNode!;
    setConfirmNode(null);
    useAppStore.setState((st) => ({ rightState: { ...st.rightState, entryTreeNav: true } }));
    send({ type: "navigate_tree", sessionId: s.sessionId, entryId: node.id, summarize });
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-bg">
      {/* 顶部工具栏：过滤胶囊 + 刷新 + 返回对话 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-card/60 backdrop-blur-xs select-none">
        <div className="flex items-center gap-3">
          <span className="text-ui-xs text-faint font-medium">过滤模式：</span>
          <div className="mcp-type-pills">
            {FILTERS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={"mcp-type-pill" + (filter === v ? " on" : "")}
                onClick={() => setFilter(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className={"icon-btn pg-refresh " + (refreshing ? "spin" : "")}
            title="刷新条目树"
            onClick={onRefresh}
          >
            <Icon name="refresh" size={15} />
          </button>
          <button
            type="button"
            className="flex items-center gap-1 px-2.5 py-1 text-ui-xs rounded-md border border-line bg-panel hover:bg-panel-2 transition-colors text-dim hover:text-text cursor-pointer"
            onClick={() => setMainViewMode("chat")}
            title="返回对话流"
          >
            <Icon name="messagePlus" size={12} />
            <span>返回对话</span>
          </button>
        </div>
      </div>

      {/* 树节点内容列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-ui-sm">
        <div className="max-w-4xl mx-auto space-y-0.5">
          {rows.map(({ node, gutters, connector }) => {
            const isLeaf = node.id === tree.leafId;
            const onPath = activeIds.has(node.id);
            return (
              <button
                key={node.id}
                className={
                  "st-row flex items-baseline gap-2 w-full text-left py-1.5 px-2 rounded-md transition-colors cursor-pointer " +
                  (onPath ? " on-path bg-accent/5 " : " hover:bg-panel-2 ") +
                  (isLeaf ? " leaf font-medium " : "")
                }
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
                {/* 树导轨列 */}
                <span className="st-prefix flex-none text-faint" aria-hidden>
                  {gutters.map((g, i) => (
                    <span key={i} className="inline-block w-[3ch]">
                      {g ? "│" : " "}
                    </span>
                  ))}
                  {connector ? <span className="text-faint">{connector}</span> : null}
                </span>

                {/* 节点文本内容 */}
                <span className={"st-text flex-1 truncate " + roleClass(node)}>
                  {onPath ? <span className="text-accent mr-1 font-bold">•</span> : null}
                  {node.label ? <span className="text-yellow mr-1">[{node.label}]</span> : null}
                  {node.text || "（空条目）"}
                </span>

                {/* 当前节点徽标 */}
                {node.id === badgeId ? (
                  <span className="flex-none text-ui-xs text-accent border border-accent/70 bg-accent/10 rounded px-1.5 py-0.5 leading-none">
                    当前
                  </span>
                ) : null}

                {/* 时间戳 */}
                {node.ts ? (
                  <span className="flex-none text-ui-xs text-faint ml-2">
                    {fmtAgo(node.ts)}
                  </span>
                ) : null}
              </button>
            );
          })}

          {rows.length === 0 ? (
            <div className="py-8 text-center text-faint text-ui-base">
              当前过滤条件下没有条目。
            </div>
          ) : null}
        </div>
      </div>

      {/* 跳转二次确认弹框 */}
      {confirmNode ? (
        <div
          className="lp-mask fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmNode(null);
          }}
        >
          <div className="lp-box bg-card border border-line rounded-lg p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="lp-msg text-ui-md font-semibold text-text">
              跳转到所选节点？
            </div>
            <div className="cf-msg st-confirm-text text-ui-sm text-dim bg-panel p-2.5 rounded-md border border-line break-words">
              {confirmNode.label ? `[${confirmNode.label}] ` : ""}
              {confirmNode.text || "（空条目）"}
            </div>
            <div className="lp-row flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className="save-btn px-3 py-1.5 text-ui-sm border border-line rounded-md hover:bg-panel-2"
                onClick={() => setConfirmNode(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="save-btn px-3 py-1.5 text-ui-sm border border-line rounded-md hover:bg-panel-2"
                disabled={rightState.entryTreeNav}
                onClick={() => navigate(false)}
              >
                跳转
              </button>
              <button
                type="button"
                className="confirm-btn px-3 py-1.5 text-ui-sm bg-accent text-white rounded-md hover:opacity-90 font-medium"
                disabled={rightState.entryTreeNav}
                onClick={() => navigate(true)}
              >
                跳转并摘要
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
