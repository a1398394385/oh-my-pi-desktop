// Branch pager: wraps a fork-host bubble (items.tsx withBranchPager) and shows
// a vertical up / k-n / down pill left of the host on hover. Clicking an arrow
// sends navigate_tree to the adjacent sibling branch's deepest leaf (cyclic);
// the existing session_navigated flow invalidates + refetches the entry tree
// and MessagePage scrolls to the new host bubble.
//
// The pill is portaled to document.body and placed from the host's rect
// (placeMenu idiom: set zoom first, divide visual coords back out) — it cannot
// live inside the message flow, where .turn-flow's overflow:clip would cut it
// off at the content-column edge.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppStore, effZoom, type TimerHandle } from "../../store";
import Icon from "../../Icon";
import { cycleSiblingLeaf, setPendingBranchScroll, type BranchNavInfo, type BranchRenderCtx } from "./branch-nav";

// keep in sync with .bsw-pop's width in messages.css
const PILL_W = 36;
const GAP = 8;

interface Props {
  fk: string;
  entryId: string;
  info: BranchNavInfo;
  ctx: BranchRenderCtx;
  children: ReactNode;
}

export default function BranchSwitcher({ fk, entryId, info, ctx, children }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<TimerHandle | undefined>(undefined);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const streaming = useAppStore((st) => (st.activePath ? !!st.openSessions.get(st.activePath)?.streaming : false));
  const navBusy = useAppStore((st) => st.entryTreeNav);

  // Multi-bubble entries (one assistant entry, several text blocks): only the
  // render-order-last bubble carries the pager
  const active = ctx.lastFk.get(entryId) === fk;
  if (!active) return <>{children}</>;
  const disabled = streaming || navBusy;

  const show = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return; // no hover on touch: the pager simply stays unavailable
    clearTimeout(hideTimer.current);
    const host = hostRef.current;
    if (!host) return;
    const z = effZoom();
    const hr = host.getBoundingClientRect();
    const top = Math.max(40, Math.min(hr.top + hr.height / 2, window.innerHeight - 40));
    setAt({ left: (hr.left - (PILL_W + GAP) * z) / z, top });
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setAt(null), 120); // grace: lets the pointer cross onto the pill
  };

  // The pill is fixed: any scroll moves the host out from under it — hide and
  // let the next hover re-place. Also applies the zoom factor to the pill.
  useEffect(() => {
    if (!at) return;
    const pill = pillRef.current;
    if (pill) (pill.style as CSSStyleDeclaration & { zoom: string }).zoom = String(effZoom());
    const onScroll = () => setAt(null);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [at]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const go = (dir: 1 | -1) => {
    if (disabled || !sessionId) return;
    const leaf = cycleSiblingLeaf(info.siblingLeaves, info.index, dir);
    if (!leaf) return;
    setPendingBranchScroll({ forkId: info.forkId, sessionId, treeRef: useAppStore.getState().entryTree });
    useAppStore.setState({ entryTreeNav: true }); // same double-click guard as the tree page
    useAppStore.getState().send({ type: "navigate_tree", sessionId, entryId: leaf });
  };

  return (
    <div className="bsw" data-eid={entryId} ref={hostRef} onPointerEnter={show} onPointerLeave={scheduleHide}>
      {children}
      {at &&
        createPortal(
          <div
            className="bsw-pop"
            ref={pillRef}
            style={{ left: at.left, top: at.top }}
            onPointerEnter={() => clearTimeout(hideTimer.current)}
            onPointerLeave={scheduleHide}
          >
            <button type="button" className="q-btn" disabled={disabled} aria-label="⌃" onClick={() => go(-1)}>
              <Icon name="chevronUp" size={13} />
            </button>
            <span className="bsw-kn">
              {info.index + 1}/{info.total}
            </span>
            <button type="button" className="q-btn" disabled={disabled} aria-label="⌄" onClick={() => go(1)}>
              <Icon name="chevronDown" size={13} />
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
