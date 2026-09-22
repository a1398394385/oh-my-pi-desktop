// 项目组（ui/sidebar.js renderList 项目分支平移）：组头（folder 图标/名称/＋/⋯ 或清理模式的
// 「移除」钮）+ 展开会话容器。点击组头折叠/展开（grid 0fr↔1fr 过渡 + 逐行 kids-in 错峰入场），
// 展开态写入宿主 omp-desktop.json；收起状态组头是拖拽排序拖柄（HTML5 DnD，位移由 Sidebar 统一算）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { S, send, notify, showWelcomeScreen, expandedProjects, projectLimits } from "../../store.js";
import Icon from "../../Icon.jsx";
import SessionRow from "./SessionRow.jsx";

// 展开会话容器（原 buildProjKids）：mount 时 0fr→1fr 播展开动画；animate 时逐行 kids-in 错峰。
// 管理模式显示全部会话；默认 5 条，「显示更多」按需每次多加载 5 条。
function ProjKids({ p, animate, closing, ty, dragging, rowProps, renaming }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    el.style.gridTemplateRows = "0fr";
    // 双 rAF：确保 0fr 先落布局，再过渡回 1fr（CSS 过渡）
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.gridTemplateRows = ""; }));
  }, []);
  const limit = S.isProjectManageMode ? Infinity : (projectLimits.get(p.cwd) ?? 5);
  const visibleSessions = p.sessions.slice(0, limit);
  const shift = { transform: ty ? `translateY(${ty}px)` : undefined };
  return (
    <div
      className={"proj-kids" + (closing ? " closing" : "") + (dragging ? " shift-anim" : "")}
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
              renaming={renaming?.path === s.path && renaming.key === rowKey}
              className={animate ? "kids-in" : undefined}
              style={animate ? { animationDelay: `${i * 25}ms` } : undefined}
            />
          );
        })}
        {!S.isProjectManageMode && p.sessions.length > visibleSessions.length && (
          <button
            className={"more-link" + (animate ? " kids-in" : "")}
            onClick={() => {
              projectLimits.set(p.cwd, visibleSessions.length + 5);
              notify();
            }}
          >
            显示更多
          </button>
        )}
        {p.sessions.length === 0 && <div className={"empty-hint" + (animate ? " kids-in" : "")}>暂无任务</div>}
      </div>
    </div>
  );
}

export default function ProjGroup({ p, ty, isDragSelf, dragging, onDragStartHead, onDragEndHead, onOpenProjMenu, onRemoveProject, rowProps, renaming }) {
  const expanded = expandedProjects.has(p.cwd);
  const [showKids, setShowKids] = useState(expanded); // 初挂载直接渲染不播动画（对照原版 renderList 重建）
  const [closing, setClosing] = useState(false);
  const [armed, setArmed] = useState(false); // mousedown 判定后才进入可拖态（行内按钮不起拖）

  // 展开挂载 kids / 收起延迟卸载（0.3s 收拢动画播完再移除）
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
    if (expandedProjects.has(p.cwd)) {
      expandedProjects.delete(p.cwd);
      send({ type: "set_project_expanded", cwd: p.cwd, expanded: false });
    } else {
      expandedProjects.add(p.cwd);
      projectLimits.delete(p.cwd); // 再展开时分页重置回默认 5 条
      send({ type: "set_project_expanded", cwd: p.cwd, expanded: true });
    }
    notify();
  };

  const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
  return (
    <>
      <div
        className={"proj" + (expanded ? "" : " collapsed") + (dragging ? " shift-anim" : "") + (isDragSelf ? " drag-float" : "")}
        data-cwd={p.cwd}
        style={{ transform: ty ? `translateY(${ty}px)` : undefined }}
        draggable={armed}
        onMouseDown={(e) => {
          if (e.button !== 0 || e.target.closest("button")) return; // 行内按钮（＋/⋯/移除）不受影响
          if (expandedProjects.has(p.cwd)) return; // 展开的项目不可拖：先收起再拖
          setArmed(true);
        }}
        onMouseUp={() => setArmed(false)}
        onDragStart={(e) => onDragStartHead(e, p.cwd)}
        onDragEnd={onDragEndHead}
        onClick={toggle}
      >
        <span className="fic"><Icon name={expanded ? "folderOpen" : "folder"} size={14} /></span>
        <span className="pname" title={p.cwd}>{name}</span>
        {S.isProjectManageMode ? (
          <button
            className="proj-rm-btn"
            title={`移除项目 ${p.cwd}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveProject(p.cwd);
            }}
          >
            移除
          </button>
        ) : (
          <>
            <button
              className="padd"
              title={`在 ${p.cwd} 新建会话`}
              onClick={(e) => {
                e.stopPropagation();
                showWelcomeScreen(p.cwd);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              className="pmore"
              title="更多"
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
      {showKids && <ProjKids p={p} animate={expanded && !closing} closing={closing} ty={isDragSelf ? 0 : ty} dragging={dragging && !isDragSelf} rowProps={rowProps} renaming={renaming} />}
    </>
  );
}
