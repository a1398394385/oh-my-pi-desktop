import { useTranslation } from "react-i18next";
import { useAppStore, pathBase, openSessionByPath } from "../../store";
import Icon from "../../Icon";
import WindowControls from "../WindowControls";
import { IS_WINDOWS, MOD } from "../../platform";

// Middle-column topbar: sidebar toggle + session title + right panel toggle
// (the old index.html chat-head structure)
export default function MainHeader({ onToggleSidebar, onToggleRight }: { onToggleSidebar: () => void; onToggleRight: () => void }) {
  const { t } = useTranslation();
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const diskProjects = useAppStore((s) => s.diskProjects);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useAppStore((s) => s.rightCollapsed);
  const isSubagent = Boolean(session?.isSubagent);
  const title = isCreatingNew
    ? t("misc.newTask")
    : session
      ? session.title || (diskProjects.flatMap((p) => p.sessions).find((x) => x.path === activePath)?.title) || pathBase(session.cwd)
      : t("misc.pickSession");
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
      <span className="text-ui-md font-semibold truncate min-w-0 flex-1" id="chatTitle">
        {title}
        {isSubagent && <span className="subagent-head-badge">{t("chat.subagentBadge")}</span>}
      </span>
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

