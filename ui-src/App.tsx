// App shell: three-column layout (sidebar / main area / right panel) + topbar +
// welcome-vs-session branching + the dock composer + toast.
// The DOM structure and class names mirror the existing static skeleton of
// ui/index.html (zero visual regression during the React migration);
// shell interactions such as collapse/theme are ported from their ui-src/shell.js
// counterparts; full capabilities (resizer drag/zoom) are noted in IMPLEMENTATION_PLAN.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pathBase, openSessionByPath } from "./store";
import { initShell, toggleSidebar, toggleRightPanel } from "./shell";
import Icon from "./Icon";
import Sidebar from "./components/Sidebar";
import Welcome from "./components/Welcome";
import Chat from "./components/Chat";
import Composer from "./components/Composer";
import ApprovalCard from "./components/chat/ApprovalCard";
import SessionStatsBar from "./components/SessionStatsBar";
import QueueCard from "./components/composer/QueueCard";
import GoalCard from "./components/composer/GoalCard";
import ConnBanner from "./components/ConnBanner";
import RightPanel from "./components/RightPanel";
import Settings from "./components/settings/Settings";
import WindowControls from "./components/WindowControls";
import { IS_WINDOWS, MOD } from "./platform";

function Toast() {
  const toastMsg = useAppStore((s) => s.toastMsg);
  if (!toastMsg) return null;
  return <div id="toast">{toastMsg}</div>;
}

// Middle-column topbar: sidebar toggle + session title + right panel toggle
// (the old index.html chat-head structure)
function ChatHead({ onToggleSidebar, onToggleRight }: { onToggleSidebar: () => void; onToggleRight: () => void }) {
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

export default function App() {
  const { t } = useTranslation();
  // Shell global listeners mount only once: theme restore/system theme
  // following, resizer drag, ⌘+/-/0 zoom, --col-max segments and rail
  // visibility, window click/blur menu coordination (ui-src/shell.js)
  useEffect(() => {
    initShell();
  }, []);
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const hubOpen = useAppStore((s) => s.hubOpen);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useAppStore((s) => s.rightCollapsed);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const pendingApproval = session?.pendingApprovals?.[0] ?? null;
  return (
    <>
      <Sidebar collapsed={sidebarCollapsed} />
      <div id="left-resizer" className="resizer" title={t("misc.dragResize")} hidden={sidebarCollapsed}></div>
      <main id="main">
        <ChatHead onToggleSidebar={toggleSidebar} onToggleRight={toggleRightPanel} />
        <ConnBanner />
        {isCreatingNew ? <Welcome /> : <Chat />}
        {!isCreatingNew && !hubOpen && (
          <>
            {/* Goal bar -> queue card -> input dock: three stacked cards from
                top down (the goal bar shifts up as the queue grows). Each card
                pulls up with -mb-28px and the next card presses on its bottom
                edge with z, exposing the upper half as a second-level stack */}
            <GoalCard />
            <QueueCard />
            <div className={pendingApproval ? "dock approval-active" : "dock"}>
              {pendingApproval ? <ApprovalCard key={pendingApproval.requestId} item={pendingApproval} /> : null}
              <Composer key={activePath || "composer"} inWelcome={false} blocking={Boolean(pendingApproval)} />
            </div>
            {/* Session stats row: outside the dock, on its own row below the
                composer card (not inside the composer) */}
            <SessionStatsBar />
          </>
        )}
      </main>
      <div id="right-resizer" className="resizer" title={t("misc.dragResize")} hidden={rightCollapsed}></div>
      <RightPanel collapsed={rightCollapsed} />
      <Settings />
      <Toast />
    </>
  );
}
