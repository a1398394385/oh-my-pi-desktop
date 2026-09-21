// omp desktop 前端入口：视觉与交互 1:1 仿照 prototype/session-view.html（kimi28 原型），
// 数据源换成本仓 WebSocket 宿主协议（host/host.ts）。
// 协议：命令 {create_session|load_session|list_sessions|prompt|get_messages|
//   set_approval_mode|approval_response|set_model|set_thinking|get_git_diff|
//   get_file_diff|get_settings|set_setting|set_desktop_env|get_models_catalog|
//   set_enabled_model|get_usage_stats|list_agent_assets|asset_file_read|
//   asset_file_write|asset_file_create|get_context_detail|get_limits|
//   set_project_expanded|remove_project|add_project}，事件见 core.onMessage。
//
// 模块结构（由原单文件 app.js 拆分）：
//   core.js 状态收编(S)+连接+事件路由 | shell.js 折叠/主题/右键/缩放 | sidebar.js 左栏任务列表
//   welcome.js 新建会话页 | composer.js 输入区/菜单/状态条 | markdown.js md 渲染引擎
//   ringpop.js 明细卡+消息轨道 | tool-labels.js 工具标签注册表(映射+行渲染) | tool-rows.js 动作行共享渲染工具 | chat.js 中栏消息流 | right.js 右栏全家
//   settings/* 设置中心七件套。加载顺序：vendor → fa-icons.js → icons.js（全局）→ 本入口(type=module)。
import { connect, renderAll, S, openSessions, setConnected, activeOpen } from "./core.js";
import { initShell, menuZoom, toggleTheme, setSidebarCollapsed, isSidebarCollapsed } from "./shell.js";
import { initSidebar } from "./sidebar.js";
import { initMarkdown } from "./markdown.js";
import { initRingpop } from "./ringpop.js";
import { initWelcome } from "./welcome.js";
import { initComposer } from "./composer.js";
import { initChat } from "./chat.js";
import { initRight } from "./right.js";
import { initSettings, applyAppearance, syncSettingsControls, openSettings, closeSettings, settingsOpen } from "./settings/index.js";
import { initAgents } from "./settings/agents.js";
import { showWelcomeScreen, initNewSessionModel } from "./welcome.js";

// 原生菜单 action → 既有能力分发（src-tauri 菜单项 id，经 "menu-action" 事件转发）。
// default 兜底 console.warn：未知 action 不静默假装成功。
function dispatchMenuAction(action) {
  switch (action) {
    case "new-session":
      // 与 sidebar.js newTaskAction（⌘N 同款）保持同步；设置页打开时不新建
      if (settingsOpen()) return;
      if (S.isCreatingNew) {
        S.newSessionDirty = false;
        initNewSessionModel(true);
        renderAll();
      }
      showWelcomeScreen(activeOpen()?.cwd);
      break;
    case "open-settings":
      settingsOpen() ? closeSettings() : openSettings();
      break;
    case "zoom-in":
      menuZoom("in");
      break;
    case "zoom-out":
      menuZoom("out");
      break;
    case "zoom-reset":
      menuZoom("reset");
      break;
    case "toggle-theme":
      toggleTheme();
      break;
    case "toggle-sidebar":
      setSidebarCollapsed(!isSidebarCollapsed());
      break;
    default:
      console.warn("未处理的菜单 action:", action);
  }
}

// 各域 init：原散落顶层的立即执行代码（事件绑定/observer）按依赖序统一挂接
initShell();
initSidebar();
initMarkdown();
initRingpop();
initWelcome();
initComposer();
initChat();
initRight();
initSettings();
initAgents();

hydrateIcons(); // 把 index.html 里的 [data-icon] 占位元素替换为 icons.js 注册表中的 svg
applyAppearance();
syncSettingsControls();

// 原生菜单事件（Tauri 环境）；浏览器直连调试时无 __TAURI__，跳过
window.__TAURI__?.event?.listen("menu-action", (e) => dispatchMenuAction(e.payload?.action));

renderAll();
if (new URLSearchParams(location.search).has("preview")) {
  // 浏览器对照原型：?preview=1 注入六种动作样本，不连宿主
  const previewItems = [
    { role: "tool", name: "bash", text: "bash", args: { command: 'ps aux | grep -E "tauri dev|omp-desktop|host/host.ts" | grep -v grep | awk \'{print $2, $11, $12, $13}\'; echo "---清理检查完毕---"' } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: "本 workspace 已全清（32824 是 omp-kimi28 的打包实例，无关；76094 窗口归属它，悬案全解）。实现上下文环：" },
    { role: "tool", name: "edit", text: "edit", files: ["index.html", "style.css"] },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "tool", name: "edit", text: "edit", files: ["ui/app.js"], added: 31, removed: 1 },
    { role: "thinking", text: "思考 · 持续了几秒", thinking: "展开后的思考内容示意。", expandable: true },
    { role: "tool", name: "edit", text: "edit", files: ["ui/app.js"], removed: 1 },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: "校验语法后起全新 dev：" },
    { role: "tool", name: "bash", text: "bash", args: { command: "node --check /Users/xys/oh-my-pi-desktop/oh-my-pi-desktop-zcode-glm53flash/ui/app.js && echo \"JS OK\"" } },
    { role: "tool", name: "todo", text: "todo", todo: { content: "起干净 dev，定位「模型/思考下拉不见了」根因（双 dev 实例混合状态假设）", done: 2, total: 5 } },
    { role: "tool", name: "bash", text: "bash", args: { command: "bunx tauri dev" } },
    { role: "tool", name: "bash", text: "bash", args: { command: 'sleep 25; swift /tmp/winpid.swift; ps aux | grep "zcode-glm53flash/src-tauri/target" | grep -v grep | awk \'{print $2}\' | head -2' } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: "33413（新实例）又是同样的迷你状态——真凶找到了方向：macOS 的应用状态恢复（Saved Application State），identifier 相同的应用（kimi28 打包版可能同 identifier）把最小化窗口状态传染给了 dev 实例。验证并清除：" },
    { role: "tool", name: "bash", text: "bash", args: { command: "defaults read /Users/xys/oh-my-pi-desktop/oh-my-pi-desktop-omp-kimi28/src-tauri/src-tauri.conf.json 2>/dev/null | head -3; grep -h ident…" } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: 'identifier 不同、无 savedState——假设否。但意识到之前 System Events 的 `tell process "omp-desktop"` 按名字匹配到了 kimi28 的实例（同名进程）！改用 unix id 精确匹配本实例操作窗口：' },
    { role: "tool", name: "bash", text: "bash", args: { command: "osascript <<'EOF' 2>&1 tell application \"System Events\" tell (first process whose unix id is 33413) set frontmost to true delay 0.4 set wc to …" } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "tool", name: "bash", text: "bash", args: { command: "screencapture -l 76099 /tmp/w1.png 2>&1; ls -la /tmp/w1.png 2>/dev/null; screencapture -x -D 1 /tmp/screen1.png 2>&1 && sips -g pixelWi…" } },
    { role: "tool", name: "bash", text: "bash", args: { command: "sips -c 800 800 --cropOffset 1900 3800 /tmp/screen1.png --out /tmp/screen1-crop.png >/dev/null 2>&1 && echo cropped" } },
    { role: "tool", name: "read", text: "read", files: ["/tmp/screen1-crop.png"] },
    { role: "tool", name: "hub", text: "hub", args: { op: "start", name: "api-server", application: "bun", args: ["run", "server.ts"] }, output: "Started api-server (PID 88219) on port 3000\nReady in 120ms" },
  ];
  S.isCreatingNew = false; // 初始 renderAll 已进过欢迎页（isCreatingNew=true），复位避免预览被短路回欢迎页
  S.activePath = "/preview";
  openSessions.set(S.activePath, {
    sessionId: "preview",
    cwd: "/Users/xys/oh-my-pi-desktop/oh-my-pi-desktop-zcode-glm53flash",
    items: previewItems,
    assistantDraft: "",
    streaming: true,
    turnStartAt: Date.now() - 8000,
    subagents: new Map(),
    model: null,
    thinking: "auto",
    isGit: false,
    todos: [],
  });
  setConnected(true, "预览");
  renderAll();
  document.getElementById("chatTitle").textContent = "查看指定 sessionId 的 zcode 对话记录";
} else {
  connect();
}

