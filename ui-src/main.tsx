// React frontend entry: mounts App + native menu/notification dispatch + WS
// connection (or browser preview mode).
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { menuZoom, toggleTheme, toggleSidebar, applyTheme, applyMotion } from "./shell";
import { useAppStore, connect, showWelcomeScreen, initNewSessionModel, setConnected, openSettings, closeSettings, setBump, activateSession } from "./store";
import { initKeys } from "./keys";
import { initI18n } from "./i18n";
import type { ChatItem, ToolItem } from "./types/session";
import { warmupHighlighter } from "./lib/highlighter";
import { resolveTheme } from "./theme-registry";
import { landBrowserTabs, restoreRightSlot } from "./store/right";
import { IS_MAC } from "./platform";
import { REMOTE } from "./remote";
import { emitBrowserFrame, emitBrowserPick } from "./store/browserMirror";
import { syncAudioToPref } from "./components/chat/railAudio";
import { openSessionByPath } from "./store/session";
import { addIncomingPaths } from "./lib/incoming-files";

// Restore the first-frame render cache (the localStorage mirror of
// omp-desktop.json's ui section) before React mounts — this is what keeps the
// startup paint flicker-free. The ready frame later reconciles against the
// file (source of truth) and refreshes the cache; a cache miss falls back to
// the dark theme + system motion defaults. Calling the shared appliers also
// seeds the store and shell's system-mode media listener correctly.
{
  const savedTheme = localStorage.getItem("omp-theme");
  applyTheme(savedTheme === "system" ? "system" : resolveTheme(savedTheme));
  const savedMotion = localStorage.getItem("omp-motion");
  applyMotion(savedMotion === "on" || savedMotion === "off" ? savedMotion : "system");
}

// Platform flag for CSS: the native traffic-light geometry (trafficLightPosition)
// only exists on macOS, so layout pinned to it must not leak to Windows.
document.documentElement.dataset.platform = IS_MAC ? "macos" : "windows";

// Remote clients are plain browser pages: the macOS traffic lights are native
// window chrome of the HOST and never reach a browser, so the top-left strip
// reserved for them is dead space there (css/global/tokens.css shrinks it).
if (REMOTE) document.documentElement.dataset.remote = "true";

// Traffic lights disappear in native macOS fullscreen; resize covers both transitions.
const nativeWindow = IS_MAC ? window.__TAURI__?.window?.getCurrentWindow() : undefined;
if (nativeWindow) {
  const syncFullscreen = () => {
    void nativeWindow.isFullscreen().then((fullscreen) => {
      document.documentElement.dataset.fullscreen = String(fullscreen);
    });
  };
  syncFullscreen();
  void nativeWindow.onResized(syncFullscreen);
}

// ⌘, opens/closes the settings hub (ported from the old core.js global
// keydown; Esc is handled by the Settings container)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    if (useAppStore.getState().settingsOpen) closeSettings();
      else openSettings();
  }
});

// Global shortcuts (registry in ui-src/keys.js; keys bound inside components
// are not re-mounted here)
initKeys();

// Native menu action -> dispatch to existing capabilities (src-tauri menu item
// ids, forwarded via the "menu-action" event).
function dispatchMenuAction(action: unknown): void {
  switch (action) {
    case "new-session":
      if (useAppStore.getState().isCreatingNew) {
        setBump({ newSessionDirty: false }); // the old "write + notify" merged
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

// Enter the welcome page (creating-new state) at startup; the project stays on
// the empty placeholder until session_list lands the default project (the
// static + React boot veil covers the wait).
showWelcomeScreen(null);

// Init i18n before the first render and await it: language packs are lazy
// chunks now, so rendering earlier would paint raw keys for a frame. The
// static boot splash (#bootSplash in index.html) covers this window.
// The ?preview=1 comparison page always runs in the product locale, and it has
// to be chosen here — a later initI18n call would leave the lazy packs half loaded.
const previewMode = new URLSearchParams(location.search).has("preview");
await initI18n(previewMode ? "zh-CN" : useAppStore.getState().uiPrefs.lang);

// Align the native menu locale with the persisted UI language (the Rust shell
// boots with a zh-CN default menu). No-op in browser preview: __TAURI__ absent.
window.__TAURI__?.core?.invoke?.("set_menu_language", { lang: useAppStore.getState().uiPrefs.lang })
  ?.catch((err: unknown) => console.warn("set_menu_language:", err));

// Language-driven remount: subscribing to the raw lang primitive keeps the
// selector legal; switching the language swaps <App key={lang}> so the whole
// tree re-renders with the new locale (ErrorBoundary stays mounted).
function Root() {
  const lang = useAppStore((s) => s.uiPrefs.lang);
  return <ErrorBoundary><App key={lang} /></ErrorBoundary>;
}

// index.html's static skeleton carries the #root mount point; non-null
// assertion (absence means the shell skeleton is broken; let it throw)
const root = createRoot(document.getElementById("root")!);
root.render(<Root />);

// Native menu events (Tauri environment); no __TAURI__ when debugging straight
// in the browser, skip
window.__TAURI__?.event?.listen("menu-action", (e) => dispatchMenuAction(e.payload?.action));

if (new URLSearchParams(location.search).has("preview")) {
  // Browser comparison: ?preview=1 injects action samples (edit rows / change
  // groups / read groups / read rows / thinking / terminal cards); no host
  // connection
  const params = new URLSearchParams(location.search);
  // ?gallery=1 swaps in one real captured row per tool. Dynamic import keeps the
  // capture data out of the shipped entry chunk.
  const gallery = params.has("gallery")
    ? ((await import("./preview/gallery-items.json")).default as unknown as ToolItem[])
    : null;
  const diffSample = ["@@ -1,4 +1,5 @@", " body {", "-  color: red;", "+  color: blue;", "+  margin: 0;", " }"].join("\n");
  const readItem = (p: string): ToolItem => ({
    role: "tool", name: "read", text: "", args: { path: p }, files: [p],
    details: { resolvedPath: p, displayContent: { text: "body {\n  color: red;\n}", startLine: 1 } },
  });
  // Read rows show project-relative paths and keep absolute ones outside the cwd;
  // these two cover both branches (cwd is /preview)
  const pathSamples: ChatItem[] = gallery
    ? [
        { ...readItem("/preview/src/style.css"), intent: "读取项目内的样式文件" },
        { role: "assistant", text: "—" }, // breaks the lookup group so both rows stay standalone
        { ...readItem("/Users/xys/elsewhere/demo.ts"), intent: "读取项目外部的文件" },
      ]
    : [];
  // Inject samples by swapping the openSessions Map reference in one shot
  // (equivalent to the old "S silent write + openSessions.set", with the _v bump
  // merging the old trailing notify)
  useAppStore.setState(st => ({
    openSessions: new Map(st.openSessions).set("/preview", {
      sessionId: "preview",
      cwd: "/preview",
      // ?gallery=1 renders one real captured row per tool instead of the hand-written samples
      items: gallery ? [...gallery, ...pathSamples] : [
        { role: "user", text: "把主题色改成蓝色" },
        { role: "assistant", text: "先读一下样式文件。" },
        readItem("src/style.css"),
        { role: "thinking", text: "3 秒", expandable: true, expanded: true,
          thinking: "1. 定位颜色定义\n2. 替换为 blue\n" + "逐行核对相邻规则的级联影响\n".repeat(12) },
        { role: "tool", name: "edit", text: "", args: { path: "src/style.css" }, files: ["src/style.css"],
          added: 2, removed: 1, diffExpanded: true, diffContent: diffSample },
        { role: "assistant", text: "样式改完了，顺手补两个文件。" },
        { role: "tool", name: "write", text: "", args: { path: "src/a.ts" }, files: ["src/a.ts"], added: 10, removed: 0 },
        { role: "tool", name: "edit", text: "", args: { path: "src/b.ts" }, files: ["src/b.ts"], added: 2, removed: 5 },
        { role: "tool", name: "bash", args: { command: "bun run build" }, text: "bun run build", intent: "构建产物",
          cmdExpanded: true, output: "$ bun run build\n\n  dist/app.js  2.1mb\n\nDone in 44ms" },
        { role: "tool", name: "bash", args: { command: "git status --short" }, text: "git status --short", intent: "检查工作区改动",
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
      // Roster sample for the deck layout. The six rows split one real session's totals
      // (/Volumes/MacApps/Home/etower/etower-agent, 2026-11-17): 324,265 tokens, $0.0628,
      // 425 tool calls, 4,283 s across 48 model requests — so the pulse header adds up to
      // that session instead of invented numbers.
      subagents: new Map(
        (
          [
            ["CoreToolCutover", "确认工具外派到 Worker：收口 core 的 tool 注册面，外派八工具改走 Worker-only 通道", "completed", { total: 142_600 }, 0.0276, 187, 1_885_000, 118_000, false, 1_500_000, "已完成：core 的 tool 注册面收口，八工具外派 Worker-only 通道（bash/find/grep/ls/read/write/edit/etower_login）及 MCP pipeline；dispatch 端口名保持不变，缺失 dispatch 的本地 execute 分支已删除。core 侧只保留注册表与调度入口，工具实现全部迁到 Worker 包；MCP pipeline 的注入点从主进程改到 Worker 初始化，主进程不再直接持有 transport。变更共触及 12 个文件，新增 Worker 侧实现 8 个，删除本地 execute 分支 3 处；etower-agent 与 server 包的现有测试全部通过，无行为回归。后续如需新增工具，只需在 Worker 注册并同步 dispatch 端口名即可。", null],
            ["McpRetirement", "启用 MCP 切流：主应用改走 Worker 的 mcp 通道，移除旧的 transport 注入点", "completed", { total: 61_040 }, 0.0118, 80, 806_000, 96_000, false, 1_200_000, "已完成：主应用已改走 Worker 的 mcp 通道，旧的 transport 注入点全部移除，相关冒烟通过。", null],
            ["CoreFixtureTypes", "核对 core 的 fixture 类型出口并逐文件比对引用方，确认 CatalogTests 范围外没有遗漏的 re-export，最后排除掉 agent-engine-disclosure-e2e 的 5 个夹带引用", "completed", { total: 34_330 }, 0.0067, 45, 453_000, 71_000, false, 900_000, "已完成：fixture 类型出口核对完毕，CatalogTests 范围已排除，无类型回归。", null],
            ["CoreCatalogTests", "只改 core/src/__tests__/agent-engine 的类型引用", "completed", { total: 30_520 }, 0.0059, 40, 403_000, 54_000, false, 600_000, "已完成：agent-engine 的类型引用迁移完成，测试全绿。", "CoreFixtureTypes"],
            ["ConsumerCutover", "把消费端调用点迁到新 dispatch 端口", "failed", { total: 25_940 }, 0.005, 34, 342_000, 88_000, false, 420_000, null, null],
            ["PatchQueue", "收口 acp 投影的补丁队列，逐条校验几何护栏", "running", { total: 29_835 }, 0.0058, 39, 394_000, 112_000, true, 394_000, null, null],
          ] as const
        ).map(([name, description, status, tokens, cost, toolCount, durationMs, contextTokens, streaming, agoMs, result, parent]) => [
          name,
          {
            agent: name,
            name,
            text: "",
            description,
            status,
            streaming,
            result: result ?? undefined,
            parent: parent ?? undefined,
            tools: [],
            registeredAt: Date.now() - agoMs,
            usage: {
              resolvedModel: "tntapi/gpt-6.1-sol:high",
              modelRole: "task",
              tokens,
              cost,
              // 48 model requests over 425 tool calls, in proportion
              requests: Math.round((toolCount * 48) / 425),
              toolCount,
              durationMs,
              contextTokens,
              contextWindow: 128_000,
              completionPercent: streaming ? 42 : undefined,
              currentToolIntent: streaming ? "收口 acp 投影" : undefined,
            },
          },
        ]),
      ),
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
    rightTab: "subagent",
    rightTabs: ["subagent"],
    // The deck layout lives in the right sidebar: open it, or the sample renders off-screen
    rightCollapsed: false,
    // Comparison page runs in the product's own locale so the labels read like the real UI
    uiPrefs: { ...st.uiPrefs, lang: "zh-CN" as const },
  }));
  // Browser comparison debug hook (preview mode only): expose the store for
  // smoke reads via getState (P3 end state; the old S/notify retired), plus
  // the browser-mirror landing/bus emitters so UI smokes drive the real
  // frame paths (auto-open + screencast stills) without a WS
  window.__dbg = {
    useAppStore,
    landBrowserTabs: (tabs: unknown[]) =>
      landBrowserTabs(tabs as Parameters<typeof landBrowserTabs>[0]),
    emitBrowserFrame: (frame: { name: string; data: string; ts: number }) =>
      emitBrowserFrame({ type: "browser_frame", ...frame }),
    emitBrowserPick: (frame: { name: string; element: unknown }) =>
      emitBrowserPick({ type: "browser_pick", ...frame } as Parameters<typeof emitBrowserPick>[0]),
    // Session switching is a module-level function (not a store action), so smokes can
    // only drive the per-session slots — and thus the per-session hub state — through
    // this re-export; a dynamic import would hand back a second module instance.
    activateSession,
  };
  useAppStore.setState({ bootSplash: false }); // preview mounts with samples, no host boot to wait for
  setConnected(true, "预览");
} else {
  restoreRightSlot(null); // startup: bring back the welcome slot's persisted layout (if any)
  useAppStore.setState({ rightCollapsed: true }); // a launch always starts with the right panel collapsed (tab layout memory survives)
  connect();
  let pendingNotificationPath: string | null = null;
  const openNotification = (path: string): void => {
    if (!useAppStore.getState().connected) {
      pendingNotificationPath = path;
      return;
    }
    pendingNotificationPath = null;
    openSessionByPath(path);
  };
  useAppStore.subscribe((state, previous) => {
    if (state.connected && !previous.connected && pendingNotificationPath) openNotification(pendingNotificationPath);
  });
  const nativeEvents = window.__TAURI__?.event;
  const invokeNative = window.__TAURI__?.core?.invoke;
  // Native file drop (dragDropEnabled in tauri.conf.json): the webview never sees an HTML5
  // drop event once Tauri owns drag & drop, so absolute paths arrive here. The browser build
  // keeps MainColumn's HTML5 handler. See the dragDropEnabled note in shell.ts.
  // Payload is { paths, position } only: tauri://drag-drop already means "drop" (enter/over/
  // leave carry their own event names), so there is no `type` discriminator to check.
  void nativeEvents?.listen("tauri://drag-drop", (event) => {
    const payload = event.payload as { paths?: string[] } | undefined;
    if (!Array.isArray(payload?.paths)) return;
    addIncomingPaths(payload.paths);
  });
  if (nativeEvents && invokeNative) {
    void nativeEvents.listen("notification-open", (event) => openNotification(event.payload.path))
      .then(() => invokeNative<string | null>("notification_frontend_ready"))
      .then((path) => { if (path) openNotification(path); })
      .catch((error: unknown) => console.warn("notification-open listener:", error));
  }
  // Silent update probe so a new build shows up in the sidebar footer without
  // opening settings; it never blocks boot and fails quietly.
  void useAppStore.getState().probeUpdate();
  // Message-rail music reactivity (Windows only): the persisted pref owns the
  // capture lifecycle. The store was already hydrated from the localStorage
  // mirror before React mounted, so the pref is readable right here.
  void syncAudioToPref();
}

// Warm the highlighter's common grammars during startup idle so the first
// read-row expansion does not pay shiki's cold-start on the click path
warmupHighlighter(["typescript", "tsx", "markdown", "json"]);

// [TAPLOG] tap-to-click diagnostics (temporary); disable via localStorage taplog="0"
if (localStorage.getItem("taplog") !== "0") void import("./tap-probe");
