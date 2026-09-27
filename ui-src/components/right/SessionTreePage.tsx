// 会话树页（TUI /tree 的右栏版）：会话内条目瀑布流，支持分叉横向切换与详情展开，
// 活跃路径（根→当前叶）高亮，点击节点跳转到该点（可带分支摘要）。
import { useEffect, useState } from "react";
import { useAppStore, send } from "../../store";
import type { EntryNode } from "../chat/sessionTreeUtil";
import { FILTERS, activePathIds } from "../chat/sessionTreeUtil";
import SessionTreeStream from "../chat/SessionTreeStream";

export default function SessionTreePage() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const [filter, setFilter] = useState<string>("default");

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

  if (!s) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">（无活跃会话）</div>;
  }
  const tree = rightState.entryTree;
  const stale = !tree || tree.sessionId !== s.sessionId;
  if (stale) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">加载中…</div>;
  }
  const roots = tree.roots ?? [];
  if (roots.length === 0) {
    return <div className="py-[18px] px-3.5 text-faint text-ui-base leading-[1.6]">会话还没有任何条目。</div>;
  }

  const activeIds = activePathIds(roots, tree.leafId);

  const onNavigate = (node: EntryNode, summarize: boolean) => {
    useAppStore.setState((st) => ({ rightState: { ...st.rightState, entryTreeNav: true } }));
    send({ type: "navigate_tree", sessionId: s.sessionId, entryId: node.id, summarize });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="pt-2 px-3 pb-1 border-b border-line/60">
        <div className="mcp-type-pills">
          {FILTERS.map(([v, label]) => (
            <button key={v} type="button" className={"mcp-type-pill" + (filter === v ? " on" : "")} onClick={() => setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pt-2 px-2 pb-4">
        <SessionTreeStream
          roots={roots}
          leafId={tree.leafId}
          activeIds={activeIds}
          filter={filter}
          navigating={rightState.entryTreeNav}
          onNavigate={onNavigate}
          isCompact={true}
        />
      </div>
    </div>
  );
}
