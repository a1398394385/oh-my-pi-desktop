// 项目组（ui/sidebar.js renderList 项目分支平移）：组头（folder 图标/名称/＋/⋯ 或清理模式的
// 「移除」钮）+ 展开会话容器。点击组头折叠/展开（grid 0fr↔1fr 过渡 + 逐行 kids-in 错峰入场），
// 展开态写入宿主 omp-desktop.json；组头通过 Pointer Events 参与拖拽排序，位移由 Sidebar 统一算。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useAppStore, send, showWelcomeScreen } from "../../store";
import Icon from "../../Icon";
import SessionRow from "./SessionRow";
import type { RenamingState, SessionInfo, SessionRowCallbacks } from "./SessionRow";

// 项目图标判定的最小输入（remote/home 字段宿主尚未产出，兼容保留为 unknown 布尔源）
export interface ProjectIconSource {
  cwd?: string;
  remote?: unknown;
  remoteWorkspace?: unknown;
  workspaceIdentity?: unknown;
  isHome?: unknown;
  home?: unknown;
}

// 项目条目（getAvailableProjects/diskProjects 元素的结构子集；
// store 侧完整类型由 P2F 批定义，此处只声明本批消费字段，结构兼容即可）
export interface ProjectInfo extends ProjectIconSource {
  cwd: string;
  name?: string;
  sessions: SessionInfo[];
}

// 项目图标与 ZCode WorkspaceSidebarItem 保持同一套状态语义：远端用云、本地首页用房屋，
// 普通项目按展开态切换文件夹。当前宿主的项目数据没有单独的 remote/home 字段，兼容未来字段
// 的同时保留 ssh/http 路径与 ~ 目录的判定。
export function projectIconName(p: ProjectIconSource, expanded: boolean): string {
  const cwd = p.cwd || "";
  const remote = Boolean(p.remote || p.remoteWorkspace || p.workspaceIdentity) || /^(ssh|https?):\/\//i.test(cwd);
  const home = Boolean(p.isHome || p.home) || cwd === "~";
  if (remote) return "cloud";
  if (home) return "house";
  return expanded ? "folderOpen" : "folder";
}

// 展开会话容器（原 buildProjKids）：mount 时 0fr→1fr 播展开动画；animate 时逐行 kids-in 错峰。
// 管理模式显示全部会话；默认 5 条，「显示更多」按需每次多加载 5 条。
function ProjKids({ p, animate, closing, ty, dragging, isDragSelf, rowProps, renaming }: {
  p: ProjectInfo;
  animate: boolean;
  closing: boolean;
  ty: number;
  dragging: boolean;
  isDragSelf: boolean;
  rowProps: SessionRowCallbacks;
  renaming: RenamingState | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const projectLimits = useAppStore((s) => s.projectLimits);
  useLayoutEffect(() => {
    const el = ref.current!; // mount 后即存在（原 JS 直接解引用，保持同一假设）
    el.style.gridTemplateRows = "0fr";
    // 双 rAF：确保 0fr 先落布局，再过渡回 1fr（CSS 过渡）
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
              className={animate ? "kids-in" : undefined}
              style={animate ? { animationDelay: `${i * 25}ms` } : undefined}
            />
          );
        })}
        {!isProjectManageMode && p.sessions.length > visibleSessions.length && (
          <button
            className={"more-link" + (animate ? " kids-in" : "")}
            onClick={() => {
              // 条数放宽：容器换新引用 + _v bump（等价旧 mutate+notify）
              useAppStore.setState((st) => ({
                projectLimits: new Map(st.projectLimits).set(p.cwd, visibleSessions.length + 5),
              }));
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

export default function ProjGroup({ p, ty, isDragSelf, dragging, onPointerDownHead, onPointerMoveHead, onPointerUpHead, onPointerCancelHead, shouldSuppressProjectClick, onOpenProjMenu, onRemoveProject, rowProps, renaming }: {
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
}) {
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const expanded = expandedProjects.has(p.cwd);
  const [showKids, setShowKids] = useState(expanded); // 初挂载直接渲染不播动画（对照原版 renderList 重建）
  const [closing, setClosing] = useState(false);

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
    const st = useAppStore.getState();
    const wasExpanded = st.expandedProjects.has(p.cwd);
    const nextExpanded = new Set(st.expandedProjects); // 容器换新引用 + _v bump（等价旧 mutate+notify）
    const nextLimits = wasExpanded ? st.projectLimits : new Map(st.projectLimits);
    if (wasExpanded) nextExpanded.delete(p.cwd);
    else {
      nextExpanded.add(p.cwd);
      nextLimits.delete(p.cwd); // 再展开时分页重置回默认 5 条
    }
    send({ type: "set_project_expanded", cwd: p.cwd, expanded: !wasExpanded });
    useAppStore.setState({ expandedProjects: nextExpanded, projectLimits: nextLimits });
  };

  const name = p.name || p.cwd.split("/").filter(Boolean).pop() || p.cwd;
  return (
    <>
      <div
        className={"proj" + (expanded ? "" : " collapsed") + (dragging && !isDragSelf ? " shift-anim" : "") + (isDragSelf ? " drag-float" : "")}
        data-cwd={p.cwd}
        style={{ transform: ty ? `translateY(${ty}px)` : undefined }}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest("button")) return; // 行内按钮（＋/⋯/移除）不受影响；e.target 运行时必为 Element
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
        <span className="fic"><Icon name={projectIconName(p, expanded)} size={16} /></span>
        <span className="pname" title={p.cwd}>{name}</span>
        {isProjectManageMode ? (
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
      {showKids && <ProjKids p={p} animate={expanded && !closing} closing={closing} ty={isDragSelf ? 0 : ty} dragging={dragging} isDragSelf={isDragSelf} rowProps={rowProps} renaming={renaming} />}
    </>
  );
}
