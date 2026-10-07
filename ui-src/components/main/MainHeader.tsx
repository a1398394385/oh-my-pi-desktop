import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pathBase, openSessionByPath, send } from "../../store";
import Icon from "../../Icon";
import WindowControls from "../WindowControls";
import BranchMenu from "../welcome/BranchMenu";
import { IS_WINDOWS, MOD } from "../../platform";

// Middle-column topbar: sidebar toggle + session title + project/branch chips
// + right panel toggle (the old index.html chat-head structure)
export default function MainHeader({ onToggleSidebar, onToggleRight }: { onToggleSidebar: () => void; onToggleRight: () => void }) {
  const { t } = useTranslation();
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const diskProjects = useAppStore((s) => s.diskProjects);
  const headerGit = useAppStore((s) => s.headerGit);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useAppStore((s) => s.rightCollapsed);
  const isSubagent = Boolean(session?.isSubagent);
  const title = isCreatingNew
    ? t("misc.newTask")
    : session
      ? session.title || (diskProjects.flatMap((p) => p.sessions).find((x) => x.path === activePath)?.title) || pathBase(session.cwd)
      : t("misc.pickSession");
  const cwd = session?.cwd;
  // Remote workspace stubs show their host:path label instead of the stub dir basename
  const projectName = cwd ? diskProjects.find((p) => p.cwd === cwd)?.remoteLabel ?? pathBase(cwd) : null;
  const git = headerGit && headerGit.cwd === cwd ? headerGit : null;
  // null = closed; when open, holds the trigger chip's viewport coords (menu pops upward)
  const [branchMenu, setBranchMenu] = useState<DOMRect | null>(null);

  // Branch chip data: fetch on session switch (isGit comes with the session
  // object; a non-git cwd gets the isGit:false reply which hides the chip)
  useEffect(() => {
    if (cwd && session?.isGit) send({ type: "get_git_branches", cwd });
  }, [cwd, session?.isGit]);
  // Global close: click anywhere outside (menu clicks already close themselves)
  useEffect(() => {
    if (!branchMenu) return;
    const close = () => setBranchMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [branchMenu]);

  return (
    <div className="chat-head" data-tauri-drag-region="">
      <button className="icon-btn" title={t("misc.collapseSidebar", { mod: MOD })} id="sidebarToggle" onClick={onToggleSidebar}>
        <Icon name={sidebarCollapsed ? "collapseRight" : "collapseLeft"} />
      </button>
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
      <span className="text-ui-md font-semibold truncate min-w-0" id="chatTitle">
        {title}
        {isSubagent && <span className="subagent-head-badge">{t("chat.subagentBadge")}</span>}
      </span>
      {projectName && !isCreatingNew && (
        <span className="head-chip" title={cwd ?? undefined}>{projectName}</span>
      )}
      {git?.isGit && git.current && !isCreatingNew && (
        <button
          type="button"
          className={"head-chip clickable" + (branchMenu ? " active" : "")}
          title={t("misc.gitBranchTitle", { branch: git.current })}
          onClick={(e) => {
            e.stopPropagation();
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
          current={git.current ?? ""}
          cwd={git.cwd}
        />
      )}
      <span className="sp"></span>
      <button className="icon-btn" title={t("misc.collapseRightPanel")} id="panelToggle" onClick={onToggleRight}>
        <Icon name={rightCollapsed ? "collapseLeft" : "collapseRight"} />
      </button>
      {/* Windows frameless window control buttons: when the right panel is
          collapsed they merge into the main card's top-right corner (rendered
          on Windows only) */}
      {IS_WINDOWS && rightCollapsed && <WindowControls />}
    </div>
  );
}
