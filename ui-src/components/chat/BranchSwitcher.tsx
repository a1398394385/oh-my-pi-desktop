// Inline branch pager for a fork host. Clicking an arrow sends navigate_tree
// to the adjacent sibling branch's deepest leaf (cyclic); the existing
// session_navigated flow refetches the entry tree and MessagePage scrolls to
// the new host bubble.
import { useAppStore } from "../../store";
import Icon from "../../Icon";
import { cycleSiblingLeaf, setPendingBranchScroll, type BranchNavInfo, type BranchRenderCtx } from "./branch-nav";

interface Props {
  fk: string;
  entryId: string;
  info: BranchNavInfo;
  ctx: BranchRenderCtx;
}

export default function BranchSwitcher({ fk, entryId, info, ctx }: Props) {
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const streaming = useAppStore((st) => (st.activePath ? !!st.openSessions.get(st.activePath)?.streaming : false));
  const navBusy = useAppStore((st) => st.entryTreeNav);

  // Multi-bubble entries (one assistant entry, several text blocks): only the
  // render-order-last bubble carries the pager.
  if (ctx.lastFk.get(entryId) !== fk) return null;
  const disabled = streaming || navBusy;

  const go = (dir: 1 | -1) => {
    if (disabled || !sessionId) return;
    const leaf = cycleSiblingLeaf(info.siblingLeaves, info.index, dir);
    if (!leaf) return;
    setPendingBranchScroll({ forkId: info.forkId, sessionId, treeRef: useAppStore.getState().entryTree });
    useAppStore.setState({ entryTreeNav: true }); // same double-click guard as the tree page
    useAppStore.getState().send({ type: "navigate_tree", sessionId, entryId: leaf });
  };

  return (
    <>
      <button type="button" className="q-btn" disabled={disabled} aria-label="‹" onClick={() => go(-1)}>
        <Icon name="chevronLeft" size={13} />
      </button>
      <span className="bsw-kn">
        {info.index + 1}/{info.total}
      </span>
      <button type="button" className="q-btn" disabled={disabled} aria-label="›" onClick={() => go(1)}>
        <Icon name="chevronRight" size={13} />
      </button>
    </>
  );
}
