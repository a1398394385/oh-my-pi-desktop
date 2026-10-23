// Session row (ported from ui/sidebar.js taskRow): pin / running spinner / unread dot /
// title / relative time (swapped for a delete button in manage mode). Single click opens the
// session (same chain as loadBranchSession); double-clicking the title enters inline rename in place.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession } from "../../../store";
import Icon from "../../../Icon";
import { IS_WINDOWS, MOD } from "../../../platform";
import { confirmDialog } from "../../settings/common";
import { fmtAgo, sessionLabel } from "./util";
import { turnEndedWithError } from "../../../store/run-seal";
import { motionEnabled } from "../../../shell";

// Session entry (structural subset of diskProjects[].sessions / archivedSessions elements;
// the full store-side type is defined by the P2F batch — this declares only the fields this
// batch consumes; structural compatibility suffices)
export interface SessionInfo {
  path: string;
  id: string;
  /** True while the session file is not yet on disk (pool fallback row): id is the host pool UUID, not the real disk session id */
  pending?: boolean;
  title?: string | null; // host DiskSessionRow is string | null
  firstMessage?: string;
  modified?: string; // absent for in-memory pool rows (state.ts pushPoolSnapshot): no on-disk activity time
  repo?: string;
  cwd?: string;
  archived?: boolean;
  /** Set when the host spawned this session for an automation (sidebar clock badge) */
  automation?: { id: string; title: string };
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
  /** Its context menu is open: the menu covers the row, so the hover visuals are pinned via .ctx-open */
  ctxOpen?: boolean;
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
      send({ type: "rename_session", path: s.path, title }); // path, not id: the pool key is a runtime UUID
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

// Automation-spawned session: the clock sits at the right, just left of the relative-time label.
function AutoBadge({ s }: { s: SessionInfo }) {
  const { t } = useTranslation();
  if (!s.automation) return null;
  return (
    <span className="task-auto" title={`${t("sidebar.autoSession")}: ${s.automation.title}`}>
      <Icon name="clock" size={13} />
    </span>
  );
}

export default function SessionRow({ s, sub, showRepo, pinnedList, rowKey, renaming, ctxOpen, className, style, shortcutDigit, onRenameStart, onRenameDone, onDelete, onContext }: SessionRowProps) {
  const { t } = useTranslation();
  // State subscribed via selectors (must run before the renaming early return: hooks cannot be conditional)
  // Per-path field selectors (Batch 1, T7): after LRU eviction the getters return
  // undefined/false and the row falls back to its disk/pool state instead of crashing
  const streaming = useAppStore((st) => st.openSessions.get(s.path)?.streaming ?? false);
  const awaitingApproval = useAppStore((st) => (st.openSessions.get(s.path)?.pendingApprovals?.length ?? 0) > 0);
  const hasError = useAppStore((st) => {
    const o = st.openSessions.get(s.path);
    if (!o || o.streaming) return false;
    const last = o.items[o.items.length - 1];
    return turnEndedWithError(o.items) || !!(last as { error?: string | null } | undefined)?.error;
  });
  const pinnedSessions = useAppStore((s2) => s2.pinnedSessions);
  const unseenFinished = useAppStore((s2) => s2.unseenFinished);
  const activePath = useAppStore((s2) => s2.activePath);
  const isProjectManageMode = useAppStore((s2) => s2.isProjectManageMode);
  const isCommandPressed = useAppStore((s2) => s2.isCommandPressed);
  // Pool busy flag (pool_sessions frame): the spinner for a session this client
  // never loaded — running on the OTHER channel (remote control vs desktop) or
  // spawned by an automation — which therefore has no openSessions slot here.
  // O(1) set lookup (N1) instead of scanning the whole pool array per row per notification.
  const poolBusy = useAppStore((st) => st.busyPaths.has(s.path));
  // In the host's live pool: the eject action only makes sense for resident sessions, and
  // the host pool — not openSessions — is the truth (the frontend slot map has an LRU cap,
  // so a row can outlive its slot while still resident in the pool).
  const inHostPool = useAppStore((st) => st.poolPaths.has(s.path));
  // Pool-eviction notice: the store lights this path up for 1s on session_unload (below the
  // row swaps it in over the title instead of raising a bottom toast)
  const unloaded = useAppStore((st) => st.unloadedPaths.has(s.path));
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  // Title-slot carousel: the eviction notice and the title swap both ways through the same
  // slide (in from the right, where the eject button sits), so the outgoing line is kept one
  // beat while the two cross. Only an `unloaded` flip animates — plain title updates don't.
  const rowText = unloaded ? t("sidebar.unloadedNotice") : sessionLabel(s) + (showRepo ? `  ·  ${s.repo}` : "");
  // Adjust-state-during-render (React's own pattern): the flip and its `sliding` class must
  // land in ONE paint. Driving this from an effect showed the final text for a frame before
  // the slide started — that read as an instant swap.
  const [swap, setSwap] = useState({ unloaded, text: rowText, prev: null as string | null });
  if (swap.unloaded !== unloaded || swap.text !== rowText) {
    // motionEnabled(): the Appearance motion switch (system / on / off). With motion reduced the
    // global kill rule in global/animations.css flattens the slide, so keeping the outgoing line
    // would leave both texts stacked for a beat — drop it and swap the text outright.
    setSwap({ unloaded, text: rowText, prev: unloaded !== swap.unloaded && motionEnabled() ? swap.text : swap.prev });
  }
  useEffect(() => {
    if (swap.prev === null) return;
    const id = setTimeout(() => setSwap((s) => ({ ...s, prev: null })), 320); // slightly past the 300ms slide
    return () => clearTimeout(id);
  }, [swap.prev]);

  if (renaming) return <RenameEditor s={s} sub={sub} onDone={onRenameDone} />;
  const pinned = pinnedSessions.has(s.path);
  // Like ZCode's TaskListItem, keep a single 16px leading slot with a fixed priority:
  // error > unread > approval > running. The error state (selector above) comes from the
  // session's last error row; unopened sessions have no runtime state and only show the
  // persisted unread dot. A session blocked on an ask/approval dialog is waiting on the
  // user, not working: the spinner would read as "still busy" while nothing moves until
  // the question is answered, so it shows the attention dot instead.
  // Loaded here → the subscribed streaming flag (driven by this client's own event frames);
  // otherwise the host pool's busy flag (cross-channel running state)
  const running = streaming || poolBusy;
  const leading = hasError ? "error" : unseenFinished.has(s.path) ? "unread" : awaitingApproval ? "approval" : running ? "loading" : "none";
  // Open session: already open → activate directly (refreshes the right panel's git diff); not
  // open → the host loading chain
  const openSession = () => {
    hideWelcomeScreen();
    // Narrow (ZCode remote model): picking a session leaves the list for the chat page
    useAppStore.getState().setMobileCol("main");
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
    // selectedFile/selectedSubagent cleanup is owned by restoreRightSlot (already-open branch)
    // and the session_created frame (host-load branch) — resetting here would clobber the
    // just-restored per-session right panel state
  };

  // A running session can neither be archived (the host evicts archived sessions from
  // the pool) nor ejected (the host refuses a live teardown), so both actions stay
  // disabled until the run settles — `running` mirrors the host-side busy gate.
  const poolLocked = running;

  const handleStartConfirmArchive = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (poolLocked) return;
    // Archiving completes the automations that deliver into this session (the host
    // settles them), so a plan change gets a dialog the user can read, not the inline
    // two-step confirm that cannot carry an explanation.
    const bound = useAppStore.getState().automations.filter((a) => a.deliverTo?.sessionPath === s.path).length;
    if (bound > 0) {
      void confirmDialog({
        title: t("sidebar.archiveSession"),
        message: `${t("sidebar.confirmArchive")}\n\n${t("sidebar.archiveAutomationMsg", { n: bound })}`,
        confirmText: t("sidebar.confirm"),
      }).then((yes) => {
        if (yes) send({ type: "archive_session", path: s.path, archived: true });
      });
      return;
    }
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
    if (poolLocked) return; // started running between confirm-open and confirm-click
    send({ type: "archive_session", path: s.path, archived: true });
  };

  const handleMouseLeave = () => {
    if (confirmingArchive) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmingArchive(false);
    }
  };

  // A row is a div, not a button: the row hosts its own action buttons (pin, unload,
  // archive), and <button> inside <button> is invalid HTML — React logs a nesting error
  // and WebKit's tap targeting gets unreliable inside the illegal subtree.
  return (
    <div
      role="button"
      tabIndex={0}
      className={"task" + (sub ? " sub" : "") + (s.path === activePath ? " on" : "") + (ctxOpen ? " ctx-open" : "") + (className ? " " + className : "")}
      data-path={s.path}
      style={style}
      onClick={openSession}
      onKeyDown={(e) => {
        // role=button no longer gets Enter/Space for free from the browser
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openSession();
      }}
      onContextMenu={(e) => onContext(e, s, rowKey)}
      onMouseLeave={handleMouseLeave}
    >
      <span className="relative flex-none w-[16px] h-[16px] inline-flex items-center justify-center">
        <span className={"task-indicator " + leading} title={leading === "loading" ? t("sidebar.running") : leading === "unread" ? t("sidebar.hasNewResults") : leading === "approval" ? t("sidebar.awaitingApproval") : leading === "error" ? t("sidebar.lastRunFailed") : undefined}>
          {leading === "error" ? <span className="w-[6px] h-[6px] rounded-full bg-err" /> : null}
          {leading === "unread" || leading === "approval" ? <span className="w-[6px] h-[6px] rounded-full bg-blue" /> : null}
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
        {swap.prev !== null && <span className="tt-prev">{swap.prev}</span>}
        <span className={"tt-next" + (swap.prev !== null ? " sliding" : "")}>{swap.text}</span>
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
          <AutoBadge s={s} />
          {s.modified && <span className="tm">{fmtAgo(s.modified)}</span>}
          <button
            className="arch-act"
            title={t("sidebar.unarchiveRestore")}
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "archive_session", path: s.path, archived: false });
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
          disabled={poolLocked}
          onClick={handleConfirmArchive}
        >
          {t("sidebar.confirm")}
        </button>
      ) : (
        <>
          {inHostPool && (
            <button
              className="tarchive"
              title={t("sidebar.unloadFromPool")}
              disabled={poolLocked}
              onClick={(e) => {
                e.stopPropagation();
                send({ type: "session_unload", path: s.path });
              }}
            >
              <Icon name="eject" size={14} />
            </button>
          )}
          <button
            className="tarchive"
            title={t("sidebar.archiveSession")}
            disabled={poolLocked}
            onClick={handleStartConfirmArchive}
          >
            <Icon name="archive" size={14} />
          </button>
          <AutoBadge s={s} />
          {s.modified && <span className="tm">{fmtAgo(s.modified)}</span>}
        </>
      )}
    </div>
  );
}
