// Session row context menu (ported from the contextmenu branch of ui/sidebar.js initSidebar):
// copy sessionId/file path/cwd + open cwd in the file manager + pin/unpin + rename + archive
// + mark as unread. The old version's capture-phase
// interception to coordinate with the shell menu doesn't exist in the React version (the menu
// is a component); word-selection undo logic stays in the Sidebar container layer.
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Menu from "./Menu";
import { copyText } from "./util";
import type { SessionInfo } from "./SessionRow";

export default function SessCtxMenu({ entry, x, y, onClose, onRename, onRemoveWorktree }: {
  entry: SessionInfo;
  x: number;
  y: number;
  onClose: () => void;
  onRename: (entry: SessionInfo) => void;
  onRemoveWorktree?: (entry: SessionInfo) => void;
}) {
  const { t } = useTranslation();
  // Only omp-managed worktrees (desktop-<slug>-<hash7> under the worktree root)
  // get the remove entry; the host's status RPC re-validates authoritatively.
  const isWorktreeCwd = !!entry.cwd?.includes("/.omp/wt/");
  // Mirrors SessionRow's gate: a running session cannot be archived, since the host
  // evicts archived sessions from the in-memory pool. Unarchiving stays available.
  const streaming = useAppStore((st) => st.openSessions.get(entry.path)?.streaming ?? false);
  const running = streaming || useAppStore((st) => st.busyPaths.has(entry.path));
  const pinned = useAppStore((st) => st.pinnedSessions.has(entry.path));
  // Already-unread sessions hide the entry (marking again would be a no-op); the dot is
  // per-device (local set) and survives reloads via localStorage.
  const unread = useAppStore((st) => st.unseenFinished.has(entry.path));
  // Working directory of the task: the source for "copy path" and "open in file manager".
  // Sidebar rows carry no cwd of their own — fall back to the project the row sits in;
  // archived rows belong to no listed project, so both entries hide for them.
  const projectCwd = useAppStore((st) => st.diskProjects.find((p) => p.sessions.some((s) => s.path === entry.path))?.cwd);
  const cwd = entry.cwd ?? projectCwd;
  const item = (label: string, fn: () => void, disabled = false) => (
    <button key={label} disabled={disabled} onClick={() => { onClose(); fn(); }}>{label}</button>
  );
  const togglePin = () => {
    const st = useAppStore.getState();
    const on = !st.pinnedSessions.has(entry.path);
    const nextPinned = new Set(st.pinnedSessions);
    if (on) nextPinned.add(entry.path);
    else nextPinned.delete(entry.path);
    send({ type: "set_session_pinned", path: entry.path, pinned: on });
    useAppStore.setState({ pinnedSessions: nextPinned });
  };
  return (
    <Menu
      place={(mr) => [
        Math.max(8, Math.min(x, window.innerWidth - mr.width - 8)),
        Math.max(8, Math.min(y, window.innerHeight - mr.height - 8)),
      ]}
      onClose={onClose}
    >
      {item(t("sidebar.rename"), () => onRename(entry))}
      {/* Manual unread mark: the same local set the turn_end handler writes to — the dot clears
          again when the session is opened (store/session.ts drops the path on activate). */}
      {!unread && item(t("sidebar.markUnread"), () => {
        useAppStore.setState((st) => ({ unseenFinished: new Set(st.unseenFinished).add(entry.path) }));
        useAppStore.getState().saveUnseen();
      })}
      {/* Archived sessions can't be pinned (the host unpins on archive); same gate as SessionRow's pin button. */}
      {!entry.archived && item(pinned ? t("sidebar.unpin") : t("sidebar.pinSession"), togglePin)}
      {item(entry.archived ? t("sidebar.unarchive") : t("sidebar.archiveSession"), () => send({ type: "archive_session", path: entry.path, archived: !entry.archived }), running && !entry.archived)}
      {isWorktreeCwd && onRemoveWorktree && item(t("worktree.remove.title"), () => onRemoveWorktree(entry))}
      <div className="sep" />
      {item(t("sidebar.copySessionId"), () => {
        copyText(entry.id ?? "").then(
          () => toast(t("sidebar.copySessionIdDone")),
          () => toast(t("sidebar.copyFailed")),
        );
      }, entry.pending)}
      {item(t("sidebar.copySessionPath"), () => {
        copyText(entry.path).then(
          () => toast(t("sidebar.copySessionPathDone")),
          () => toast(t("sidebar.copyFailed")),
        );
      })}
      {cwd && item(t("sidebar.copyCwdPath"), () => {
        copyText(cwd).then(
          () => toast(t("sidebar.copyCwdPathDone")),
          () => toast(t("sidebar.copyFailed")),
        );
      })}
      {cwd && item(t("sidebar.openInFileManager"), () => send({ type: "open_folder", path: cwd }))}
    </Menu>
  );
}
