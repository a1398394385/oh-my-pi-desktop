// Project group (ported from the project branch of ui/sidebar.js renderList): group head
// (folder icon/name/＋/⋯ or the manage-mode "remove" button) + expanded session container.
// Clicking the head toggles collapse/expand (grid 0fr↔1fr transition + staggered kids-in row
// entrance); the expanded set is written to the host omp-desktop.json; the head participates in
// drag reorder via Pointer Events, with displacement computed centrally by Sidebar.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, showWelcomeScreen, pathBase } from "../../../store";
import Icon from "../../../Icon";
import SessionRow from "./SessionRow";
import type { RenamingState, SessionInfo, SessionRowCallbacks } from "./SessionRow";

// Minimal input for project icon resolution (remote/home fields not yet produced by the host; kept as unknown boolean sources for compatibility)
export interface ProjectIconSource {
  cwd?: string;
  remote?: unknown;
  remoteWorkspace?: unknown;
  workspaceIdentity?: unknown;
  isHome?: unknown;
  home?: unknown;
  /** SSH remote-workspace display label ("host:/remote/path"); set on session_list project rows */
  remoteLabel?: string;
}

// Project entry (structural subset of getAvailableProjects/diskProjects elements;
// the full store-side type is defined by the P2F batch — this declares only the fields this
// batch consumes; structural compatibility suffices)
export interface ProjectInfo extends ProjectIconSource {
  cwd: string;
  name?: string;
  sessions: SessionInfo[];
}

// Project icons keep the same state semantics as ZCode's WorkspaceSidebarItem: cloud for
// remote, house for the local home, and a folder switching with expanded state for ordinary
// projects. The host's project data currently has no separate remote/home fields; keep the
// future-field compatibility while retaining the ssh/http-path and ~-directory detection.
export function projectIconName(p: ProjectIconSource, expanded: boolean): string {
  const cwd = p.cwd || "";
  const remote = Boolean(p.remote || p.remoteWorkspace || p.workspaceIdentity) || /^(ssh|https?):\/\//i.test(cwd);
  const home = Boolean(p.isHome || p.home) || cwd === "~";
  if (remote) return "cloud";
  if (home) return "house";
  return expanded ? "folderOpen" : "folder";
}

// Expanded session container (old buildProjKids): on mount plays the 0fr→1fr expand animation;
// when animate, rows enter staggered with kids-in.
// Manage mode shows all sessions; default 5, "show more" loads 5 more per click.
function ProjKids({ p, animate, closing, ty, dragging, isDragSelf, rowProps, renaming, shortcuts }: {
  p: ProjectInfo;
  animate: boolean;
  closing: boolean;
  ty: number;
  dragging: boolean;
  isDragSelf: boolean;
  rowProps: SessionRowCallbacks;
  renaming: RenamingState | null;
  shortcuts?: Map<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const projectLimits = useAppStore((s) => s.projectLimits);
  useLayoutEffect(() => {
    const el = ref.current!; // exists right after mount (the old JS dereferenced directly; same assumption kept)
    el.style.gridTemplateRows = "0fr";
    // Double rAF: ensure 0fr lands in layout first, then transition back to 1fr (CSS transition)
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.gridTemplateRows = ""; }));
  }, []);
  const limit = isProjectManageMode ? Infinity : (projectLimits.get(p.cwd) ?? 5);
  const visibleSessions = p.sessions.slice(0, limit);
  const shift = { transform: ty ? `translateY(${ty}px)` : undefined };
  return (
    <div
      className={"proj-kids" + (closing ? " closing" : "") + (dragging && !isDragSelf ? " shift-anim" : "") + (isDragSelf ? " drag-float" : "")}
      ref={ref}
      style={shift}
    >
      <div className="proj-kids-in">
        {visibleSessions.map((s, i) => {
          const rowKey = `proj:${p.cwd}:${s.path}`;
          return (
            <SessionRow
              key={s.path}
              s={s}
              sub
              {...rowProps}
              rowKey={rowKey}
              renaming={renaming?.path === s.path && renaming?.key === rowKey}
              shortcutDigit={shortcuts?.get(s.path)}
              className={animate ? "kids-in" : undefined}
              style={animate ? { animationDelay: `${i * 25}ms` } : undefined}
            />
          );
        })}
        {!isProjectManageMode && p.sessions.length > visibleSessions.length && (
          <button
            className={"more-link" + (animate ? " kids-in" : "")}
            onClick={() => {
              // Loosen the row limit: container to fresh reference + _v bump (equivalent of old mutate+notify)
              useAppStore.setState((st) => ({
                projectLimits: new Map(st.projectLimits).set(p.cwd, visibleSessions.length + 5),
              }));
            }}
          >
            {t("sidebar.showMore")}
          </button>
        )}
        {p.sessions.length === 0 && <div className={"text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]" + (animate ? " kids-in" : "")}>{t("sidebar.noTasks")}</div>}
      </div>
    </div>
  );
}

export default function ProjGroup({ p, ty, isDragSelf, dragging, onPointerDownHead, onPointerMoveHead, onPointerUpHead, onPointerCancelHead, shouldSuppressProjectClick, onOpenProjMenu, onRemoveProject, rowProps, renaming, shortcuts }: {
  p: ProjectInfo;
  ty: number;
  isDragSelf: boolean;
  dragging: boolean;
  onPointerDownHead: (e: ReactPointerEvent, cwd: string) => void;
  onPointerMoveHead: (e: ReactPointerEvent, cwd: string) => void;
  onPointerUpHead: (e: ReactPointerEvent, cwd: string) => void;
  onPointerCancelHead: (e: ReactPointerEvent, cwd: string) => void;
  shouldSuppressProjectClick: () => boolean;
  onOpenProjMenu: (e: ReactMouseEvent, cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  rowProps: SessionRowCallbacks;
  renaming: RenamingState | null;
  shortcuts?: Map<string, string>;
}) {
  const { t } = useTranslation();
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const expanded = expandedProjects.has(p.cwd);
  const [showKids, setShowKids] = useState(expanded); // render immediately on first mount without animation (mirrors the old renderList rebuild)
  const [closing, setClosing] = useState(false);

  // Mount kids on expand / delay unmount on collapse (remove only after the 0.3s collapse animation finishes)
  useEffect(() => {
    if (expanded && (!showKids || closing)) {
      setClosing(false);
      setShowKids(true);
    } else if (!expanded && showKids && !closing) {
      setClosing(true);
      const t = setTimeout(() => {
        setShowKids(false);
        setClosing(false);
      }, 310);
      return () => clearTimeout(t);
    }
  }, [expanded, showKids, closing]);

  const toggle = () => {
    const st = useAppStore.getState();
    const wasExpanded = st.expandedProjects.has(p.cwd);
    const nextExpanded = new Set(st.expandedProjects); // container to fresh reference + _v bump (equivalent of old mutate+notify)
    const nextLimits = wasExpanded ? st.projectLimits : new Map(st.projectLimits);
    if (wasExpanded) nextExpanded.delete(p.cwd);
    else {
      nextExpanded.add(p.cwd);
      nextLimits.delete(p.cwd); // re-expanding resets paging to the default 5 rows
    }
    send({ type: "set_project_expanded", cwd: p.cwd, expanded: !wasExpanded });
    useAppStore.setState({ expandedProjects: nextExpanded, projectLimits: nextLimits });
  };

  // Remote SSH workspace stubs show host:path (the stub path stays in the tooltip)
  const name = p.name || p.remoteLabel || pathBase(p.cwd) || p.cwd;
  return (
    <>
      <div
        className={"proj" + (expanded ? "" : " collapsed") + (dragging && !isDragSelf ? " shift-anim" : "") + (isDragSelf ? " drag-float" : "")}
        data-cwd={p.cwd}
        style={{ transform: ty ? `translateY(${ty}px)` : undefined }}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest("button")) return; // inline buttons (＋/⋯/remove) unaffected; e.target is always an Element at runtime
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onPointerDownHead(e, p.cwd);
        }}
        onPointerMove={(e) => onPointerMoveHead(e, p.cwd)}
        onPointerUp={(e) => {
          onPointerUpHead(e, p.cwd);
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={(e) => {
          onPointerCancelHead(e, p.cwd);
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onClick={() => {
          if (shouldSuppressProjectClick()) return;
          toggle();
        }}
      >
        <span className={"fic" + (/[\u4e00-\u9fa5]/.test(name) ? " is-cjk" : "")}><Icon name={projectIconName(p, expanded)} size={16} /></span>
        <span className="pname" title={p.remoteLabel ? `${p.remoteLabel}\n${p.cwd}` : p.cwd}>{name}</span>
        {isProjectManageMode ? (
          <button
            className="proj-rm-btn"
            title={t("sidebar.removeProjectCwd", { cwd: p.cwd })}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveProject(p.cwd);
            }}
          >
            {t("sidebar.remove")}
          </button>
        ) : (
          <>
            <button
              className="padd"
              title={t("sidebar.newSessionIn", { cwd: p.cwd })}
              onClick={(e) => {
                e.stopPropagation();
                showWelcomeScreen(p.cwd);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              className="pmore"
              title={t("sidebar.more")}
              onClick={(e) => {
                e.stopPropagation();
                onOpenProjMenu(e, p.cwd);
              }}
            >
              <Icon name="dots" size={14} />
            </button>
          </>
        )}
      </div>
      {showKids && <ProjKids p={p} animate={expanded && !closing} closing={closing} ty={isDragSelf ? 0 : ty} dragging={dragging} isDragSelf={isDragSelf} rowProps={rowProps} renaming={renaming} shortcuts={shortcuts} />}
    </>
  );
}
