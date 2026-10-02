// Session tree page (right-panel version of the TUI /tree): entry waterfall of the session,
// with branch horizontal switching and detail expansion; the active path (root → current leaf)
// highlighted; clicking a node jumps to that point (optionally with a branch summary).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../store";
import type { EntryNode } from "../chat/sessionTreeUtil";
import { FILTERS, activePathIds } from "../chat/sessionTreeUtil";
import SessionTreeStream from "../chat/SessionTreeStream";

export default function SessionTreePage() {
  const { t } = useTranslation();
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
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  const tree = rightState.entryTree;
  const stale = !tree || tree.sessionId !== s.sessionId;
  if (stale) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("common.loading")}</div>;
  }
  const roots = tree.roots ?? [];
  if (roots.length === 0) {
    return <div className="py-[18px] px-3.5 text-faint text-ui-base leading-[1.6]" /* style-token-ignore */>{t("right.sessionNoItems")}</div>;
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
          {FILTERS.map(([v, labelKey]) => (
            <button key={v} type="button" className={"mcp-type-pill" + (filter === v ? " on" : "")} onClick={() => setFilter(v)}>
              {t(labelKey)}
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
