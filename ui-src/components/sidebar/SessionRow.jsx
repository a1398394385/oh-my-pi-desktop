// 会话行（ui/sidebar.js taskRow 平移）：置顶图钉 / 运行中 spinner / 未读圆点 / 标题 /
// 相对时间（清理模式下换删除钮）。单击打开会话（loadBranchSession 同款链路），
// 双击标题原地进入行内重命名。
import { useEffect, useRef } from "react";
import { S, send, notify, openSessions, unseenFinished, pinnedSessions, saveUnseen, hideWelcomeScreen, refreshGitDiff } from "../../store.js";
import Icon from "../../Icon.jsx";
import { fmtAgo, sessionLabel } from "./util.js";

// 行内重命名编辑行（原 startRename）：Enter 保存（空标题/未改名不保存）、Esc/失焦按取消处理。
// 保存只发 rename_session，标题以宿主重拉列表为准，本地不改 diskProjects。
function RenameEditor({ s, sub, onDone }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    el.focus();
    if (s.title) el.select();
  }, []);
  let done = false; // Enter 保存后随后的 blur 不再重复处理
  const finish = (save) => {
    if (done) return;
    done = true;
    const title = ref.current.value.trim();
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
        placeholder="会话标题"
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

export default function SessionRow({ s, sub, showRepo, pinnedList, rowKey, renaming, className, style, onRenameStart, onRenameDone, onDelete, onContext }) {
  if (renaming) return <RenameEditor s={s} sub={sub} onDone={onRenameDone} />;
  const open = openSessions.get(s.path);
  const pinned = pinnedSessions.has(s.path);
  // 打开会话：已打开直接激活（刷新右栏 git diff）；未打开走宿主加载链路
  const openSession = () => {
    hideWelcomeScreen();
    unseenFinished.delete(s.path);
    saveUnseen();
    if (openSessions.has(s.path)) {
      S.activePath = s.path;
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
      send({ type: "load_session", path: s.path });
    }
    S.selectedSubagent = null;
    S.selectedFile = null;
    notify();
  };
  return (
    <button
      className={"task" + (sub ? " sub" : "") + (s.path === S.activePath ? " on" : "") + (className ? " " + className : "")}
      data-path={s.path}
      style={style}
      onClick={openSession}
      onContextMenu={(e) => onContext(e, s, rowKey)}
    >
      {/* 置顶图钉：悬停浮现（置顶列表中常显），点击切换置顶，持久化到 omp-desktop.json */}
      <button
        className={"tpin" + (pinned || pinnedList ? " on" : "")}
        title={pinned ? "取消置顶" : "置顶会话"}
        onClick={(e) => {
          e.stopPropagation();
          const on = !pinnedSessions.has(s.path);
          if (on) pinnedSessions.add(s.path);
          else pinnedSessions.delete(s.path);
          send({ type: "set_session_pinned", path: s.path, pinned: on });
          notify();
        }}
      >
        <Icon name="pin" size={14} />
      </button>
      {open?.streaming ? (
        <span className="mini-spin" title="运行中"><Icon name="loader" size={14} /></span>
      ) : unseenFinished.has(s.path) ? (
        <span className="seen-dot" title="有新结果"></span>
      ) : null}
      {/* 双击标题原地进入重命名（双击前的 click 仍正常打开会话，幂等无冲突） */}
      <span className="tt" onDoubleClick={() => onRenameStart(rowKey, s.path)}>
        {sessionLabel(s) + (showRepo ? `  ·  ${s.repo}` : "")}
      </span>
      {S.isProjectManageMode ? (
        <button
          className="task-del-btn"
          title="删除会话"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(s);
          }}
        >
          删除
        </button>
      ) : (
        <span className="tm">{fmtAgo(s.modified)}</span>
      )}
    </button>
  );
}
