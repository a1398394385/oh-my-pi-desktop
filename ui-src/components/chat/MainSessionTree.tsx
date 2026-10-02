// Main-area session entry tree view: renders the session entry waterfall full-width in the
// main content area, with fork switching, drawer expansion, and jump navigation.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStore, send } from "../../store";
import Icon from "../../Icon";
import type { EntryNode } from "./sessionTreeUtil";
import { FILTERS, activePathIds } from "./sessionTreeUtil";
import SessionTreeStream from "./SessionTreeStream";
import { t } from "../../i18n";

export default function MainSessionTree() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const setMainViewMode = useAppStore((st) => st.setMainViewMode);
  const [filter, setFilter] = useState<string>("default");
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSessionRef = useRef<string | null>(null);
  // Tree data not mounted yet (stale renders a spinner); bottom-scroll must wait for it
  const treeReady = !!rightState.entryTree && !!s && rightState.entryTree.sessionId === s.sessionId;

  // Land at the very bottom on entering the tree page (= newest history, same
  // stick-to-bottom semantics as the message stream), done before paint so no
  // top frame flashes first. Session switch re-lands at the bottom too.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !treeReady) return;
    if (lastSessionRef.current === s?.sessionId) return;
    lastSessionRef.current = s?.sessionId ?? null;
    el.scrollTop = el.scrollHeight;
  }, [treeReady, s?.sessionId]);

  // Lazily load the entry tree data
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
        {t("chat.noActiveSession")}
      </div>
    );
  }

  const tree = rightState.entryTree;
  const stale = !tree || tree.sessionId !== s.sessionId;
  if (stale) {
    return (
      <div className="flex-1 flex items-center justify-center text-faint text-ui-base">
        <Icon name="refresh" className="animate-spin mr-2" size={16} />
        {t("chat.loadingTree")}
      </div>
    );
  }

  const roots = tree.roots ?? [];
  if (roots.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-faint text-ui-base gap-2">
        <span>{t("chat.noEntriesYet")}</span>
        <button
          className="text-accent hover:underline text-ui-sm cursor-pointer"
          onClick={() => setMainViewMode("chat")}
        >
          {t("chat.backToChat")}
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
      {/* Top toolbar: filter pills + refresh + back to chat */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-card/60 backdrop-blur-xs select-none">
        <div className="flex items-center gap-3">
          <span className="text-ui-xs text-faint font-medium">{t("chat.filterMode")}</span>
          <div className="mcp-type-pills">
            {FILTERS.map(([v, labelKey]) => (
              <button
                key={v}
                type="button"
                className={"mcp-type-pill" + (filter === v ? " on" : "")}
                onClick={() => setFilter(v)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className={"icon-btn pg-refresh " + (refreshing ? "spin" : "")}
            title={t("chat.refreshTree")}
            onClick={onRefresh}
          >
            <Icon name="refresh" size={15} />
          </button>
          <button
            type="button"
            className="flex items-center gap-1 px-2.5 py-1 text-ui-xs rounded-md border border-line bg-panel hover:bg-panel-2 transition-colors text-dim hover:text-text cursor-pointer"
            onClick={() => setMainViewMode("chat")}
            title={t("chat.backToStream")}
          >
            <Icon name="messagePlus" size={12} />
            <span>{t("chat.backToChat")}</span>
          </button>
        </div>
      </div>

      {/* Waterfall container */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
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
