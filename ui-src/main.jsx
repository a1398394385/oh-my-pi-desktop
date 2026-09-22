// React 版前端入口：挂载 App + 原生菜单 action 分发 + WS 连接（或浏览器 preview 模式）。
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { menuZoom, toggleTheme } from "./shell.js";
import { S, notify, connect, showWelcomeScreen, initNewSessionModel, openSessions, setConnected, openSettings, closeSettings } from "./store.js";

// 启动即恢复本地主题（旧版 shell.js initShell 语义；system 值由 prefers-color-scheme 决定）
{
  const savedTheme = localStorage.getItem("omp-theme");
  if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
  else if (savedTheme === "system") {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
}

// ⌘, 打开/关闭设置中心（旧版 core.js 全局 keydown 平移；Esc 由 Settings 容器处理）
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    if (S.settingsOpen) closeSettings();
    else openSettings();
  }
});

// 原生菜单 action → 既有能力分发（src-tauri 菜单项 id，经 "menu-action" 事件转发）。
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
      menuZoom(1);
      break;
    case "zoom-out":
      menuZoom(-1);
      break;
    case "zoom-reset":
      menuZoom(0);
      break;
    case "toggle-theme":
      toggleTheme();
      break;
    case "toggle-sidebar":
      S.sidebarCollapsed = !S.sidebarCollapsed;
      notify();
      break;
    case "open-settings":
      openSettings();
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
  // 浏览器对照：?preview=1 注入动作样本（编辑行/更改组/读取行/思考/终端卡），不连宿主
  S.isCreatingNew = false;
  S.activePath = "/preview";
  const diffSample = ["@@ -1,4 +1,5 @@", " body {", "-  color: red;", "+  color: blue;", "+  margin: 0;", " }"].join("\n");
  openSessions.set(S.activePath, {
    sessionId: "preview",
    cwd: "/preview",
    items: [
      { role: "user", text: "把主题色改成蓝色" },
      { role: "assistant", text: "先读一下样式文件。" },
      { role: "tool", name: "read", args: { path: "src/style.css" }, files: ["src/style.css"],
        details: { resolvedPath: "src/style.css", displayContent: { text: "body {\n  color: red;\n}", startLine: 1 } } },
      { role: "thinking", text: "思考 · 3 秒", expandable: true, expanded: true,
        thinking: "1. 定位颜色定义\n2. 替换为 blue\n" + "逐行核对相邻规则的级联影响\n".repeat(12) },
      { role: "tool", name: "edit", args: { path: "src/style.css" }, files: ["src/style.css"],
        added: 2, removed: 1, diffExpanded: true, briefDiff: diffSample },
      { role: "tool", name: "write", args: { path: "src/a.ts" }, files: ["src/a.ts"], added: 10, removed: 0 },
      { role: "tool", name: "edit", args: { path: "src/b.ts" }, files: ["src/b.ts"], added: 2, removed: 5 },
      { role: "tool", name: "bash", args: { command: "bun run build" }, text: "bun run build",
        cmdExpanded: true, output: "$ bun run build\n\n  dist/app.js  2.1mb\n\nDone in 44ms" },
      { role: "assistant", text: "改好了。" },
    ],
    assistantDraft: "",
    streaming: false,
    subagents: new Map([["sa1", { name: "scout", streaming: false, tools: [] }]]),
    model: null,
    thinking: "auto",
    isGit: false,
    todos: [[{ title: "阶段一", tasks: [
      { content: "读取样式文件", status: "completed" },
      { content: "修改主题色", status: "in_progress" },
      { content: "验证构建", status: "pending" },
    ] }]],
  });
  // 浏览器对照调试钩子：驱动 S/notify 模拟宿主回包（仅 preview 模式）
  window.__dbg = { S, notify, openSessions };
  setConnected(true, "预览");
  notify();
} else {
  connect();
}
