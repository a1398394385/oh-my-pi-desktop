import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pathBase, openSessionByPath, send } from "../../store";
import Icon from "../../Icon";
import WindowControls from "../WindowControls";
import BranchMenu from "../welcome/BranchMenu";
import SessCtxMenu from "./sidebar/SessCtxMenu";
import type { SessionInfo } from "./sidebar/SessionRow";
import { IS_WINDOWS, MOD } from "../../platform";

// Middle-column topbar: sidebar toggle + session title + project/branch chips
// + right panel toggle (the old index.html chat-head structure)
export default function MainHeader({ onToggleSidebar, onToggleRight }: { onToggleSidebar: () => void; onToggleRight: () => void }) {
  const { t } = useTranslation();
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const gitManage = useAppStore((s) => s.gitManage);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const diskProjects = useAppStore((s) => s.diskProjects);
  const archivedSessions = useAppStore((s) => s.archivedSessions);
  const headerGit = useAppStore((s) => s.headerGit);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useAppStore((s) => s.rightCollapsed);
  const narrow = useAppStore((s) => s.narrow);
  const setMobileCol = useAppStore((s) => s.setMobileCol);
  // Collab entry state: the open session's live-sharing role (button tint) + dialog opener
  const collabSessionId = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.sessionId : undefined));
  const collabState = useAppStore((s) => (collabSessionId ? s.collabStates.get(collabSessionId) : undefined));
  const collabOpenDialog = useAppStore((s) => s.collabOpenDialog);
  const isSubagent = Boolean(session?.isSubagent);
  const title = gitManage
    ? t("gitPage.title")
    : isCreatingNew
      ? t("misc.newTask")
      : session
        ? session.title || (diskProjects.flatMap((p) => p.sessions).find((x) => x.path === activePath)?.title) || pathBase(session.cwd)
        : t("misc.pickSession");
  const cwd = session?.cwd;
  // Remote workspace stubs show their host:path label instead of the stub dir basename
  const projectName = gitManage
    ? pathBase(gitManage)
    : cwd
      ? diskProjects.find((p) => p.cwd === cwd)?.remoteLabel ?? pathBase(cwd)
      : null;
  const git = !gitManage && headerGit && headerGit.cwd === cwd ? headerGit : null;
  // null = closed; when open, holds the trigger chip's viewport coords (menu pops upward)
  const [branchMenu, setBranchMenu] = useState<DOMRect | null>(null);
  // "⋯" session menu (same items as the sidebar row right-click): null = closed, otherwise the
  // trigger's viewport coords (menu drops downward)
  const [moreMenu, setMoreMenu] = useState<DOMRect | null>(null);
  // Header inline rename (opened from the ⋯ menu's rename item)
  const [renaming, setRenaming] = useState(false);

  // Context-menu entry for the active session, mirroring the sidebar row data: disk row first
  // (real id / archived / pending flags), archive-list fallback, open-session fallback for
  // pool-only rows (treated as pending → copy-id disabled). Subagent sessions have no sidebar
  // task row, so they get no ⋯ menu.
  const diskRow = activePath
    ? diskProjects.flatMap((p) => p.sessions).find((x) => x.path === activePath) ??
      archivedSessions.find((x) => x.path === activePath)
    : undefined;
  const ctxEntry: SessionInfo | null = activePath && !isCreatingNew && !isSubagent && !gitManage
    ? {
        path: activePath,
        id: diskRow?.id ?? session?.sessionId ?? "",
        title: diskRow?.title ?? session?.title ?? null,
        cwd,
        archived: !!diskRow?.archived,
        pending: diskRow ? !!diskRow.pending : true,
      }
    : null;

  // Branch chip data: fetch on session switch (isGit comes with the session
  // object; a non-git cwd gets the isGit:false reply which hides the chip)
  useEffect(() => {
    if (cwd && session?.isGit) send({ type: "get_git_branches", cwd });
  }, [cwd, session?.isGit]);
  // Global close: click anywhere outside (menu clicks already close themselves)
  useEffect(() => {
    if (!branchMenu && !moreMenu) return;
    const close = () => {
      setBranchMenu(null);
      setMoreMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [branchMenu, moreMenu]);

  return (
    <div className="chat-head" data-tauri-drag-region="">
      {/* Sidebar/right-panel toggles live on their own panel's top corner while
          it is expanded; the center topbar only carries the expand buttons.
          Narrow (ZCode remote model): back to the session list on the left, right
          column opens as a drawer — the desktop collapse toggles do not apply. */}
      {narrow && (
        <button className="icon-btn" title={t("remote.backToList")} onClick={() => setMobileCol("left")}>
          <Icon name="chevronLeft" />
        </button>
      )}
      {!narrow && sidebarCollapsed && (
        <button className="icon-btn" title={t("misc.collapseSidebar", { mod: MOD })} id="sidebarToggle" onClick={onToggleSidebar}>
          <Icon name="collapseRight" />
        </button>
      )}
      {isSubagent && session?.parentPath ? (
        <button
          type="button"
          className="subagent-return-btn mr-2"
          onClick={() => openSessionByPath(session.parentPath!)}
        >
          {t("chat.backToParentSession")}
        </button>
      ) : null}
      <Icon name="folderOld" style={{ color: "var(--faint)" }} />
      {renaming && ctxEntry ? (
        <HeaderTitleRename entry={ctxEntry} onDone={() => setRenaming(false)} />
      ) : (
        <span
          className={"text-ui-md font-semibold truncate min-w-0" + (session?.streaming ? " title-shimmer" : "")}
          id="chatTitle"
        >
          {title}
          {isSubagent && <span className="subagent-head-badge">{t("chat.subagentBadge")}</span>}
        </span>
      )}
      {projectName && !isCreatingNew && !gitManage && (
        <span className="head-chip" title={cwd ?? undefined}><span>{projectName}</span></span>
      )}
      {git?.isGit && git.current && !isCreatingNew && (
        <button
          type="button"
          className={"head-chip clickable" + (branchMenu ? " active" : "")}
          title={t("misc.gitBranchTitle", { branch: git.current })}
          onClick={(e) => {
            e.stopPropagation();
            setMoreMenu(null); // exclusive menus (stopPropagation bypasses the global close)
            if (branchMenu) return setBranchMenu(null);
            // refresh the list at open time (checkout may have happened elsewhere)
            if (cwd) send({ type: "get_git_branches", cwd });
            setBranchMenu(e.currentTarget.getBoundingClientRect());
          }}
        >
          <Icon name="branch" size={13} style={{ color: "var(--dim)" }} />
          <span>{git.current}</span>
          <span className="caret-svg"><Icon name="caret" size={12} /></span>
        </button>
      )}
      {branchMenu && git && (
        <BranchMenu
          anchorRect={branchMenu}
          onClose={() => setBranchMenu(null)}
          branches={git.branches}
          remotes={git.remotes}
          current={git.current ?? ""}
          detached={git.detached}
          cwd={git.cwd}
        />
      )}
      {/* "⋯" trigger right of the branch chip: same menu as right-clicking the session row
          in the sidebar (SessCtxMenu reused verbatim, anchored below the button) */}
      {ctxEntry && !renaming && (
        <button
          type="button"
          className="icon-btn"
          title={t("sidebar.more")}
          onClick={(e) => {
            e.stopPropagation();
            setBranchMenu(null); // exclusive menus (stopPropagation bypasses the global close)
            if (moreMenu) return setMoreMenu(null);
            setMoreMenu(e.currentTarget.getBoundingClientRect());
          }}
        >
          <Icon name="dots" size={15} />
        </button>
      )}
      {moreMenu && ctxEntry && (
        <SessCtxMenu
          entry={ctxEntry}
          x={moreMenu.left}
          y={moreMenu.bottom + 4}
          onClose={() => setMoreMenu(null)}
          onRename={() => setRenaming(true)}
        />
      )}
      {/* Collab entry (host/join/leave live-sharing for the open session); tinted while a room is live */}
      {ctxEntry && !renaming && (
        <button
          type="button"
          className="icon-btn"
          title={t("collab.entry")}
          style={collabState?.role ? { color: "var(--green)" } : undefined}
          onClick={() => collabOpenDialog()}
        >
          <Icon name="globe" size={15} />
        </button>
      )}
      <span className="sp"></span>
      {narrow ? (
        <button className="icon-btn" id="panelToggle" title={t("remote.openPanel")} onClick={() => setMobileCol("right")}>
          <Icon name="panelRight" />
        </button>
      ) : rightCollapsed && (
        <button className="icon-btn" title={t("misc.collapseRightPanel")} id="panelToggle" onClick={onToggleRight}>
          <Icon name="collapseLeft" />
        </button>
      )}
      {/* Windows frameless window control buttons: when the right panel is
          collapsed they merge into the main card's top-right corner (rendered
          on Windows only) */}
      {IS_WINDOWS && rightCollapsed && <WindowControls />}
    </div>
  );
}

// Header inline rename (the ⋯ menu's rename item): same contract as the sidebar RenameEditor —
// Enter saves (empty title/unchanged is a no-op; the title follows the host's list refetch),
// Esc/blur counts as cancel.
function HeaderTitleRename({ entry, onDone }: { entry: SessionInfo; onDone: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current!; // exists right after mount (same assumption as RenameEditor)
    el.focus();
    if (entry.title) el.select();
  }, []);
  let done = false; // the blur following an Enter save is not processed again
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const title = ref.current!.value.trim();
    if (save && title && title !== (entry.title || "")) {
      send({ type: "rename_session", sessionId: entry.id, title });
    }
    onDone();
  };
  return (
    <input
      className="inp head-rename"
      ref={ref}
      defaultValue={entry.title || ""}
      placeholder={t("sidebar.sessionTitlePh")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          finish(false);
        }
      }}
      onBlur={() => finish(false)}
    />
  );
}
