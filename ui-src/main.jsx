// React 版前端入口：挂载 App + 原生菜单 action 分发 + WS 连接（或浏览器 preview 模式）。
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { S, notify, connect, showWelcomeScreen, initNewSessionModel, openSessions, setConnected } from "./store.js";

// 原生菜单 action → 既有能力分发（src-tauri 菜单项 id，经 "menu-action" 事件转发）。
// TODO(settings-wave)：open-settings 待设置页组件就位后接。
function dispatchMenuAction(action) {
  switch (action) {
    case "new-session":
      if (S.isCreatingNew) {
        S.newSessionDirty = false;
        initNewSessionModel(true);
        notify();
      }
      showWelcomeScreen(null);
      break;
    case "zoom-in":
    case "zoom-out":
    case "zoom-reset":
      // TODO(shell-wave)：缩放（S.zoomLevel + html zoom）
      break;
    case "toggle-theme":
      // TODO(shell-wave)：主题切换（data-theme + localStorage）
      break;
    case "toggle-sidebar":
      S.sidebarCollapsed = !S.sidebarCollapsed;
      notify();
      break;
    default:
      console.warn("未处理的菜单 action:", action);
  }
}

// 启动即进欢迎页（新建态）；磁盘列表到达前 project 兜底 "/"
showWelcomeScreen(null);

const root = createRoot(document.getElementById("root"));
root.render(<App />);

// 原生菜单事件（Tauri 环境）；浏览器直连调试时无 __TAURI__，跳过
window.__TAURI__?.event?.listen("menu-action", (e) => dispatchMenuAction(e.payload?.action));

if (new URLSearchParams(location.search).has("preview")) {
  // 浏览器对照：?preview=1 注入动作样本，不连宿主
  S.isCreatingNew = false;
  S.activePath = "/preview";
  openSessions.set(S.activePath, {
    sessionId: "preview",
    cwd: "/preview",
    items: [
      { role: "user", text: "预览一条用户消息" },
      { role: "assistant", text: "React 版壳已挂载。消息流渲染在 chat-wave 落地。" },
    ],
    assistantDraft: "",
    streaming: false,
    subagents: new Map(),
    model: null,
    thinking: "auto",
    isGit: false,
    todos: [],
  });
  setConnected(true, "预览");
  notify();
} else {
  connect();
}
