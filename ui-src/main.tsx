// React 版前端入口：挂载 App + 原生菜单 action 分发 + WS 连接（或浏览器 preview 模式）。
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { menuZoom, toggleTheme, toggleSidebar } from "./shell";
import { useAppStore, connect, showWelcomeScreen, initNewSessionModel, setConnected, openSettings, closeSettings, setBump } from "./store";
import { initKeys } from "./keys";
import type { ToolItem } from "./types/session";

// 启动即恢复本地主题（旧版 shell.js initShell 语义；system 值由 prefers-color-scheme 决定）
{
  const savedTheme = localStorage.getItem("omp-theme");
  if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
  else if (savedTheme === "system") {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
}

// 启动即恢复本地「减弱动态效果」偏好（外观页设置；system 时移除属性，回落系统 prefers-reduced-motion）
{
  const savedMotion = localStorage.getItem("omp-motion");
  if (savedMotion === "on" || savedMotion === "off") document.documentElement.dataset.motion = savedMotion;
}

// ⌘, 打开/关闭设置中心（旧版 core.js 全局 keydown 平移；Esc 由 Settings 容器处理）
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    if (useAppStore.getState().settingsOpen) closeSettings();
      else openSettings();
  }
});

// 全局快捷键（注册表见 ui-src/keys.js；组件内绑定的键不在此重复挂）
initKeys();

// 原生菜单 action → 既有能力分发（src-tauri 菜单项 id，经 "menu-action" 事件转发）。
function dispatchMenuAction(action: unknown): void {
  switch (action) {
    case "new-session":
      if (useAppStore.getState().isCreatingNew) {
        setBump({ newSessionDirty: false }); // 原「写+notify」合并
        initNewSessionModel(true);
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
      toggleSidebar();
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

// index.html 静态骨架带 #root 挂载点；非空断言（缺失即壳骨架破坏，任其自然抛错）
const root = createRoot(document.getElementById("root")!);
root.render(<ErrorBoundary><App /></ErrorBoundary>);

// 原生菜单事件（Tauri 环境）；浏览器直连调试时无 __TAURI__，跳过
window.__TAURI__?.event?.listen("menu-action", (e) => dispatchMenuAction(e.payload?.action));

if (new URLSearchParams(location.search).has("preview")) {
  // 浏览器对照：?preview=1 注入动作样本（编辑行/更改组/查阅组/读取行/思考/终端卡），不连宿主
  const diffSample = ["@@ -1,4 +1,5 @@", " body {", "-  color: red;", "+  color: blue;", "+  margin: 0;", " }"].join("\n");
  const readItem = (p: string): ToolItem => ({
    role: "tool", name: "read", text: "", args: { path: p }, files: [p],
    details: { resolvedPath: p, displayContent: { text: "body {\n  color: red;\n}", startLine: 1 } },
  });
  // 一次性换 openSessions Map 引用注入样本（等价旧「S 静默写 + openSessions.set」，_v bump 合并原尾部 notify）
  useAppStore.setState(st => ({
    openSessions: new Map(st.openSessions).set("/preview", {
      sessionId: "preview",
      cwd: "/preview",
      items: [
        { role: "user", text: "把主题色改成蓝色" },
        { role: "assistant", text: "先读一下样式文件。" },
        readItem("src/style.css"),
        { role: "thinking", text: "思考 · 3 秒", expandable: true, expanded: true,
          thinking: "1. 定位颜色定义\n2. 替换为 blue\n" + "逐行核对相邻规则的级联影响\n".repeat(12) },
        { role: "tool", name: "edit", text: "", args: { path: "src/style.css" }, files: ["src/style.css"],
          added: 2, removed: 1, diffExpanded: true, briefDiff: diffSample },
        { role: "assistant", text: "样式改完了，顺手补两个文件。" },
        { role: "tool", name: "write", text: "", args: { path: "src/a.ts" }, files: ["src/a.ts"], added: 10, removed: 0 },
        { role: "tool", name: "edit", text: "", args: { path: "src/b.ts" }, files: ["src/b.ts"], added: 2, removed: 5 },
        { role: "tool", name: "bash", args: { command: "bun run build" }, text: "bun run build",
          cmdExpanded: true, output: "$ bun run build\n\n  dist/app.js  2.1mb\n\nDone in 44ms" },
        { role: "tool", name: "bash", args: { command: "git status --short" }, text: "git status --short",
          output: " M ui/style.css\n?? ui/file-icons.js" },
        { role: "assistant", text: "改好了。" },
        { role: "user", text: "构建一下" },
        { role: "loop", text: "", collapsed: true, durationSec: 83,
          usage: { input: 12040, output: 320, cacheRead: 90000, cacheWrite: 0 }, items: [] },
        { role: "assistant", text: "构建成功，无报错。" },
        { role: "tool", name: "read", text: "", group: [readItem("src/a.ts"), readItem("src/b.ts")] },
      ],
      assistantDraft: "",
      streaming: false,
      subagents: new Map([["sa1", { agent: "scout", name: "scout", text: "", description: "侦察代码结构", status: "completed", streaming: false, tools: [] }]]),
      model: null,
      thinking: "auto",
      isGit: false,
      todos: [{ name: "阶段一", tasks: [
        { content: "读取样式文件", status: "completed" },
        { content: "修改主题色", status: "in_progress" },
        { content: "验证构建", status: "pending" },
      ] }],
    }),
    activePath: "/preview",
    isCreatingNew: false,
  }));
  // 浏览器对照调试钩子（仅 preview 模式）：暴露 store 供冒烟读取 getState（P3 终态,旧 S/notify 退役）
  window.__dbg = { useAppStore };
  setConnected(true, "预览");
} else {
  connect();
}
