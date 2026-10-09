// React frontend entry: mounts App + native menu action dispatch + WS
// connection (or browser preview mode).
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { menuZoom, toggleTheme, toggleSidebar, applyTheme, applyMotion } from "./shell";
import { useAppStore, connect, showWelcomeScreen, initNewSessionModel, setConnected, openSettings, closeSettings, setBump, activateSession } from "./store";
import { initKeys } from "./keys";
import { initI18n } from "./i18n";
import type { ToolItem } from "./types/session";
import { warmupHighlighter } from "./lib/highlighter";
import { resolveTheme } from "./theme-registry";
import { landBrowserTabs, restoreRightSlot } from "./store/right";
import { emitBrowserFrame } from "./store/browserMirror";
import { syncAudioToPref } from "./components/chat/railAudio";

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

// Init i18n before the first render; uiPrefs.lang is resolved at store
// creation (stored preference first, otherwise system detection persisted back).
initI18n(useAppStore.getState().uiPrefs.lang);

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
  const diffSample = ["@@ -1,4 +1,5 @@", " body {", "-  color: red;", "+  color: blue;", "+  margin: 0;", " }"].join("\n");
  const readItem = (p: string): ToolItem => ({
    role: "tool", name: "read", text: "", args: { path: p }, files: [p],
    details: { resolvedPath: p, displayContent: { text: "body {\n  color: red;\n}", startLine: 1 } },
  });
  // Inject samples by swapping the openSessions Map reference in one shot
  // (equivalent to the old "S silent write + openSessions.set", with the _v bump
  // merging the old trailing notify)
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
          added: 2, removed: 1, diffExpanded: true, diffContent: diffSample },
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
    rightTab: "subagent",
    rightTabs: ["subagent"],
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
  // Message-rail music reactivity (Windows only): the persisted pref owns the
  // capture lifecycle. The store was already hydrated from the localStorage
  // mirror before React mounted, so the pref is readable right here.
  void syncAudioToPref();
}

// Warm the highlighter's common grammars during startup idle so the first
// read-row expansion does not pay shiki's cold-start on the click path
warmupHighlighter(["typescript", "tsx", "markdown", "json"]);
