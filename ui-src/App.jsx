// 应用壳：三栏布局（侧栏 / 主区 / 右栏）+ 顶栏 + 欢迎页与会话区分流 + dock 输入区 + toast。
// DOM 结构与类名对照 ui/index.html 既有静态骨架（React 迁移期视觉零回归）；
// 折叠/主题等壳交互自 ui/shell.js 对应平移，完整能力（resizer 拖动/缩放）见 IMPLEMENTATION_PLAN。
import { S, useStore, notify, activeOpen, diskProjects } from "./store.js";
import Icon from "./Icon.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Welcome from "./components/Welcome.jsx";
import Chat from "./components/Chat.jsx";
import Composer from "./components/Composer.jsx";
import RightPanel from "./components/RightPanel.jsx";

function Toast() {
  useStore();
  if (!S.toastMsg) return null;
  return <div id="toast">{S.toastMsg}</div>;
}

// 中栏顶栏：侧栏开关 + 会话标题 + 右栏开关（原 index.html chat-head 结构）
function ChatHead({ onToggleSidebar, onToggleRight }) {
  useStore();
  const s = activeOpen();
  const title = S.isCreatingNew
    ? "新建任务"
    : s
      ? (diskProjects.flatMap((p) => p.sessions).find((x) => x.path === S.activePath)?.title) || s.cwd.split("/").pop()
      : "选择左侧会话或新建任务";
  return (
    <div className="chat-head" data-tauri-drag-region="">
      <button className="icon-btn" title="收起侧边栏 (⌘B)" id="sidebarToggle" onClick={onToggleSidebar}>
        <Icon name={S.sidebarCollapsed ? "collapseRight" : "collapseLeft"} />
      </button>
      <Icon name="folderOld" style={{ color: "var(--faint)" }} />
      <span className="ttl" id="chatTitle">{title}</span>
      <span className="sp"></span>
      <button className="icon-btn" title="收起侧边面板" id="panelToggle" onClick={onToggleRight}>
        <Icon name={S.rightCollapsed ? "collapseLeft" : "collapseRight"} />
      </button>
    </div>
  );
}

export default function App() {
  useStore();
  const toggleSidebar = () => {
    S.sidebarCollapsed = !S.sidebarCollapsed;
    localStorage.setItem("omp-sidebar-collapsed", S.sidebarCollapsed ? "1" : "0");
    notify();
  };
  const toggleRight = () => {
    S.rightCollapsed = !S.rightCollapsed;
    localStorage.setItem("omp-right-collapsed", S.rightCollapsed ? "1" : "0");
    notify();
  };
  return (
    <>
      <Sidebar collapsed={S.sidebarCollapsed} />
      <div id="left-resizer" className="resizer" title="拖动调整宽度" hidden={S.sidebarCollapsed}></div>
      <main id="main">
        <ChatHead onToggleSidebar={toggleSidebar} onToggleRight={toggleRight} />
        {S.isCreatingNew ? <Welcome /> : <Chat />}
        {!S.isCreatingNew && (
          <div className="dock">
            <Composer inWelcome={false} />
          </div>
        )}
      </main>
      <div id="right-resizer" className="resizer" title="拖动调整宽度" hidden={S.rightCollapsed}></div>
      <RightPanel collapsed={S.rightCollapsed} />
      <Toast />
    </>
  );
}
