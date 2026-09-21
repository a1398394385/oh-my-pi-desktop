// 左栏：新建任务入口 + 视图切换（最近/项目）+ 会话列表（tasklist）+ 底部账号/设置。
// 迁移自 ui/sidebar.js（800 行）：renderList/taskRow/归档区/项目拖拽排序/右键菜单/
// 确认弹窗/添加项目弹层/⌘N。契约：数据读 S/diskProjects/expandedProjects/pinnedSessions/
// unseenFinished/projectLimits，动作后 notify()；DOM 结构与类名对照 ui/index.html + sidebar.js。
import { useEffect, useRef, useState } from "react";
import {
  S, useStore, notify, send, invoke, showWelcomeScreen, initNewSessionModel, activeOpen,
  diskProjects, expandedProjects, pinnedSessions, projectLimits, openSessions, getAvailableProjects, openSettings,
} from "../store.js";
import Icon from "../Icon.jsx";
import SessionRow from "./sidebar/SessionRow.jsx";
import ProjGroup from "./sidebar/ProjGroup.jsx";
import ArchivedSection from "./sidebar/ArchivedSection.jsx";
import ConfirmDialog from "./sidebar/ConfirmDialog.jsx";
import Menu from "./sidebar/Menu.jsx";
import SessCtxMenu from "./sidebar/SessCtxMenu.jsx";
import ProjAddPop from "./sidebar/ProjAddPop.jsx";

// 点新建（含已在欢迎页时再点）：明确回到配置文件默认——清手选标记 + 强制重校准
function newTaskAction() {
  if (S.isCreatingNew) {
    S.newSessionDirty = false;
    initNewSessionModel(true);
    notify();
  }
  showWelcomeScreen(activeOpen()?.cwd);
}

export default function Sidebar({ collapsed }) {
  useStore();
  // 弹层/局部交互态（原版散在 body append 的临时 DOM 与模块变量上）
  const [confirmDlg, setConfirmDlg] = useState(null); // { title, message, confirmText, danger, onConfirm }
  const [sessCtx, setSessCtx] = useState(null); // { entry, x, y } 会话行右键菜单
  const [projMenu, setProjMenu] = useState(null); // { cwd, rect } 项目行「⋯」菜单
  const [projAdd, setProjAdd] = useState(null); // { rect } 手动添加项目弹层锚点
  const [renaming, setRenaming] = useState(null); // { key, path }：行内重命名态（key 区分置顶/最近/项目组中的同一会话副本）
  const [drag, setDrag] = useState(null); // { cwd, selfH, k0, base:[{cwd,top,h}], idx }
  const listRef = useRef(null);
  const selBeforeCtxRef = useRef(null); // 右键前选区（WebKit 右键选词撤销用）

  const closeProjPopups = () => {
    setProjMenu(null);
    setProjAdd(null);
    setSessCtx(null);
  };

  // ⌘N 新建任务（原 initSidebar 的 document keydown）
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // 设置页打开时 ⌘N 不抢占（旧版 settingsOpen 检查平移）
        if (S.settingsOpen) return;
        newTaskAction();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // —— 删除会话确认（管理模式行内按钮 / 归档区彻底删除共用） ——
  const askDeleteSession = (s) => {
    const sTitle = s.title || s.firstMessage || s.id || "未命名会话";
    setConfirmDlg({
      title: "删除会话",
      message: `确定要永久删除此会话吗？此操作无法撤销。\n\n会话：${sTitle}`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        send({ type: "delete_session", path: s.path });
        if (S.activePath === s.path) {
          openSessions.delete(s.path);
          S.activePath = null;
          showWelcomeScreen(s.cwd || S.newSessionProject);
        }
      },
    });
  };

  // —— 移除项目确认（组头「移除」钮与「⋯」菜单共用） ——
  const askRemoveProject = (cwd) => {
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
  const onSessContext = (e, entry, key) => {
    e.preventDefault();
    e.stopPropagation();
    closeProjPopups();
    setSessCtx({ entry, x: e.clientX, y: e.clientY, key });
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString() !== selBeforeCtxRef.current) sel.removeAllRanges();
    });
  };

  // —— 项目拖拽排序（HTML5 DnD，对照原 beginProjDrag/updateProjDrag/endProjDrag 语义） ——
  // 仅收起组头是拖柄；dragstart 冻结一次基线布局（对照 measureProjGroups，让位平移不影响判定）
  const onDragStartHead = (e, cwd) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cwd); // WebKit 需有数据才启动拖拽
    const base = [...listRef.current.querySelectorAll(":scope > .proj")].map((el) => {
      const r = el.getBoundingClientRect();
      return { cwd: el.dataset.cwd, top: r.top, h: r.height };
    });
    const k0 = base.findIndex((g) => g.cwd === cwd);
    setDrag({ cwd, selfH: base[k0].h, k0, base, idx: k0 });
  };
  // 指针落在某组前半 → 拖组占位插到该组前（原版拖组中点判定的指针等价物，基线固定防抖动）
  const onDragOverList = (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const others = drag.base.filter((g) => g.cwd !== drag.cwd);
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      if (e.clientY < others[i].top + others[i].h / 2) {
        idx = i;
        break;
      }
    }
    if (idx !== drag.idx) setDrag({ ...drag, idx });
  };
  // 提交顺序（原 endProjDrag commit）：其余组按插入位重排，磁盘兜底项目先并入，
  // 顺序持久化到 omp-desktop.json allProjects
  const onDropList = (e) => {
    if (!drag) return;
    e.preventDefault();
    const d = drag;
    setDrag(null);
    const others = d.base.filter((g) => g.cwd !== d.cwd).map((g) => g.cwd);
    const order = [...others];
    order.splice(d.idx, 0, d.cwd);
    for (const c of order) if (!S.allProjects.includes(c)) S.allProjects.unshift(c);
    const arr = [...order, ...S.allProjects.filter((c) => !order.includes(c))];
    const unchanged = arr.length === S.allProjects.length && arr.every((c, i) => c === S.allProjects[i]);
    S.allProjects = arr;
    send({ type: "reorder_projects", order: arr });
    if (!unchanged) notify();
  };
  const onDragEndHead = () => setDrag(null); // 拖到窗外/Esc 取消也收尾

  if (collapsed) return <aside id="sidebar" className="collapsed" data-tauri-drag-region=""></aside>;

  // —— 列表数据 ——
  const manage = S.isProjectManageMode;
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

  const rowProps = {
    onRenameStart: (key, path) => setRenaming({ key, path }),
    onRenameDone: () => setRenaming(null),
    onDelete: askDeleteSession,
    onContext: onSessContext,
  };
  const rowOf = (s, opts = {}, key) => (
    <SessionRow
      key={s.path}
      s={s}
      {...rowProps}
      rowKey={key}
      renaming={renaming?.path === s.path && renaming.key === key}
      sub={!!opts.sub}
      showRepo={!!opts.showRepo}
      pinnedList={!!opts.pinnedList}
    />
  );

  // 「项目」标题行 ＋ 按钮：Tauri 环境弹系统目录选择框；纯浏览器开发环境退回手动输入弹层
  const onSecAdd = (e) => {
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
  // 垃圾桶：进出清理模式；进入时全部项目展开且不限制条数
  const onSecTrash = (e) => {
    e.stopPropagation();
    S.isProjectManageMode = !S.isProjectManageMode;
    if (S.isProjectManageMode) {
      for (const pr of visible) {
        expandedProjects.add(pr.cwd);
        projectLimits.set(pr.cwd, Infinity);
      }
    }
    notify();
  };

  return (
    <aside id="sidebar" data-tauri-drag-region="">
      <div className="nav">
        <div className="nav-item" id="navNew" onClick={newTaskAction}>
          <Icon name="zoomIn" />
          新建任务 <span className="kbd">⌘ N</span>
        </div>
      </div>
      <div className="viewtabs">
        <div className="seg" id="seg">
          <button data-view="recent" className={S.viewMode === "recent" ? "on" : ""} onClick={() => { S.viewMode = "recent"; notify(); }}>最近</button>
          <button data-view="project" className={S.viewMode === "project" ? "on" : ""} onClick={() => { S.viewMode = "project"; notify(); }}>项目</button>
        </div>
      </div>
      <div
        id="tasklist"
        ref={listRef}
        className={drag ? "proj-dragging" : ""}
        onDragOver={onDragOverList}
        onDrop={onDropList}
        onMouseDown={(e) => {
          if (e.button !== 2) return;
          const sel = window.getSelection(); // 记录右键前选区，供选词撤销对比
          selBeforeCtxRef.current = sel ? sel.toString() : null;
        }}
      >
        {S.viewMode === "project" ? (
          <>
            {pinnedRows.length > 0 && (
              <>
                <div className="sec-label">置顶</div>
                {pinnedRows.map((s) => rowOf(s, { pinnedList: true }, `pinned:${s.path}`))}
              </>
            )}
            <div className="sec-label">
              <span>项目</span>
              <div className="sec-actions">
                <button className="sec-add" title="添加项目" onClick={onSecAdd}>
                  <Icon name="plus" size={14} />
                </button>
                <button
                  className={"sec-trash" + (manage ? " active" : "")}
                  title={manage ? "退出清理模式" : "清理项目与会话"}
                  onClick={onSecTrash}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
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
                    onDragStartHead={onDragStartHead}
                    onDragEndHead={onDragEndHead}
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
            {visible.length === 0 && <div className="empty-hint">暂无项目，点击「项目」右侧 ＋ 添加</div>}
          </>
        ) : (
          <>
            <div className="sec-label">最近任务</div>
            {flat.map((s) => rowOf(s, { showRepo: true }, `recent:${s.path}`))}
            {flat.length === 0 && <div className="empty-hint">暂无任务</div>}
          </>
        )}
        {/* 归档区固定在列表底部（两种视图共用） */}
        <ArchivedSection onDelete={askDeleteSession} />
      </div>
      <div className="side-foot">
        <div className="avatar"><img src="app-icon.png" alt="" /></div>
        <div className="sf-tx">
          <span className="uname" id="sideProfileName">omp-desktop</span>
        </div>
        <span className="sp"></span>
        <button className="icon-btn" id="settingsBtn" title="设置" onClick={() => openSettings()}>
          <Icon name="settings" />
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
    </aside>
  );
}
