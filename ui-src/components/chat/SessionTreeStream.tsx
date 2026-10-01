// 会话条目树瀑布流组件：自上而下的线性单轴流，遇分叉处通过单排横向滚轮切换，卡片支持原地抽屉展开。
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import Icon from "../../Icon";
import { fmtAgo } from "../right/helpers";
import { toast } from "../../store";
import { t } from "../../i18n";
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
  isCompact?: boolean;
}

export default function SessionTreeStream({
  roots,
  leafId,
  activeIds,
  filter,
  navigating,
  onNavigate,
  isCompact = false,
}: SessionTreeStreamProps) {
  // 分叉点选中的子分支 ID：Map<parentId, childId>
  const [selectedBranches, setSelectedBranches] = useState<Map<string, string>>(() => new Map());
  // 展开抽屉的节点集合
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  // 待跳转确认的节点
  const [confirmNode, setConfirmNode] = useState<EntryNode | null>(null);
  // Node id the keyboard cursor points at (null = no cursor yet)
  const [cursorId, setCursorId] = useState<string | null>(null);

  // 容器 ref 与切换分支时的视口锚定 ref
  const containerRef = useRef<HTMLDivElement>(null);
  const switchingForkRef = useRef<{ parentId: string; top: number } | null>(null);
  // 分叉点下方的最小高度支撑，防止短分支导致页面高度塌缩把内容顶上来
  const [branchMinHeights, setBranchMinHeights] = useState<Map<string, number>>(() => new Map());

  // 过滤条件或根变动时清空最小高度垫高
  useEffect(() => {
    setBranchMinHeights(new Map());
  }, [filter, roots]);

  // 切换分支：记录被点击分叉点的视口 top，计算下方所需撑底高度
  const onSelectBranchWithAnchor = (parentId: string, childId: string) => {
    const hub = containerRef.current?.querySelector(`[data-fork-parent="${parentId}"]`) as HTMLElement | null;
    const scrollEl = containerRef.current?.closest(".overflow-y-auto") as HTMLElement | null;

    if (hub && scrollEl) {
      const hubRect = hub.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      switchingForkRef.current = { parentId, top: hubRect.top };

      // 保证分叉点下方至少填满视口剩余空间，防止短分支导致页面高度骤缩把内容顶上来
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

  // 屏幕重绘前校准：如果分叉点视口 top 发生微小偏移，无感补偿 scrollTop 确保上半部分绝对纹丝不动
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

  // 弹窗打开时 Esc 键优先关闭弹窗
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

  // 根据当前分叉选择与过滤模式计算瀑布流单线序列
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
        {/* 竖线左侧的悬停快捷跳转按钮 */}
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

        {/* 导轨上的节点圆形微徽标 */}
        <div className="spine-bullet" title={roleBadgeText} />

        {/* 标签卡片主体 */}
        <div className="node-card">
          <div
            className="node-card-header"
            onClick={() => toggleExpand(node.id)}
            title={node.text || t("chat.emptyEntry")}
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

          {/* 展开内容抽屉面板 */}
          {isExpanded && (
            <div className="node-detail-panel show">
              <div className="detail-section-title">{t("chat.entryFullContent")}</div>
              <div className="detail-body font-mono text-ui-sm">
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
    <div ref={containerRef} className={`stream-container ${isCompact ? "compact" : ""}`}>
      {/* 贯穿全流的纵向单线轴导轨 */}
      <div className="stream-spine" />

      {/* 按分叉点分段渲染：保持上半部分不动，下方区域平滑切换 */}
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

      {/* 跳转二次确认弹框 */}
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
                  onNavigate(node, false);
                }}
              >
                {t("chat.jump")}
              </button>
              <button
                type="button"
                className="confirm-btn px-3 py-1.5 text-ui-sm bg-accent text-white rounded-md hover:opacity-90 font-medium cursor-pointer"
                disabled={navigating}
                onClick={() => {
                  const node = confirmNode;
                  setConfirmNode(null);
                  onNavigate(node, true);
                }}
              >
                {t("chat.jumpAndSummarize")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── 分叉点横向切换组件 ──
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

  // 滚轮控制横向滑动，并在滚动时动态显示滚动条（停止 650ms 平滑淡出）
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

  // 保证当前选中的分支药丸在可视范围内（仅横向局部滚动，严禁使用 scrollIntoView 避免纵向祖先容器抖动）
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
                title={summaryText}
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
