// Session row (ported from ui/sidebar.js taskRow): pin / running spinner / unread dot /
// title / relative time (swapped for a delete button in manage mode). Single click opens the
// session (same chain as loadBranchSession); double-clicking the title enters inline rename in place.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession } from "../../../store";
import Icon from "../../../Icon";
import { IS_WINDOWS, MOD } from "../../../platform";
import { fmtAgo, sessionLabel } from "./util";

// Session entry (structural subset of diskProjects[].sessions / archivedSessions elements;
// the full store-side type is defined by the P2F batch — this declares only the fields this
// batch consumes; structural compatibility suffices)
export interface SessionInfo {
  path: string;
  id: string;
  title?: string | null; // host DiskSessionRow is string | null
  firstMessage?: string;
  modified: string;
  repo?: string;
  cwd?: string;
  archived?: boolean;
}

// Inline rename state (key distinguishes copies of the same session in pinned/recent/project groups)
export interface RenamingState {
  key: string;
  path: string;
}

// Row interaction callback set (assembled by Sidebar and distributed to each session row)
export interface SessionRowCallbacks {
  onRenameStart: (key: string, path: string) => void;
  onRenameDone: () => void;
  onDelete: (s: SessionInfo) => void;
  onContext: (e: ReactMouseEvent, s: SessionInfo, key: string) => void;
}

// Full session row props (rowKey required: distinguishes copies of the same session across pinned/recent/project groups)
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

// Inline rename editor row (old startRename): Enter saves (empty title/unchanged doesn't),
// Esc/blur counts as cancel.
// Saving only sends rename_session; the title follows the host's list refetch — diskProjects
// is not modified locally.
function RenameEditor({ s, sub, onDone }: { s: SessionInfo; sub?: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current!; // exists right after mount (the old JS dereferenced directly; same assumption kept)
    el.focus();
    if (s.title) el.select();
  }, []);
  let done = false; // the blur following an Enter save is not processed again
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const title = ref.current!.value.trim();
    if (save && title && title !== (s.title || "")) {
      send({ type: "rename_session", sessionId: s.id, title });
    }
    onDone(); // restore the original row: cancel/unchanged just re-displays; the save path updates the title via the host's list refetch
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
  // State subscribed via selectors (must run before the renaming early return: hooks cannot be conditional)
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
  // Like ZCode's TaskListItem, keep a single 16px leading slot with a fixed priority:
  // error > unread > running.
  // The error state comes from the session's last error row; unopened sessions have no runtime
  // state and only show the persisted unread dot.
  const lastItem = open?.items?.[open.items.length - 1];
  const hasError = !open?.streaming && (lastItem?.role === "error" || (lastItem as { error?: string | null } | undefined)?.error); // the error field is declared only on BashItem; other items read as undefined, same as the original
  const leading = hasError ? "error" : unseenFinished.has(s.path) ? "unread" : open?.streaming ? "loading" : "none";
  // Open session: already open → activate directly (refreshes the right panel's git diff); not
  // open → the host loading chain
  const openSession = () => {
    hideWelcomeScreen();
    // Clear the unread mark: container swapped to a fresh reference (silent write; re-render handled uniformly by the trailing setBump's _v bump)
    useAppStore.setState((st) => ({
      unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== s.path)),
    }));
    saveUnseen();
    if (useAppStore.getState().openSessions.has(s.path)) {
      activateSession(s.path);
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" }); // local config may have changed; fetch the latest model settings
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
        {/* Same as ZCode: on hover Pin takes over the same leading slot; always shown in the
            pinned list or when pinned with no state. Archived sessions can't be pinned. */}
        {!s.archived && (
          <button
            className={"tpin" + ((pinned || pinnedList) && leading === "none" ? " on" : "")}
            title={pinned ? t("sidebar.unpin") : t("sidebar.pinSession")}
            onClick={(e) => {
              e.stopPropagation();
              const st = useAppStore.getState();
              const on = !st.pinnedSessions.has(s.path);
              const nextPinned = new Set(st.pinnedSessions); // container to fresh reference + _v bump (equivalent of old mutate+notify)
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
      {/* Double-click the title to rename in place (the click before the double-click still opens the session; idempotent, no conflict) */}
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
