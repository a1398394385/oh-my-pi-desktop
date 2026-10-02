// Left sidebar: new-task entry + view switch (recent/projects) + session list (tasklist) +
// bottom account/settings.
// Migrated from ui/sidebar.js (800 lines): renderList/taskRow/archive section/project drag
// reorder/context menu/confirm dialog/add-project popover/⌘N. Contract: render data subscribed
// via useAppStore selectors (diskProjects/pinnedSessions/viewMode/manage mode etc.), events
// write state with fresh references plus _v bump;
// DOM structure and class names cross-checked against ui/index.html + sidebar.js.
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import appIcon from "../../ui/app-icon.png";
import { MOD } from "../platform";
import {
  useAppStore, setBump, send, invoke, showWelcomeScreen, initNewSessionModel, activeOpen,
  getAvailableProjects, openSettings, pathBase,
} from "../store";
import Icon from "../Icon";
import SessionRow from "./sidebar/SessionRow";
import type { RenamingState, SessionInfo, SessionRowCallbacks } from "./sidebar/SessionRow";
import ProjGroup, { projectIconName } from "./sidebar/ProjGroup";
import type { ProjectIconSource } from "./sidebar/ProjGroup";
import ConfirmDialog from "./sidebar/ConfirmDialog";
import Menu from "./sidebar/Menu";
import SessCtxMenu from "./sidebar/SessCtxMenu";
import ProjAddPop from "./sidebar/ProjAddPop";
import SidebarSearch from "./sidebar/SidebarSearch";
import { computeSidebarSessionShortcuts } from "./sidebar/util";

// Content of the delete/remove confirm dialog
interface ConfirmSpec {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
  onConfirm: () => void;
}

// Session row context menu (entry + viewport coords + row key)
interface SessCtxSpec {
  entry: SessionInfo;
  x: number;
  y: number;
  key: string;
}

// Project drag geometry: base is a snapshot of every project group head + child list's
// footprint taken at pointer-down
interface ProjDragGroup {
  cwd: string;
  top: number;
  h: number;
}

// Drag candidate (pressed but under the 5px threshold); groups non-null means dragging has begun
interface ProjDragPending {
  cwd: string;
  pointerId: number;
  startClientY: number;
  groups: null;
}

interface ProjDragActive extends Omit<ProjDragPending, "groups"> {
  groups: ProjDragGroup[];
  selfH: number;
  k0: number;
  base: ProjDragGroup[];
  idx: number;
  x: number;
  y: number;
  left: number;
  w: number;
  grabY: number;
  label: string;
  iconName: string;
}

type ProjDrag = ProjDragPending | ProjDragActive;

// Snapshot of expansion/limits taken before entering manage mode (records only the projects existing at entry)
interface ManageSnap {
  cwd: string;
  wasExpanded: boolean;
  limit: number | null;
}

// Click "new" (including clicking again while already on the welcome page): explicitly return
// to the profile defaults — clear the manual-pick mark + force recalibration
function newTaskAction() {
  if (useAppStore.getState().isCreatingNew) {
    useAppStore.setState({ newSessionDirty: false }); // silent write (same old S assignment without bump)
    initNewSessionModel(true); // writes newSessionModel/newSessionThinking scalars; consumers all subscribe via selectors, so field writes notify
  }
  showWelcomeScreen(activeOpen()?.cwd);
}

export default function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  // Render data subscribed via selectors
  const diskProjects = useAppStore((s) => s.diskProjects);
  const pinnedSessions = useAppStore((s) => s.pinnedSessions);
  const viewMode = useAppStore((s) => s.viewMode);
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const hostSettings = useAppStore((s) => s.hostSettings);
  // getAvailableProjects() called directly during render (reads latest state internally); its
  // underlying fields must each be subscribed so changes trigger re-render
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const projectLimits = useAppStore((s) => s.projectLimits);
  const openSessions = useAppStore((s) => s.openSessions);
  const unseenFinished = useAppStore((s) => s.unseenFinished);
  const archivedSessions = useAppStore((s) => s.archivedSessions);
  void allProjects;
  void removedProjects;
  // Popover/local interaction state (formerly scattered across body-appended temp DOM and module vars)
  const [confirmDlg, setConfirmDlg] = useState<ConfirmSpec | null>(null); // { title, message, confirmText, danger, onConfirm }
  const [sessCtx, setSessCtx] = useState<SessCtxSpec | null>(null); // { entry, x, y } session row context menu
  const [projMenu, setProjMenu] = useState<{ cwd: string; rect: DOMRect } | null>(null); // { cwd, rect } project row "⋯" menu
  const [projAdd, setProjAdd] = useState<{ rect: DOMRect } | null>(null); // { rect } manual add-project popover anchor
  const [renaming, setRenaming] = useState<RenamingState | null>(null); // { key, path }: inline rename state (key distinguishes copies of the same session in pinned/recent/project groups)
  const [drag, setDrag] = useState<ProjDragActive | null>(null); // { cwd, selfH, k0, base:[{cwd,top,h}], idx, x, y, left, w, grabY }
  const dragRef = useRef<ProjDrag | null>(null); // latest drag state during pointer events; keeps high-frequency pointermove from reading a stale closure
  const suppressProjClickRef = useRef(false); // swallow the click produced by the same pointerup after a drag ends
  const listRef = useRef<HTMLDivElement>(null);
  const selBeforeCtxRef = useRef<string | null>(null); // selection before right-click (for WebKit word-selection undo)
  const manageSnap = useRef<ManageSnap[] | null>(null); // Snapshot of project expansion and limits before entering manage mode

  const closeProjPopups = () => {
    setProjMenu(null);
    setProjAdd(null);
    setSessCtx(null);
  };

  // ⌘N new task (document keydown in the old initSidebar)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // ⌘N yields while the settings page is open (old settingsOpen check ported; reads latest state during the event)
        if (useAppStore.getState().settingsOpen) return;
        newTaskAction();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // —— Delete-session confirm (shared by the manage-mode inline button / archive hard-delete) ——
  const askDeleteSession = (s: SessionInfo) => {
    const sTitle = s.title || s.firstMessage || s.id || t("sidebar.untitledSession");
    setConfirmDlg({
      title: t("sidebar.deleteSessionTitle"),
      message: t("sidebar.deleteSessionMsg", { title: sTitle }),
      confirmText: t("common.delete"),
      danger: true,
      onConfirm: () => {
        send({ type: "delete_session", path: s.path });
        const st = useAppStore.getState();
        if (st.activePath === s.path) {
          // openSessions container swapped to a fresh reference (silent write; re-render handled by showWelcomeScreen's _v bump)
          useAppStore.setState((cur) => {
            const openSessions = new Map(cur.openSessions);
            openSessions.delete(s.path);
            return { openSessions };
          });
          useAppStore.setState({ activePath: null }); // silent write (same old S assignment without bump)
          showWelcomeScreen(s.cwd || st.newSessionProject);
        }
      },
    });
  };

  // —— Remove-project confirm (shared by the group-head "remove" button and the "⋯" menu) ——
  const askRemoveProject = (cwd: string) => {
    const projName = pathBase(cwd) || cwd;
    setConfirmDlg({
      title: t("sidebar.removeProjectTitle"),
      message: t("sidebar.removeProjectMsg", { name: projName, cwd }),
      confirmText: t("sidebar.removeProjectConfirm"),
      danger: true,
      onConfirm: () => {
        send({ type: "remove_project", cwd });
      },
    });
  };

  // —— Session row context menu: record the pre-right-click selection, then undo the word
  // selection this right-click produced after the menu opens (WebKit) ——
  const onSessContext = (e: ReactMouseEvent, entry: SessionInfo, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    closeProjPopups();
    setSessCtx({ entry, x: e.clientX, y: e.clientY, key });
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString() !== selBeforeCtxRef.current) sel.removeAllRanges();
    });
  };

  // —— Project drag reorder (Pointer Events, self-drawn; cross-checked against ZCode's drag
  // overlay and yield animation) ——
  // Pointer-down first records a candidate; dragging begins only past 5px; plain clicks still
  // just expand/collapse.
  const onPointerDownHead = (e: ReactPointerEvent, cwd: string) => {
    dragRef.current = {
      cwd,
      pointerId: e.pointerId,
      startClientY: e.clientY,
      groups: null,
    };
    suppressProjClickRef.current = false;
  };

  const beginProjDrag = (e: ReactPointerEvent, pending: ProjDragPending): ProjDragActive | undefined => {
    const z = useAppStore.getState().zoomLevel || 1;
    const heads = [...listRef.current!.querySelectorAll<HTMLElement>(".project-scroll > .proj")]; // the list is guaranteed mounted by event time
    const base: ProjDragGroup[] = heads.map((head) => {
      const rect = head.getBoundingClientRect();
      const kids = head.nextElementSibling?.classList.contains("proj-kids") ? head.nextElementSibling : null;
      return {
        cwd: head.dataset.cwd!, // a .proj group head always carries data-cwd (guaranteed by ProjGroup rendering)
        // getBoundingClientRect returns screen pixels; yield transforms and drag displacement are both computed in zoomed CSS coordinates.
        top: rect.top / z,
        h: (rect.height + (kids?.getBoundingClientRect().height ?? 0)) / z,
      };
    });
    const k0 = base.findIndex((g) => g.cwd === pending.cwd);
    const head = heads[k0];
    const rect = head?.getBoundingClientRect();
    if (!head || k0 < 0 || !rect) return;
    const project: ProjectIconSource = visible.find((p) => p.cwd === pending.cwd) || { cwd: pending.cwd };
    const drag: ProjDragActive = {
      ...pending,
      selfH: base[k0].h,
      k0,
      base,
      groups: base,
      idx: k0,
      x: e.clientX / z,
      y: e.clientY / z,
      left: rect.left / z,
      w: rect.width / z,
      grabY: (e.clientY - rect.top) / z,
      label: head.querySelector(".pname")?.textContent || pathBase(pending.cwd) || pending.cwd,
      iconName: projectIconName(project, useAppStore.getState().expandedProjects.has(pending.cwd)),
    };
    dragRef.current = drag;
    // React state updates wait until the event turn ends; synchronously lock out selection
    // first so WebKit doesn't select text in the first move event.
    listRef.current?.classList.add("proj-dragging");
    window.getSelection()?.removeAllRanges();
    setDrag(drag);
    return drag;
  };

  const updateProjDrag = (e: ReactPointerEvent, d: ProjDragActive) => {
    const z = useAppStore.getState().zoomLevel || 1;
    const dy = (e.clientY - d.startClientY) / z;
    const self = d.base[d.k0];
    const dragMid = self.top + dy + self.h / 2;
    const others = d.base.filter((g) => g.cwd !== d.cwd);
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      if (dragMid < others[i].top + others[i].h / 2) {
        idx = i;
        break;
      }
    }
    const next: ProjDragActive = {
      ...d,
      idx,
      x: e.clientX / z,
      y: e.clientY / z,
      left: d.left,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerMoveHead = (e: ReactPointerEvent, cwd: string) => {
    const pending = dragRef.current;
    if (!pending || pending.cwd !== cwd || pending.pointerId !== e.pointerId) return;
    if (!pending.groups) {
      if (Math.abs(e.clientY - pending.startClientY) / (useAppStore.getState().zoomLevel || 1) < 5) return;
      const started = beginProjDrag(e, pending);
      if (!started) return;
    }
    e.preventDefault();
    // WebKit may keep a stale Range while the pointer is captured; clear on every move to
    // prevent blue selections while dragging across projects.
    window.getSelection()?.removeAllRanges();
    updateProjDrag(e, dragRef.current as ProjDragActive); // after beginProjDrag, dragRef is guaranteed the active-drag shape
  };

  const endProjDrag = (commit: boolean): boolean => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.groups) return false;
    listRef.current?.classList.remove("proj-dragging");
    window.getSelection()?.removeAllRanges();
    setDrag(null);
    suppressProjClickRef.current = true;
    setTimeout(() => { suppressProjClickRef.current = false; }, 0);
    if (!commit) return true;
    const others = d.base.filter((g) => g.cwd !== d.cwd).map((g) => g.cwd);
    const order = [...others];
    order.splice(d.idx, 0, d.cwd);
    const st = useAppStore.getState();
    const merged = [...st.allProjects];
    for (const c of order) if (!merged.includes(c)) merged.unshift(c);
    const arr = [...order, ...merged.filter((c) => !order.includes(c))];
    useAppStore.setState({ allProjects: arr }); // field write notifies (allProjects reference change drives sidebar re-render)
    send({ type: "reorder_projects", order: arr });
    return true;
  };

  const onPointerUpHead = (e: ReactPointerEvent, cwd: string) => {
    const d = dragRef.current;
    if (!d || d.cwd !== cwd || d.pointerId !== e.pointerId) return;
    endProjDrag(true);
  };

  const onPointerCancelHead = (e: ReactPointerEvent, cwd: string) => {
    const d = dragRef.current;
    if (!d || d.cwd !== cwd || d.pointerId !== e.pointerId) return;
    endProjDrag(false);
  };

  const shouldSuppressProjectClick = () => {
    if (!suppressProjClickRef.current) return false;
    suppressProjClickRef.current = false;
    return true;
  };

  // —— List data ——
  const manage = isProjectManageMode;
  // Pinned list: aggregated across projects, above the project list; pinned entries no longer
  // on disk are ignored automatically
  const pinnedRows = diskProjects
    .flatMap((p) => p.sessions)
    .filter((s) => pinnedSessions.has(s.path))
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  // Visible projects = all project list - removed; history-only projects merged as fallback (old-host compatibility)
  const visible = getAvailableProjects();
  // Recent view: all sessions by modified time descending, at most 50
  const flat = diskProjects
    .flatMap((p) => p.sessions.map((s) => ({ ...s, repo: pathBase(p.cwd) })))
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    .slice(0, 50);

  // Compute ⌘1~0 shortcut mapping (running first, unread fills in, order matches the list)
  const shortcuts = useMemo(() => {
    return computeSidebarSessionShortcuts({
      viewMode,
      diskProjects,
      pinnedSessions,
      expandedProjects,
      projectLimits,
      isProjectManageMode,
      openSessions,
      unseenFinished,
      availableProjects: visible,
      archivedSessions,
    });
  }, [viewMode, diskProjects, pinnedSessions, expandedProjects, projectLimits, isProjectManageMode, openSessions, unseenFinished, visible, archivedSessions]);

  const rowProps: SessionRowCallbacks = {
    onRenameStart: (key, path) => setRenaming({ key, path }),
    onRenameDone: () => setRenaming(null),
    onDelete: askDeleteSession,
    onContext: onSessContext,
  };
  const rowOf = (s: SessionInfo, opts: { sub?: boolean; showRepo?: boolean; pinnedList?: boolean } = {}, key: string, shortcutDigit?: string) => (
    <SessionRow
      key={s.path}
      s={s}
      {...rowProps}
      rowKey={key}
      renaming={renaming?.path === s.path && renaming?.key === key}
      sub={!!opts.sub}
      showRepo={!!opts.showRepo}
      pinnedList={!!opts.pinnedList}
      shortcutDigit={shortcutDigit}
    />
  );

  // "Projects" heading row + buttons: Tauri opens the system directory picker; plain browser
  // dev falls back to the manual-input popover
  const onSecAdd = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (projAdd) {
      closeProjPopups();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    closeProjPopups();
    if (invoke) {
      invoke("plugin:dialog|open", { options: { directory: true, title: t("sidebar.pickProjectDir") } })
        .then((p) => {
          if (p) send({ type: "add_project", cwd: p });
        })
        .catch(() => setProjAdd({ rect }));
    } else {
      setProjAdd({ rect });
    }
  };
  // Trash: enters/exits manage mode; on entry all projects expand with no row limit.
  // On exit, restore the expansion/limit state from before entry (previously collapsed
  // re-collapse, expanded stay) — the snapshot only records projects existing at entry;
  // ones newly expanded during manage mode are not rolled back
  const onSecTrash = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const st = useAppStore.getState();
    const nextManage = !st.isProjectManageMode;
    // Expanded-set/limit containers swapped to fresh references and setBump'd together with the
    // manage flag (equivalent of the old mutate + notify at the end)
    const nextExpanded = new Set(st.expandedProjects);
    const nextLimits = new Map(st.projectLimits);
    if (nextManage) {
      manageSnap.current = visible.map((pr) => ({
        cwd: pr.cwd,
        wasExpanded: st.expandedProjects.has(pr.cwd),
        limit: st.projectLimits.get(pr.cwd) ?? null, // get yields undefined when absent; normalized to null (same as the old has()?get():null)
      }));
      for (const pr of visible) {
        nextExpanded.add(pr.cwd);
        nextLimits.set(pr.cwd, Infinity);
      }
    } else {
      for (const s of manageSnap.current ?? []) {
        if (s.wasExpanded) nextExpanded.add(s.cwd);
        else nextExpanded.delete(s.cwd);
        if (s.limit != null) nextLimits.set(s.cwd, s.limit);
        else nextLimits.delete(s.cwd);
      }
      manageSnap.current = null;
    }
    setBump({ isProjectManageMode: nextManage, expandedProjects: nextExpanded, projectLimits: nextLimits });
  };

  return (
    <aside id="sidebar" className={collapsed ? "collapsed" : ""} data-tauri-drag-region="">
      <div className="pt-[10px] px-[10px] flex flex-col gap-[6px] flex-none">
        <div className="nav-item" id="navNew" onClick={newTaskAction}>
          <Icon name="messagePlus" size={19} />
          {t("sidebar.newTask")} <span className="ml-auto text-faint text-ui-sm tracking-[0.5px]" /* style-token-ignore */>{MOD} N</span>
        </div>
        <SidebarSearch />
      </div>
      <div className="flex items-center pt-[10px] px-[14px] pb-[8px] gap-[8px] flex-none">
        <div className="seg" id="seg">
          <button data-view="recent" className={viewMode === "recent" ? "on" : ""} onClick={() => setBump({ viewMode: "recent" })}>{t("sidebar.viewRecent")}</button>
          <button data-view="project" className={viewMode === "project" ? "on" : ""} onClick={() => setBump({ viewMode: "project" })}>{t("sidebar.viewProject")}</button>
          <button data-view="archive" className={viewMode === "archive" ? "on" : ""} onClick={() => setBump({ viewMode: "archive" })}>{t("sidebar.viewArchive")}</button>
        </div>
      </div>
      <div
        id="tasklist"
        ref={listRef}
        className={`${viewMode === "project" ? "project-view" : ""}${drag ? " proj-dragging" : ""}`}
        onSelectStart={(e) => {
          if (dragRef.current?.groups) e.preventDefault();
        }}
        onMouseDown={(e) => {
          if (e.button !== 2) return;
          const sel = window.getSelection(); // record the pre-right-click selection for the word-selection undo comparison
          selBeforeCtxRef.current = sel ? sel.toString() : null;
        }}
      >
        {viewMode === "project" ? (
          <>
            <div className="project-pinned">
              <div className="sec-label">{t("sidebar.pinnedLabel")}</div>
              {pinnedRows.length > 0 ? (
                pinnedRows.map((s) => rowOf(s, { pinnedList: true }, `pinned:${s.path}`, shortcuts.get(s.path)))
              ) : (
                <div className="pinned-empty text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">{t("sidebar.noPinned")}</div>
              )}
            </div>
            <div className="sec-label project-heading">
              <span>{t("sidebar.projectsLabel")}</span>
              <div className="flex items-center gap-[4px]">
                <button className="sec-add" title={t("sidebar.addProject")} onClick={onSecAdd}>
                  <Icon name="plus" size={15} />
                </button>
                <button
                  className={"sec-trash" + (manage ? " active" : "")}
                  title={manage ? t("sidebar.exitCleanMode") : t("sidebar.cleanProjects")}
                  onClick={onSecTrash}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
            <div className="project-scroll">
              {(() => {
                let oi = 0; // ordinal of the other groups (excluding the dragged one), for yield displacement
                return visible.map((p) => {
                  const isSelf = drag && p.cwd === drag.cwd;
                  const i = isSelf ? -1 : oi++;
                  // The dragged group's placeholder inserts at drag.idx: groups after it move
                  // down by selfH; groups after the dragged group's original slot first move up to backfill
                  const ty = drag && !isSelf
                    ? (drag.idx <= i ? drag.selfH : 0) - (drag.k0 <= i ? drag.selfH : 0)
                    : 0;
                  return (
                    <ProjGroup
                      key={p.cwd}
                      p={p}
                      ty={ty}
                      isDragSelf={!!isSelf}
                      dragging={!!drag}
                      onPointerDownHead={onPointerDownHead}
                      onPointerMoveHead={onPointerMoveHead}
                      onPointerUpHead={onPointerUpHead}
                      onPointerCancelHead={onPointerCancelHead}
                      shouldSuppressProjectClick={shouldSuppressProjectClick}
                      onOpenProjMenu={(e, cwd) => {
                        e.stopPropagation();
                        closeProjPopups();
                        setProjMenu({ cwd, rect: e.currentTarget.getBoundingClientRect() });
                      }}
                      onRemoveProject={askRemoveProject}
                      rowProps={rowProps}
                      renaming={renaming}
                      shortcuts={shortcuts}
                    />
                  );
                });
              })()}
              {visible.length === 0 && <div className="text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">{t("sidebar.noProjectsHint")}</div>}
            </div>
          </>
        ) : viewMode === "archive" ? (
          <>
            <div className="sec-label">{t("sidebar.archivedLabel")}</div>
            {archivedSessions.map((s) => rowOf(s, {}, `archive:${s.path}`, shortcuts.get(s.path)))}
            {archivedSessions.length === 0 && <div className="text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">{t("sidebar.noArchived")}</div>}
          </>
        ) : (
          <>
            <div className="sec-label">{t("sidebar.recentTasks")}</div>
            {flat.map((s) => rowOf(s, {}, `recent:${s.path}`, shortcuts.get(s.path)))}
            {flat.length === 0 && <div className="text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">{t("sidebar.noTasks")}</div>}
          </>
        )}
      </div>
      <div className="side-foot">
        <div className="avatar"><img src={appIcon} alt="" /></div>
        <div className="flex items-center gap-[6px] min-w-0">
          <span className="text-[15px] font-semibold text-text truncate leading-none" /* style-token-ignore */ id="sideProfileName">{hostSettings?.activeProfile || "default"}</span>
        </div>
        <span className="flex-1"></span>
        <button className="icon-btn" id="settingsBtn" title={t("sidebar.settings")} onClick={() => openSettings()}>
          <Icon name="settings" size={16} />
        </button>
      </div>

      {/* —— Popovers (portaled to body) —— */}
      {confirmDlg && (
        <ConfirmDialog {...confirmDlg} onClose={() => setConfirmDlg(null)} />
      )}
      {sessCtx && (
        <SessCtxMenu
          entry={sessCtx.entry}
          x={sessCtx.x}
          y={sessCtx.y}
          onClose={() => setSessCtx(null)}
          onRename={(entry) => setRenaming({ key: sessCtx.key, path: entry.path })}
        />
      )}
      {projMenu && (
        <Menu
          place={(mr) => [
            Math.max(8, Math.min(projMenu.rect.right + 4, window.innerWidth - mr.width - 8)),
            Math.min(
              Math.max(projMenu.rect.top + projMenu.rect.height / 2 - mr.height / 2, 8),
              window.innerHeight - mr.height - 8,
            ),
          ]}
          onClose={() => setProjMenu(null)}
        >
          <button onClick={() => { setProjMenu(null); askRemoveProject(projMenu.cwd); }}>{t("sidebar.remove")}</button>
        </Menu>
      )}
      {projAdd && <ProjAddPop anchorRect={projAdd.rect} onClose={() => setProjAdd(null)} />}
      {drag && (
        <div
          className="proj-drag-overlay"
          style={{ left: drag.left, top: drag.y - drag.grabY, width: drag.w || undefined }}
        >
          <span className="fic"><Icon name={drag.iconName} size={16} /></span>
          <span className="pname">{drag.label}</span>
        </div>
      )}
    </aside>
  );
}
