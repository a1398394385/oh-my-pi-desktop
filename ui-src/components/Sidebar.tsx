// 左栏：新建任务入口 + 视图切换（最近/项目）+ 会话列表（tasklist）+ 底部账号/设置。
// 迁移自 ui/sidebar.js（800 行）：renderList/taskRow/归档区/项目拖拽排序/右键菜单/
// 确认弹窗/添加项目弹层/⌘N。契约：渲染数据经 useAppStore selector 订阅（diskProjects/
// pinnedSessions/viewMode/管理态等），事件内写状态换新引用并带 _v bump；
// DOM 结构与类名对照 ui/index.html + sidebar.js。
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import appIcon from "../../ui/app-icon.png";
import { MOD } from "../platform";
import {
  useAppStore, setBump, send, invoke, showWelcomeScreen, initNewSessionModel, activeOpen,
  getAvailableProjects, openSettings,
} from "../store";
import Icon from "../Icon";
import SessionRow from "./sidebar/SessionRow";
import type { RenamingState, SessionInfo, SessionRowCallbacks } from "./sidebar/SessionRow";
import ProjGroup, { projectIconName } from "./sidebar/ProjGroup";
import type { ProjectIconSource } from "./sidebar/ProjGroup";
import ArchivedSection from "./sidebar/ArchivedSection";
import ConfirmDialog from "./sidebar/ConfirmDialog";
import Menu from "./sidebar/Menu";
import SessCtxMenu from "./sidebar/SessCtxMenu";
import ProjAddPop from "./sidebar/ProjAddPop";
import SidebarSearch from "./sidebar/SidebarSearch";

// 删除/移除二次确认弹窗内容
interface ConfirmSpec {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
  onConfirm: () => void;
}

// 会话行右键菜单（entry + 视口坐标 + 行 key）
interface SessCtxSpec {
  entry: SessionInfo;
  x: number;
  y: number;
  key: string;
}

// 项目拖动几何：base 为按下时刻各项目组头+子列表的占位快照
interface ProjDragGroup {
  cwd: string;
  top: number;
  h: number;
}

// 拖动候选（按下未过 5px 阈值）；groups 非 null 表示已进入拖动态
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

// 清理模式进入前的展开/条数快照（只记进入时刻的存量项目）
interface ManageSnap {
  cwd: string;
  wasExpanded: boolean;
  limit: number | null;
}

// 点新建（含已在欢迎页时再点）：明确回到配置文件默认——清手选标记 + 强制重校准
function newTaskAction() {
  if (useAppStore.getState().isCreatingNew) {
    useAppStore.setState({ newSessionDirty: false }); // 静默写（同原 S 赋值不 bump）
    initNewSessionModel(true); // 写 newSessionModel/newSessionThinking 标量，消费者已全部 selector 订阅，字段写入即通知
  }
  showWelcomeScreen(activeOpen()?.cwd);
}

export default function Sidebar({ collapsed }: { collapsed: boolean }) {
  // 渲染数据经 selector 订阅（须在 collapsed 早退之前：hooks 不可条件调用）
  const diskProjects = useAppStore((s) => s.diskProjects);
  const pinnedSessions = useAppStore((s) => s.pinnedSessions);
  const viewMode = useAppStore((s) => s.viewMode);
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const hostSettings = useAppStore((s) => s.hostSettings);
  // getAvailableProjects() 渲染期直调（内部读最新态），其底层字段须各自订阅，变化才触发重渲染
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  void allProjects;
  void removedProjects;
  // 弹层/局部交互态（原版散在 body append 的临时 DOM 与模块变量上）
  const [confirmDlg, setConfirmDlg] = useState<ConfirmSpec | null>(null); // { title, message, confirmText, danger, onConfirm }
  const [sessCtx, setSessCtx] = useState<SessCtxSpec | null>(null); // { entry, x, y } 会话行右键菜单
  const [projMenu, setProjMenu] = useState<{ cwd: string; rect: DOMRect } | null>(null); // { cwd, rect } 项目行「⋯」菜单
  const [projAdd, setProjAdd] = useState<{ rect: DOMRect } | null>(null); // { rect } 手动添加项目弹层锚点
  const [renaming, setRenaming] = useState<RenamingState | null>(null); // { key, path }：行内重命名态（key 区分置顶/最近/项目组中的同一会话副本）
  const [drag, setDrag] = useState<ProjDragActive | null>(null); // { cwd, selfH, k0, base:[{cwd,top,h}], idx, x, y, left, w, grabY }
  const dragRef = useRef<ProjDrag | null>(null); // 指针事件期间的最新拖动状态，避免高频 pointermove 读到旧闭包
  const suppressProjClickRef = useRef(false); // 拖动结束后吞掉同一次 pointerup 产生的 click
  const listRef = useRef<HTMLDivElement>(null);
  const selBeforeCtxRef = useRef<string | null>(null); // 右键前选区（WebKit 右键选词撤销用）
  const manageSnap = useRef<ManageSnap[] | null>(null); // 清理模式进入前的展开/条数快照（hooks 必须在折叠早退之前）

  const closeProjPopups = () => {
    setProjMenu(null);
    setProjAdd(null);
    setSessCtx(null);
  };

  // ⌘N 新建任务（原 initSidebar 的 document keydown）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // 设置页打开时 ⌘N 不抢占（旧版 settingsOpen 检查平移；事件期读最新态）
        if (useAppStore.getState().settingsOpen) return;
        newTaskAction();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // —— 删除会话确认（管理模式行内按钮 / 归档区彻底删除共用） ——
  const askDeleteSession = (s: SessionInfo) => {
    const sTitle = s.title || s.firstMessage || s.id || "未命名会话";
    setConfirmDlg({
      title: "删除会话",
      message: `确定要永久删除此会话吗？此操作无法撤销。\n\n会话：${sTitle}`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        send({ type: "delete_session", path: s.path });
        const st = useAppStore.getState();
        if (st.activePath === s.path) {
          // openSessions 容器换新引用（静默写，重渲染由 showWelcomeScreen 的 _v bump 负责）
          useAppStore.setState((cur) => {
            const openSessions = new Map(cur.openSessions);
            openSessions.delete(s.path);
            return { openSessions };
          });
          useAppStore.setState({ activePath: null }); // 静默写（同原 S 赋值不 bump）
          showWelcomeScreen(s.cwd || st.newSessionProject);
        }
      },
    });
  };

  // —— 移除项目确认（组头「移除」钮与「⋯」菜单共用） ——
  const askRemoveProject = (cwd: string) => {
    const projName = cwd.split("/").filter(Boolean).pop() || cwd;
    setConfirmDlg({
      title: "移除项目",
      message: `确定要将项目「${projName}」从项目列表中移除吗？\n\n项目目录：${cwd}\n（会话仍保留在历史中，可在最近视图中查看）`,
      confirmText: "移除",
      danger: true,
      onConfirm: () => {
        send({ type: "remove_project", cwd });
      },
    });
  };

  // —— 会话行右键菜单：记录右键前选区，弹出后撤销本次右键新产生的选词（WebKit） ——
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

  // —— 项目拖拽排序（Pointer Events 自绘，对照 ZCode 的拖动浮层与让位动画） ——
  // 按下先记录候选，超过 5px 才进入拖动态；这样普通点击仍然只负责展开/收起。
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
    const heads = [...listRef.current!.querySelectorAll<HTMLElement>(".project-scroll > .proj")]; // 事件期列表必已挂载
    const base: ProjDragGroup[] = heads.map((head) => {
      const rect = head.getBoundingClientRect();
      const kids = head.nextElementSibling?.classList.contains("proj-kids") ? head.nextElementSibling : null;
      return {
        cwd: head.dataset.cwd!, // .proj 组头必带 data-cwd（ProjGroup 渲染保证）
        // getBoundingClientRect 返回屏幕像素；让位 transform 与拖拽位移都在 zoom 后的 CSS 坐标中计算。
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
      label: head.querySelector(".pname")?.textContent || pending.cwd.split("/").filter(Boolean).pop() || pending.cwd,
      iconName: projectIconName(project, useAppStore.getState().expandedProjects.has(pending.cwd)),
    };
    dragRef.current = drag;
    // React 状态更新要等本轮事件结束；先同步锁住选择，避免 WebKit 在首个移动事件中选中文本。
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
    // 指针捕获期间 WebKit 仍可能保留旧的 Range；每次位移都清掉，防止拖过项目时出现蓝色选区。
    window.getSelection()?.removeAllRanges();
    updateProjDrag(e, dragRef.current as ProjDragActive); // 经 beginProjDrag 后 dragRef 必为拖动态
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
    useAppStore.setState({ allProjects: arr }); // 字段写入即通知（allProjects 引用变化驱动侧栏重渲染）
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

  if (collapsed) return <aside id="sidebar" className="collapsed" data-tauri-drag-region=""></aside>;

  // —— 列表数据 ——
  const manage = isProjectManageMode;
  // 置顶列表：跨项目聚合，位于项目列表上方；磁盘上已不存在的置顶自动忽略
  const pinnedRows = diskProjects
    .flatMap((p) => p.sessions)
    .filter((s) => pinnedSessions.has(s.path))
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  // 可见项目 = 所有项目列表 - 已移除；历史里的项目兜底并入（兼容旧宿主）
  const visible = getAvailableProjects();
  // 最近视图：全部会话按修改时间倒序，最多 50 条
  const flat = diskProjects
    .flatMap((p) => p.sessions.map((s) => ({ ...s, repo: p.cwd.split("/").filter(Boolean).pop() })))
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    .slice(0, 50);

  const rowProps: SessionRowCallbacks = {
    onRenameStart: (key, path) => setRenaming({ key, path }),
    onRenameDone: () => setRenaming(null),
    onDelete: askDeleteSession,
    onContext: onSessContext,
  };
  const rowOf = (s: SessionInfo, opts: { sub?: boolean; showRepo?: boolean; pinnedList?: boolean } = {}, key: string) => (
    <SessionRow
      key={s.path}
      s={s}
      {...rowProps}
      rowKey={key}
      renaming={renaming?.path === s.path && renaming?.key === key}
      sub={!!opts.sub}
      showRepo={!!opts.showRepo}
      pinnedList={!!opts.pinnedList}
    />
  );

  // 「项目」标题行 ＋ 按钮：Tauri 环境弹系统目录选择框；纯浏览器开发环境退回手动输入弹层
  const onSecAdd = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (projAdd) {
      closeProjPopups();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    closeProjPopups();
    if (invoke) {
      invoke("plugin:dialog|open", { options: { directory: true, title: "选择项目文件夹" } })
        .then((p) => {
          if (p) send({ type: "add_project", cwd: p });
        })
        .catch(() => setProjAdd({ rect }));
    } else {
      setProjAdd({ rect });
    }
  };
  // 垃圾桶：进出清理模式；进入时全部项目展开且不限制条数。
  // 退出时恢复进入前的展开/条数状态(之前收起的收回、展开的保持)——快照只记进入时刻
  // 的存量项目,清理模式中新展开的不回滚
  const onSecTrash = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const st = useAppStore.getState();
    const nextManage = !st.isProjectManageMode;
    // 展开态/条数上限容器换新引用,随管理态一并 setBump(等价旧 mutate+末尾 notify)
    const nextExpanded = new Set(st.expandedProjects);
    const nextLimits = new Map(st.projectLimits);
    if (nextManage) {
      manageSnap.current = visible.map((pr) => ({
        cwd: pr.cwd,
        wasExpanded: st.expandedProjects.has(pr.cwd),
        limit: st.projectLimits.get(pr.cwd) ?? null, // 无条目时 get 为 undefined,归一为 null(同原版 has()?get():null)
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
    <aside id="sidebar" data-tauri-drag-region="">
      <div className="pt-[10px] px-[10px] flex flex-col gap-[6px] flex-none">
        <div className="nav-item" id="navNew" onClick={newTaskAction}>
          <Icon name="messagePlus" size={19} />
          新建任务 <span className="ml-auto text-faint text-ui-sm tracking-[0.5px]">{MOD} N</span>
        </div>
        <SidebarSearch />
      </div>
      <div className="flex items-center pt-[10px] px-[14px] pb-[8px] gap-[8px] flex-none">
        <div className="seg" id="seg">
          <button data-view="recent" className={viewMode === "recent" ? "on" : ""} onClick={() => setBump({ viewMode: "recent" })}>最近</button>
          <button data-view="project" className={viewMode === "project" ? "on" : ""} onClick={() => setBump({ viewMode: "project" })}>项目</button>
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
          const sel = window.getSelection(); // 记录右键前选区，供选词撤销对比
          selBeforeCtxRef.current = sel ? sel.toString() : null;
        }}
      >
        {viewMode === "project" ? (
          <>
            <div className="project-pinned">
              <div className="sec-label">置顶</div>
              {pinnedRows.length > 0 ? (
                pinnedRows.map((s) => rowOf(s, { pinnedList: true }, `pinned:${s.path}`))
              ) : (
                <div className="pinned-empty text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">暂无置顶会话</div>
              )}
            </div>
            <div className="sec-label project-heading">
              <span>项目</span>
              <div className="flex items-center gap-[4px]">
                <button className="sec-add" title="添加项目" onClick={onSecAdd}>
                  <Icon name="plus" size={15} />
                </button>
                <button
                  className={"sec-trash" + (manage ? " active" : "")}
                  title={manage ? "退出清理模式" : "清理项目与会话"}
                  onClick={onSecTrash}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
            <div className="project-scroll">
              {(() => {
                let oi = 0; // 其余组（不含拖组）的序位，用于让位位移计算
                return visible.map((p) => {
                  const isSelf = drag && p.cwd === drag.cwd;
                  const i = isSelf ? -1 : oi++;
                  // 拖组占位插入 drag.idx：其后各组下移 selfH；拖组原位置之后的组先上移回填
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
                    />
                  );
                });
              })()}
              {visible.length === 0 && <div className="text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">暂无项目，点击「项目」右侧 ＋ 添加</div>}
              <ArchivedSection onDelete={askDeleteSession} />
            </div>
          </>
        ) : (
          <>
            <div className="sec-label">最近任务</div>
            {flat.map((s) => rowOf(s, { showRepo: true }, `recent:${s.path}`))}
            {flat.length === 0 && <div className="text-faint text-ui-sm pt-[2px] pr-[10px] pb-[4px] pl-[14px]">暂无任务</div>}
            <ArchivedSection onDelete={askDeleteSession} />
          </>
        )}
      </div>
      <div className="side-foot">
        <div className="avatar"><img src={appIcon} alt="" /></div>
        <div className="flex items-center gap-[6px] min-w-0">
          <span className="text-[15px] font-semibold text-text truncate leading-none" id="sideProfileName">{hostSettings?.activeProfile || "omp-desktop"}</span>
        </div>
        <span className="flex-1"></span>
        <button className="icon-btn" id="settingsBtn" title="设置" onClick={() => openSettings()}>
          <Icon name="settings" size={16} />
        </button>
      </div>

      {/* —— 弹层（portal 到 body） —— */}
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
          <button onClick={() => { setProjMenu(null); askRemoveProject(projMenu.cwd); }}>移除</button>
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
