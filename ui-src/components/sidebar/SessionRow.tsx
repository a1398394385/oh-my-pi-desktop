// 会话行（ui/sidebar.js taskRow 平移）：置顶图钉 / 运行中 spinner / 未读圆点 / 标题 /
// 相对时间（清理模式下换删除钮）。单击打开会话（loadBranchSession 同款链路），
// 双击标题原地进入行内重命名。
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession } from "../../store";
import Icon from "../../Icon";
import { IS_WINDOWS, MOD } from "../../platform";
import { fmtAgo, sessionLabel } from "./util";

// 会话条目（diskProjects[].sessions / archivedSessions 元素的结构子集；
// store 侧完整类型由 P2F 批定义，此处只声明本批消费字段，结构兼容即可）
export interface SessionInfo {
  path: string;
  id: string;
  title?: string | null; // 宿主 DiskSessionRow 为 string | null
  firstMessage?: string;
  modified: string;
  repo?: string;
  cwd?: string;
  archived?: boolean;
}

// 行内重命名态（key 区分置顶/最近/项目组中的同一会话副本）
export interface RenamingState {
  key: string;
  path: string;
}

// 行交互回调集（Sidebar 组装后分发给各会话行）
export interface SessionRowCallbacks {
  onRenameStart: (key: string, path: string) => void;
  onRenameDone: () => void;
  onDelete: (s: SessionInfo) => void;
  onContext: (e: ReactMouseEvent, s: SessionInfo, key: string) => void;
}

// 会话行完整 props（rowKey 必传：区分同一会话在置顶/最近/项目组中的副本）
export interface SessionRowProps extends SessionRowCallbacks {
  s: SessionInfo;
  sub?: boolean;
  showRepo?: boolean;
  pinnedList?: boolean;
  rowKey: string;
  renaming?: boolean;
  className?: string;
  style?: CSSProperties;
  shortcutDigit?: string;
}

// 行内重命名编辑行（原 startRename）：Enter 保存（空标题/未改名不保存）、Esc/失焦按取消处理。
// 保存只发 rename_session，标题以宿主重拉列表为准，本地不改 diskProjects。
function RenameEditor({ s, sub, onDone }: { s: SessionInfo; sub?: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current!; // mount 后即存在（原 JS 直接解引用，保持同一假设）
    el.focus();
    if (s.title) el.select();
  }, []);
  let done = false; // Enter 保存后随后的 blur 不再重复处理
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const title = ref.current!.value.trim();
    if (save && title && title !== (s.title || "")) {
      send({ type: "rename_session", sessionId: s.id, title });
    }
    onDone(); // 恢复原行：取消/未改名直接回显；保存路径由宿主重拉列表更新标题
  };
  return (
    <div className={"task" + (sub ? " sub" : "") + " renaming"}>
      <input
        className="inp rename-inp"
        ref={ref}
        defaultValue={s.title || ""}
        placeholder={t("sidebar.sessionTitlePh")}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(false)}
      />
    </div>
  );
}

export default function SessionRow({ s, sub, showRepo, pinnedList, rowKey, renaming, className, style, shortcutDigit, onRenameStart, onRenameDone, onDelete, onContext }: SessionRowProps) {
  const { t } = useTranslation();
  // 状态经 selector 订阅（须在 renaming 早退之前：hooks 不可条件调用）
  const openSessions = useAppStore((s) => s.openSessions);
  const pinnedSessions = useAppStore((s) => s.pinnedSessions);
  const unseenFinished = useAppStore((s) => s.unseenFinished);
  const activePath = useAppStore((s) => s.activePath);
  const isProjectManageMode = useAppStore((s) => s.isProjectManageMode);
  const isCommandPressed = useAppStore((s) => s.isCommandPressed);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  if (renaming) return <RenameEditor s={s} sub={sub} onDone={onRenameDone} />;
  const open = openSessions.get(s.path);
  const pinned = pinnedSessions.has(s.path);
  // 与 ZCode TaskListItem 一样只保留一个前置 16px 槽，优先级固定为：错误 > 未读 > 运行中。
  // 错误状态来自当前会话最后一条 error 行；未打开会话没有运行时状态，只显示持久化的未读点。
  const lastItem = open?.items?.[open.items.length - 1];
  const hasError = !open?.streaming && (lastItem?.role === "error" || (lastItem as { error?: string | null } | undefined)?.error); // error 字段仅 BashItem 声明;其余条目读取为 undefined,同原版
  const leading = hasError ? "error" : unseenFinished.has(s.path) ? "unread" : open?.streaming ? "loading" : "none";
  // 打开会话：已打开直接激活（刷新右栏 git diff）；未打开走宿主加载链路
  const openSession = () => {
    hideWelcomeScreen();
    // 未读标记清除：容器换新引用（静默写，重渲染由末尾 setBump 的 _v bump 统一负责）
    useAppStore.setState((st) => ({
      unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== s.path)),
    }));
    saveUnseen();
    if (useAppStore.getState().openSessions.has(s.path)) {
      activateSession(s.path);
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
      send({ type: "load_session", path: s.path });
    }
    // selectedFile/selectedSubagent cleanup is owned by restoreRightPanel (already-open branch)
    // and the session_created frame (host-load branch) — resetting here would clobber the
    // just-restored per-session right panel state
  };

  const handleStartConfirmArchive = (e: ReactMouseEvent) => {
    e.stopPropagation();
    setConfirmingArchive(true);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingArchive(false);
    }, 3500);
  };

  const handleConfirmArchive = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmingArchive(false);
    send({ type: "archive_session", sessionId: s.id, archived: true });
  };

  const handleMouseLeave = () => {
    if (confirmingArchive) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmingArchive(false);
    }
  };

  return (
    <button
      className={"task" + (sub ? " sub" : "") + (s.path === activePath ? " on" : "") + (className ? " " + className : "")}
      data-path={s.path}
      style={style}
      onClick={openSession}
      onContextMenu={(e) => onContext(e, s, rowKey)}
      onMouseLeave={handleMouseLeave}
    >
      <span className="relative flex-none w-[16px] h-[16px] inline-flex items-center justify-center">
        <span className={"task-indicator " + leading} title={leading === "loading" ? t("sidebar.running") : leading === "unread" ? t("sidebar.hasNewResults") : leading === "error" ? t("sidebar.lastRunFailed") : undefined}>
          {leading === "error" ? <span className="w-[6px] h-[6px] rounded-full bg-err" /> : null}
          {leading === "unread" ? <span className="w-[6px] h-[6px] rounded-full bg-blue" /> : null}
          {leading === "loading" ? <Icon name="loader" size={16} /> : null}
        </span>
        {/* 与 ZCode 相同：悬停时 Pin 接管同一个前置槽；置顶列表/已置顶且无状态时常显。归档会话不支持置顶。 */}
        {!s.archived && (
          <button
            className={"tpin" + ((pinned || pinnedList) && leading === "none" ? " on" : "")}
            title={pinned ? t("sidebar.unpin") : t("sidebar.pinSession")}
            onClick={(e) => {
              e.stopPropagation();
              const st = useAppStore.getState();
              const on = !st.pinnedSessions.has(s.path);
              const nextPinned = new Set(st.pinnedSessions); // 容器换新引用 + _v bump（等价旧 mutate+notify）
              if (on) nextPinned.add(s.path);
              else nextPinned.delete(s.path);
              send({ type: "set_session_pinned", path: s.path, pinned: on });
              useAppStore.setState({ pinnedSessions: nextPinned });
            }}
          >
            <Icon name="pin" size={18} />
          </button>
        )}
      </span>
      {/* 双击标题原地进入重命名（双击前的 click 仍正常打开会话，幂等无冲突） */}
      <span className="tt" onDoubleClick={() => onRenameStart(rowKey, s.path)}>
        {sessionLabel(s) + (showRepo ? `  ·  ${s.repo}` : "")}
      </span>
      {isProjectManageMode ? (
        <button
          className="task-del-btn"
          title={t("sidebar.deleteSessionTitle")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(s);
          }}
        >
          {t("common.delete")}
        </button>
      ) : isCommandPressed && shortcutDigit ? (
        <span className="task-cmd-badge" title={`${MOD} ${shortcutDigit}`}>
          {IS_WINDOWS ? (
            <span className="task-cmd-mod">Ctrl</span>
          ) : (
            <Icon name="command" size={11} />
          )}
          <span className="task-cmd-digit">{shortcutDigit}</span>
        </span>
      ) : s.archived ? (
        <>
          <span className="tm">{fmtAgo(s.modified)}</span>
          <button
            className="arch-act"
            title={t("sidebar.unarchiveRestore")}
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "archive_session", sessionId: s.id, archived: false });
            }}
          >
            {t("sidebar.restore")}
          </button>
          <button
            className="arch-act arch-del"
            title={t("sidebar.deleteForever")}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s);
            }}
          >
            {t("common.delete")}
          </button>
        </>
      ) : confirmingArchive ? (
        <button
          className="tarchive-confirm"
          title={t("sidebar.confirmArchive")}
          onClick={handleConfirmArchive}
        >
          {t("sidebar.confirm")}
        </button>
      ) : (
        <>
          <button
            className="tarchive"
            title={t("sidebar.archiveSession")}
            onClick={handleStartConfirmArchive}
          >
            <Icon name="archive" size={14} />
          </button>
          <span className="tm">{fmtAgo(s.modified)}</span>
        </>
      )}
    </button>
  );
}
