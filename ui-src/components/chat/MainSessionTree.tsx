// 主区域会话条目树视图：在主内容区全宽呈现会话条目瀑布流，支持分叉横向切换、抽屉展开与跳转回退。
import { useEffect, useState } from "react";
import { useAppStore, send } from "../../store";
import Icon from "../../Icon";
import type { EntryNode } from "./sessionTreeUtil";
import { FILTERS, activePathIds } from "./sessionTreeUtil";
import SessionTreeStream from "./SessionTreeStream";

export default function MainSessionTree() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const setMainViewMode = useAppStore((st) => st.setMainViewMode);
  const [filter, setFilter] = useState<string>("default");
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

  const onNavigate = (node: EntryNode, summarize: boolean) => {
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

      {/* 瀑布流容器 */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <SessionTreeStream
          roots={roots}
          leafId={tree.leafId}
          activeIds={activeIds}
          filter={filter}
          navigating={rightState.entryTreeNav}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}
