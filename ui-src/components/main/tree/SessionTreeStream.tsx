// Session entry tree waterfall component: a top-down linear single-axis flow; at forks,
// branches switch via a single-row horizontal scroller; cards support in-place drawer expansion.
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import Icon from "../../../Icon";
import { fmtAgo } from "../right/helpers";
import { toast, type TimerHandle } from "../../../store";
import { t } from "../../../i18n";
import type { EntryNode, StreamItem, StreamSection } from "./sessionTreeUtil";
import {
  buildStreamSequence,
  countBranchSteps,
  badgeTargetId,
  roleClass,
  splitSequenceIntoSections,
} from "./sessionTreeUtil";

interface SessionTreeStreamProps {
  roots: EntryNode[];
  leafId: string | null;
  activeIds: Set<string>;
  filter: string;
  navigating?: boolean;
  onNavigate: (node: EntryNode, summarize: boolean) => void;
}

// Detail-drawer scrollbar reveal timers (scroll -> visible, 650ms idle -> hidden),
// keyed by element so multiple expanded drawers stay independent.
const detailScrollTimers = new WeakMap<HTMLElement, TimerHandle>();
function flashDetailScrollbar(el: HTMLElement): void {
  el.classList.add("is-scrolling");
  clearTimeout(detailScrollTimers.get(el));
  detailScrollTimers.set(el, setTimeout(() => el.classList.remove("is-scrolling"), 650));
}

// Native-tooltip cap: the host now sends full text (the drawer owns full display),
// raw tooltips of thousands of chars would be unusable.
function tooltipText(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function SessionTreeStream({
  roots,
  leafId,
  activeIds,
  filter,
  navigating,
  onNavigate,
}: SessionTreeStreamProps) {
  // Child branch id chosen at each fork: Map<parentId, childId>
  const [selectedBranches, setSelectedBranches] = useState<Map<string, string>>(() => new Map());
  // Set of nodes whose drawers are expanded
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  // Node pending jump confirmation
  const [confirmNode, setConfirmNode] = useState<EntryNode | null>(null);
  // Node id the keyboard cursor points at (null = no cursor yet)
  const [cursorId, setCursorId] = useState<string | null>(null);

  // Container ref plus the viewport-anchoring ref used when switching branches
  const containerRef = useRef<HTMLDivElement>(null);
  const switchingForkRef = useRef<{ parentId: string; top: number } | null>(null);
  // Minimum-height support below fork points, preventing short branches from collapsing
  // the page height and pushing content up
  const [branchMinHeights, setBranchMinHeights] = useState<Map<string, number>>(() => new Map());

  // Clear the minimum-height padding when the filter or roots change
  useEffect(() => {
    setBranchMinHeights(new Map());
  }, [filter, roots]);

  // Switch branch: record the clicked fork point's viewport top, and compute the support
  // height needed below
  const onSelectBranchWithAnchor = (parentId: string, childId: string) => {
    const hub = containerRef.current?.querySelector(`[data-fork-parent="${parentId}"]`) as HTMLElement | null;
    const scrollEl = containerRef.current?.closest(".overflow-y-auto") as HTMLElement | null;

    if (hub && scrollEl) {
      const hubRect = hub.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      switchingForkRef.current = { parentId, top: hubRect.top };

      // Ensure the area below the fork point fills at least the viewport's remaining space,
      // preventing short branches from shrinking the page height abruptly and pushing content up
      const remaining = scrollRect.bottom - hubRect.bottom;
      if (remaining > 20) {
        setBranchMinHeights((prev) => {
          const next = new Map(prev);
          next.set(parentId, Math.ceil(remaining + 24));
          return next;
        });
      }
    }

    setSelectedBranches((prev) => {
      const next = new Map(prev);
      next.set(parentId, childId);
      return next;
    });
  };

  // Calibrate before repaint: if the fork point's viewport top shifts slightly, compensate
  // scrollTop imperceptibly so the upper half stays absolutely still
  useLayoutEffect(() => {
    const target = switchingForkRef.current;
    if (!target) return;
    switchingForkRef.current = null;

    const hub = containerRef.current?.querySelector(`[data-fork-parent="${target.parentId}"]`) as HTMLElement | null;
    const scrollEl = containerRef.current?.closest(".overflow-y-auto") as HTMLElement | null;
    if (!hub || !scrollEl) return;

    const currentTop = hub.getBoundingClientRect().top;
    const diff = currentTop - target.top;
    if (Math.abs(diff) > 0.5) {
      scrollEl.scrollTop += diff;
    }
  }, [selectedBranches]);

  // While the dialog is open, Esc closes it first; Enter triggers the default primary
  // action "jump" (left to the native button when focus is on a dialog button; not stolen)
  useEffect(() => {
    if (!confirmNode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setConfirmNode(null);
      } else if (e.key === "Enter" && !(e.target as HTMLElement).closest?.(".lp-box button")) {
        e.preventDefault();
        e.stopPropagation();
        const node = confirmNode;
        setConfirmNode(null);
        onNavigate(node, false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmNode]);

  // Compute the waterfall single-line sequence from the current fork selections and filter mode
  const sequence = buildStreamSequence(roots, leafId, activeIds, selectedBranches, filter);
  const badgeId = badgeTargetId(roots, leafId, filter);

  // Cursor only lands on node items; fork pill rows are skipped
  const cursorNodes = sequence.filter((it): it is Extract<StreamItem, { type: "node" }> => it.type === "node");

  // Move one step in visual order; stops at the edges (no wrap, so a stray key
  // press can't jump you to the far end). First press lands on the last item,
  // matching the "tree opens showing newest" direction.
  const moveCursor = (delta: number) => {
    if (cursorNodes.length === 0) return;
    setCursorId((prev) => {
      const cur = prev ? cursorNodes.findIndex((it) => it.node.id === prev) : -1;
      const next = cur === -1
        ? (delta > 0 ? 0 : cursorNodes.length - 1)
        : Math.min(cursorNodes.length - 1, Math.max(0, cur + delta));
      return cursorNodes[next].node.id;
    });
  };

  // Scroll the cursor row into view (vertical only; scrollIntoView would also
  // move ancestor scrollers and shake the page)
  useEffect(() => {
    if (!cursorId) return;
    const el = containerRef.current?.querySelector(`[data-node-id="${cursorId}"]`) as HTMLElement | null;
    const scrollEl = containerRef.current?.closest(".overflow-y-auto") as HTMLElement | null;
    if (!el || !scrollEl) return;
    const elRect = el.getBoundingClientRect();
    const boxRect = scrollEl.getBoundingClientRect();
    if (elRect.top < boxRect.top + 8) {
      scrollEl.scrollTop -= boxRect.top + 8 - elRect.top;
    } else if (elRect.bottom > boxRect.bottom - 8) {
      scrollEl.scrollTop += elRect.bottom - (boxRect.bottom - 8);
    }
  }, [cursorId]);

  // Enter on the cursor opens the jump confirm dialog — same path as clicking
  // the row's quick-jump button. Current/leaf entries open it too; the dialog
  // buttons decide what happens.
  const activateCursor = () => {
    if (!cursorId) return;
    const hit = cursorNodes.find((it) => it.node.id === cursorId);
    if (!hit) return;
    setConfirmNode(hit.node);
  };

  // Arrows / Enter on window capture — the same channel the dialog's Esc-close
  // uses. Everything yields while the dialog is open (it owns its own buttons
  // and Esc), so Enter can never leak through and trigger a jump.
  useEffect(() => {
    if (confirmNode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveCursor(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        activateCursor();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // sequence is recomputed every render; re-registering on cursorId change
    // keeps the closure reading the latest cursorNodes
  }, [confirmNode, cursorId, sequence]);

  const toggleExpand = (id: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onCopyText = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast(t("chat.copiedToClipboard"));
    }).catch(() => {
      toast(t("chat.copySuccessFallback"));
    });
  };

  if (sequence.length === 0) {
    return (
      <div className="py-12 text-center text-faint text-ui-base">
        {t("chat.noEntriesForFilter")}
      </div>
    );
  }

  const sections = splitSequenceIntoSections(sequence);

  const renderNodeItem = (item: Extract<StreamItem, { type: "node" }>) => {
    const { node, isLeaf, onPath } = item;
    const isExpanded = expandedNodeIds.has(node.id);
    const isCurrent = node.id === badgeId;
    const isCursor = cursorId === node.id;

    let roleBadgeText = t("chat.roleSystem");
    let roleBadgeType = "system";
    if (node.kind === "message") {
      if (node.role === "user") {
        roleBadgeText = t("chat.roleUser");
        roleBadgeType = "user";
      } else if (node.role === "assistant") {
        roleBadgeText = t("chat.roleAssistant");
        roleBadgeType = "assistant";
      } else if (node.role === "toolResult" || node.role === "bashExecution") {
        roleBadgeText = t("chat.roleTool");
        roleBadgeType = "tool";
      }
    }

    return (
      <div
        key={node.id}
        data-node-id={node.id}
        className={`stream-node-item is-${roleBadgeType} ${isCurrent || isLeaf ? "is-leaf" : ""} ${isCursor ? "is-cursor" : ""}`}
      >
        {/* Hover quick-jump button on the left of the vertical line */}
        {!isCurrent && (
          <button
            type="button"
            className="node-jump-btn"
            title={t("chat.jumpToNode")}
            disabled={navigating}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmNode(node);
            }}
          >
            <Icon name="arrowRight" size={13} />
          </button>
        )}

        {/* Circular node micro-badge on the spine */}
        <div className="spine-bullet" title={roleBadgeText} />

        {/* Label card body */}
        <div className="node-card">
          <div
            className="node-card-header"
            onClick={() => toggleExpand(node.id)}
            title={tooltipText(node.text || t("chat.emptyEntry"))}
          >
            <span className={`role-badge ${roleBadgeType}`}>
              {roleBadgeText}
            </span>

            <span className={`node-summary ${roleClass(node)}`}>
              {onPath ? <span className="text-accent mr-1 font-bold">•</span> : null}
              {node.label ? <span className="text-yellow mr-1">[{node.label}]</span> : null}
              {node.text || t("chat.emptyEntry")}
            </span>

            <div className="node-meta">
              {isCurrent ? <span className="leaf-tag">{t("chat.currentTag")}</span> : null}
              {node.ts ? <span className="node-time">{fmtAgo(node.ts)}</span> : null}
              <span className={`ed-arrow ${isExpanded ? "open" : ""}`}>
                <Icon name="chevronRight" size={14} />
              </span>
            </div>
          </div>

          {/* Expanded content drawer panel */}
          {isExpanded && (
            <div className="node-detail-panel show">
              <div className="detail-section-title">{t("chat.entryFullContent")}</div>
              <div
                className="detail-body font-mono text-ui-sm"
                onScroll={(e) => flashDetailScrollbar(e.currentTarget)}
              >
                {node.label ? `[${node.label}] ` : ""}
                {node.text || t("chat.emptyEntryContent")}
              </div>
              <div className="detail-actions">
                <button
                  type="button"
                  className="save-btn px-2.5 py-1 text-ui-xs border border-line rounded hover:bg-panel-2 cursor-pointer flex items-center gap-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyText(node.text || "");
                  }}
                >
                  <Icon name="copy" size={12} />
                  <span>{t("common.copy")}</span>
                </button>
                <button
                  type="button"
                  className="save-btn px-2.5 py-1 text-ui-xs border border-line rounded-md hover:bg-panel-2"
                  disabled={navigating}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isCurrent || isLeaf) {
                      toast(t("chat.alreadyHere"));
                      return;
                    }
                    setConfirmNode(node);
                  }}
                >
                  {t("chat.jumpHere")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} className="stream-container">
      {/* The single vertical line spine running through the whole flow */}
      <div className="stream-spine" />

      {/* Render in sections split at fork points: the upper half stays put while the area
          below switches smoothly */}
      {sections.map((sec, secIdx) => {
        const sectionKey = sec.fork ? `fork-sec-${sec.fork.parentId}` : "root-sec";
        const branchKey = sec.fork ? `branch-${sec.fork.parentId}-${sec.fork.selectedId}` : "root-branch";
        const minH = sec.fork ? branchMinHeights.get(sec.fork.parentId) : undefined;

        return (
          <div key={sectionKey} className="stream-section-block">
            {sec.fork && (
              <ForkSwitcher
                item={sec.fork}
                selectedBranches={selectedBranches}
                activeIds={activeIds}
                filter={filter}
                onSelectBranch={onSelectBranchWithAnchor}
              />
            )}
            <div
              key={branchKey}
              className={sec.fork ? "stream-branch-section" : "stream-root-section"}
              style={minH ? { minHeight: `${minH}px` } : undefined}
            >
              {sec.nodes.map((nodeItem) => renderNodeItem(nodeItem))}
            </div>
          </div>
        );
      })}

      {/* Jump confirmation dialog */}
      {confirmNode ? (
        <div
          className="lp-mask fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmNode(null);
          }}
        >
          <div className="lp-box bg-card border border-line rounded-lg p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="lp-msg text-ui-md font-semibold text-text">
              {t("chat.jumpConfirmTitle")}
            </div>
            <div className="cf-msg st-confirm-text text-ui-sm text-dim bg-panel p-2.5 rounded-md border border-line break-words max-h-48 overflow-y-auto">
              {confirmNode.label ? `[${confirmNode.label}] ` : ""}
              {confirmNode.text || t("chat.emptyEntry")}
            </div>
            <div className="lp-row flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className="save-btn px-3 py-1.5 text-ui-sm border border-line rounded-md hover:bg-panel-2 cursor-pointer"
                onClick={() => setConfirmNode(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="save-btn px-3 py-1.5 text-ui-sm border border-line rounded-md hover:bg-panel-2 cursor-pointer"
                disabled={navigating}
                onClick={() => {
                  const node = confirmNode;
                  setConfirmNode(null);
                  onNavigate(node, true);
                }}
              >
                {t("chat.jumpAndSummarize")}
              </button>
              <button
                type="button"
                className="confirm-btn px-3 py-1.5 text-ui-sm bg-accent text-white rounded-md hover:opacity-90 font-medium cursor-pointer"
                disabled={navigating}
                onClick={() => {
                  const node = confirmNode;
                  setConfirmNode(null);
                  onNavigate(node, false);
                }}
              >
                {t("chat.jump")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Fork point horizontal switcher ──
function ForkSwitcher({
  item,
  selectedBranches,
  activeIds,
  filter,
  onSelectBranch,
}: {
  item: { parentId: string; options: EntryNode[]; selectedId: string };
  selectedBranches: Map<string, string>;
  activeIds: Set<string>;
  filter: string;
  onSelectBranch: (parentId: string, childId: string) => void;
}) {
  const pillsRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Wheel drives horizontal sliding, and the scrollbar shows dynamically while scrolling
  // (smoothly fades out 650ms after it stops)
  useEffect(() => {
    const hub = containerRef.current;
    const pills = pillsRef.current;
    if (!hub || !pills) return;

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      pills.classList.add("is-scrolling");
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        pills.classList.remove("is-scrolling");
      }, 650);
    };

    const onWheel = (e: WheelEvent) => {
      if (pills.scrollWidth > pills.clientWidth) {
        e.preventDefault();
        e.stopPropagation();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        pills.scrollLeft += delta;
      }
    };

    pills.addEventListener("scroll", onScroll, { passive: true });
    hub.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      pills.removeEventListener("scroll", onScroll);
      hub.removeEventListener("wheel", onWheel);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, []);

  // Keep the currently selected branch pill in view (horizontal local scrolling only;
  // never scrollIntoView, to avoid shaking vertical ancestor containers)
  useEffect(() => {
    const pills = pillsRef.current;
    if (!pills) return;
    const activeEl = pills.querySelector(".fork-pill.active") as HTMLElement | null;
    if (!activeEl) return;

    const pillsRect = pills.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const pillLeft = activeRect.left - pillsRect.left + pills.scrollLeft;
    const pillRight = pillLeft + activeEl.offsetWidth;
    const scrollLeft = pills.scrollLeft;
    const clientWidth = pills.clientWidth;

    if (pillLeft < scrollLeft) {
      pills.scrollTo({ left: Math.max(0, pillLeft - 12), behavior: "smooth" });
    } else if (pillRight > scrollLeft + clientWidth) {
      pills.scrollTo({ left: pillRight - clientWidth + 12, behavior: "smooth" });
    }
  }, [item.selectedId]);

  return (
    <div ref={containerRef} className="stream-fork-hub" data-fork-parent={item.parentId}>
      <div className="fork-container">
        <div className="fork-header">
          <span className="fork-title">
            <Icon name="fork" size={13} />
            {t("chat.forkSwitch", { count: item.options.length })}
          </span>
          <span className="fork-hint">{t("chat.forkHint")}</span>
        </div>

        <div ref={pillsRef} className="fork-pills">
          {item.options.map((opt, i) => {
            const isActive = opt.id === item.selectedId;
            const steps = countBranchSteps(opt, selectedBranches, activeIds, filter);
            const labelText = opt.label ? `[${opt.label}] ` : "";
            const summaryText = opt.text || t("chat.emptyEntry");

            return (
              <button
                key={opt.id}
                type="button"
                className={`fork-pill ${isActive ? "active" : ""}`}
                onClick={() => {
                  onSelectBranch(item.parentId, opt.id);
                  toast(t("chat.switchedToBranch", { index: i + 1 }));
                }}
                title={tooltipText(summaryText)}
              >
                <span className="fork-pill-index">#{i + 1}</span>
                <span className="truncate max-w-[200px]">{labelText}{summaryText}</span>
                <span className="fork-pill-len">{t("chat.branchSteps", { count: steps })}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
