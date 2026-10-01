// 应用壳：三栏布局（侧栏 / 主区 / 右栏）+ 顶栏 + 欢迎页与会话区分流 + dock 输入区 + toast。
// DOM 结构与类名对照 ui/index.html 既有静态骨架（React 迁移期视觉零回归）；
// 折叠/主题等壳交互自 ui-src/shell.js 对应平移，完整能力（resizer 拖动/缩放）见 IMPLEMENTATION_PLAN。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pathBase } from "./store";
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

// 中栏顶栏：侧栏开关 + 会话标题 + 右栏开关（原 index.html chat-head 结构）
function ChatHead({ onToggleSidebar, onToggleRight }: { onToggleSidebar: () => void; onToggleRight: () => void }) {
  const { t } = useTranslation();
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const diskProjects = useAppStore((s) => s.diskProjects);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useAppStore((s) => s.rightCollapsed);
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
      <Icon name="folderOld" style={{ color: "var(--faint)" }} />
      <span className="text-ui-md font-semibold truncate min-w-0 flex-1" id="chatTitle">{title}</span>
      <span className="sp"></span>
      <button className="icon-btn" title={t("misc.collapseRightPanel")} id="panelToggle" onClick={onToggleRight}>
        <Icon name={rightCollapsed ? "collapseLeft" : "collapseRight"} />
      </button>
      {/* Windows 无边框窗口控制按钮：右栏收起时融入中栏卡片右上角（仅 Windows 渲染） */}
      {IS_WINDOWS && rightCollapsed && <WindowControls />}
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  // 壳全局监听只挂一次：主题恢复/系统主题跟随、resizer 拖动、⌘+/-/0 缩放、
  // --col-max 分段与轨道显隐、window click/blur 菜单协调（ui-src/shell.js）
  useEffect(() => {
    initShell();
  }, []);
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
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
        {!isCreatingNew && (
          <>
            {/* goal 目标栏 → 排队卡 → 输入 dock：三级重叠卡自上而下（goal 栏随队列增高上移）。
                卡各自 -mb-28px 上拉，下一张卡以 z 压住其下缘，露出上半张二级重叠卡 */}
            <GoalCard />
            <QueueCard />
            <div className={pendingApproval ? "dock approval-active" : "dock"}>
              {pendingApproval ? <ApprovalCard key={pendingApproval.requestId} item={pendingApproval} /> : null}
              <Composer key={activePath || "composer"} inWelcome={false} blocking={Boolean(pendingApproval)} />
            </div>
            {/* 会话统计行：dock 之外、输入卡片下方另起一行（不是输入框内部） */}
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
