// Window shell: theme (dark/light/system), motion, ⌘ and menu zoom, menu
// coordination, sidebar drag-resize, content column width segments, message
// rail visibility, fixed menu coordinate compensation, railToolText.
// Ported 1:1 from ui/shell.js + the railToolText section of ui/ringpop.js; no
// dependency on old ui/ modules.
// DOM side effects stay imperative; React components cooperate via the
// omp:close-menus / omp:zoom custom events.
import { useAppStore, send, setBump, type TimerHandle } from "./store";
import type { ToolItem } from "./types/session";
import { IS_WINDOWS } from "./platform";
import { yieldSummary } from "./components/chat/util";
import { t } from "./i18n";
import { THEMES, type ThemeId } from "./theme-registry";

// Theme/motion modes. Persistence is file-first: omp-desktop.json's ui section
// is the source of truth (saveTheme/saveMotion write it via the set_ui_prefs
// RPC and mirror the value into localStorage, which only serves as the
// first-frame render cache read at startup).
type ThemeMode = ThemeId | "system";
type MotionMode = "system" | "on" | "off";

// ---------- Menu coordination ----------
// React-side consumers (Composer menus and other state-driven ones) listen for
// omp:close-menus to close themselves; the settings page Sel dropdowns
// (ModelPage/McpPage/SkillsPage etc.) hold .menu.open as DOM class state --
// just strip the class (same as the old closeAllMenus finale).
export function closeAllMenus(): void {
  document.dispatchEvent(new CustomEvent("omp:close-menus"));
  for (const m of document.querySelectorAll(".menu.open")) m.classList.remove("open");
  for (const b of document.querySelectorAll(".pill-btn.active")) b.classList.remove("active");
}

// ---------- Theme (dark / light / system / custom themes) ----------
let themeMode: ThemeMode = "dark";
const themeMq = matchMedia("(prefers-color-scheme: dark)");

/** Apply a theme to the DOM and mirror it into the store (no persistence — callers decide). */
export function applyTheme(mode: ThemeMode): void {
  themeMode = mode;
  // Resolve concrete theme: system → dark/light based on OS, custom theme IDs stay as-is
  let concreteTheme: string;
  if (mode === "system") {
    concreteTheme = themeMq.matches ? "dark" : "light";
  } else {
    concreteTheme = mode;
  }
  // Set data-theme to the concrete theme ID (midnight/coral/dark/light/etc.)
  document.documentElement.dataset.theme = concreteTheme;
  setBump({ uiPrefs: { ...useAppStore.getState().uiPrefs, theme: mode } });

  // Diff viewer theme class follows the theme's mode (light vs dark)
  const themeEntry = THEMES[concreteTheme as ThemeId];
  const isDark = themeEntry ? themeEntry.mode === "dark" : concreteTheme === "dark";
  document.documentElement.dataset.themeMode = isDark ? "dark" : "light";
  for (const h of document.querySelectorAll(".fd-holder")) {
    h.classList.toggle("d2h-dark-color-scheme", isDark);
  }
  // The settings page theme Sel's selected label is per-page component state
  // (AppearancePage reads uiPrefs.theme); dataset.themeMode tracks the effective mode.
}

/** User-driven theme switch: apply + persist to omp-desktop.json (+ cache mirror). */
export function saveTheme(mode: ThemeMode): void {
  applyTheme(mode);
  try { localStorage.setItem("omp-theme", mode); } catch {}
  send({ type: "set_ui_prefs", theme: mode });
}

// Native menu "toggle dark/light theme": swap dark and light (the system state
// snaps to the currently effective color first, then switches)
export function toggleTheme(): void {
  const effectiveTheme = document.documentElement.dataset.theme || "dark";
  const themeEntry = THEMES[effectiveTheme as ThemeId];
  const isDark = themeEntry ? themeEntry.mode === "dark" : effectiveTheme === "dark";
  // Toggle to the opposite built-in theme
  saveTheme(isDark ? "light" : "dark");
}

// ---------- Reduce motion (system follows the OS / on force-reduced / off force-animated) ----------
/** Apply a motion mode to the DOM and mirror it into the store (no persistence — callers decide). */
export function applyMotion(mode: MotionMode): void {
  // system removes the attribute to fall back to the media query; on/off is taken over by html[data-motion] forced rules
  if (mode === "system") delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = mode;
  setBump({ uiPrefs: { ...useAppStore.getState().uiPrefs, motion: mode } });
}

/** User-driven motion switch: apply + persist to omp-desktop.json (+ cache mirror). */
export function saveMotion(mode: MotionMode): void {
  applyMotion(mode);
  try { localStorage.setItem("omp-motion", mode); } catch {}
  send({ type: "set_ui_prefs", motion: mode });
}

// ---------- Sidebar collapse toggles (shared by the topbar button / native menu / ⌘B) ----------
export function toggleSidebar(): void {
  const sidebarCollapsed = !useAppStore.getState().sidebarCollapsed;
  setBump({ sidebarCollapsed });
  localStorage.setItem("omp-sidebar-collapsed", sidebarCollapsed ? "1" : "0");
}

export function toggleRightPanel(): void {
  const rightCollapsed = !useAppStore.getState().rightCollapsed;
  // Expanding the right panel yields to collapse the process card (same as parts.jsx)
  setBump(rightCollapsed ? { rightCollapsed } : { rightCollapsed, todoCollapsed: true });
}

// ---------- Sidebar drag-resize ----------
// Widths go through CSS variables, remembered in localStorage; the center card
// is guaranteed to compress down to a minimum of 30% of the viewport total width.
// The first call restores the remembered width from localStorage (omp-w-*).
export function attachResizer(handleId: string, cssVar: string, min: number, invert: boolean, maxPct?: number): void {
  const panel = handleId === "left-resizer" ? document.getElementById("sidebar") : document.getElementById("right");
  if (!panel) return;
  const apply = (w: number) => document.documentElement.style.setProperty(cssVar, w + "px");
  try {
    const saved = localStorage.getItem("omp-w-" + cssVar);
    if (saved) apply(+saved);
  } catch {}
  document.getElementById(handleId)?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / useAppStore.getState().zoomLevel;
      const wWin = document.documentElement.clientWidth || window.innerWidth || 1000;
      // The center card keeps a minimum width of 30% of the app total width
      // (still compressible down to 30%)
      const minMainW = Math.max(240, Math.floor(wWin * 0.30));
      const otherPanel = invert ? document.getElementById("sidebar") : document.getElementById("right");
      const otherW = (otherPanel && !otherPanel.classList.contains("collapsed")) ? otherPanel.offsetWidth : 0;
      const totalGaps = 32;
      const maxAllowed = Math.min(
        Math.max(min, wWin - minMainW - otherW - totalGaps),
        maxPct ? Math.floor(wWin * maxPct) : Infinity,
      );

      let targetW = invert ? (startW - dx) : (startW + dx);
      targetW = Math.max(min, Math.min(targetW, maxAllowed));
      const w = Math.round(targetW);
      apply(w);
      try {
        localStorage.setItem("omp-w-" + cssVar, String(w));
      } catch {}
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ---------- Cmd +/-/0 and native menu zoom ----------
// Only the three layout containers are zoomed: zooming the whole body would
// double-scale position:fixed menus, misplacing the rendered context menus /
// theme menus and their click hit targets.
// (zoomTargets is lazily initialized: #sidebar/#main/#right do not exist before
// App mounts)
let zoomTargets: (HTMLElement | null)[] | null = null;
function applyZoom(): void {
  if (!zoomTargets) zoomTargets = ["sidebar", "main", "right"].map((id) => document.getElementById(id));
  // style.zoom is a non-standard property (absent from TS lib.dom): assert the
  // write, semantics unchanged from the original
  for (const el of zoomTargets) if (el) (el.style as CSSStyleDeclaration & { zoom: string }).zoom = String(useAppStore.getState().zoomLevel);
  // zoom changes layout width but does not trigger ResizeObserver (Chrome/WebKit
  // behavior); notify the composer to recompute the bottom-bar collapse
  window.dispatchEvent(new CustomEvent("omp:zoom"));
  updateRailVisibility();
}
// Zoom actions: the ⌘+/-/0 shortcut and the native menu zoom-in/out/reset share
// the same application path.
// dir: 1 zoom in / -1 zoom out / 0 reset (tolerates the old "in"/"out"/"reset" strings)
export function menuZoom(dir: 1 | -1 | 0 | "in" | "out" | "reset"): void {
  // Silent write (the old menuZoom did not notify; rendering takes effect
  // directly via applyZoom's DOM side effects)
  const cur = useAppStore.getState().zoomLevel;
  if (dir === 1 || dir === "in") useAppStore.setState({ zoomLevel: Math.min(2, +(cur + 0.1).toFixed(2)) });
  else if (dir === -1 || dir === "out") useAppStore.setState({ zoomLevel: Math.max(0.6, +(cur - 0.1).toFixed(2)) });
  else useAppStore.setState({ zoomLevel: 1 });
  applyZoom();
}

// Content column width segment caps for the chat area (fractions of the screen
// width, not the app window): 50% is the default cap, 35% the second-stage
// shrink target. When the window narrows from wide, margins shrink continuously
// first; once pinned to 75px/side the content shrinks to 35% of screen width,
// then margins shrink to 20px/side, and finally the content keeps shrinking.
// JS reads screen.width and writes --col-max / --col-max-35.
export function updateContentColMax(): void {
  const w = window.screen.width;
  document.documentElement.style.setProperty("--col-max", Math.round(w * 0.5) + "px");
  document.documentElement.style.setProperty("--col-max-35", Math.round(w * 0.35) + "px");
}
// Measure the content column margin (dock left edge - main card left edge);
// hide the left message rail when the margin drops below 65px
export function updateRailVisibility(): void {
  const main = document.getElementById("main");
  const dock = document.querySelector(".dock");
  if (!main || !dock || dock.classList.contains("hidden")) return;
  const m = dock.getBoundingClientRect().left - main.getBoundingClientRect().left;
  main.classList.toggle("rail-off", m < 65);
}
// Fixed menu coordinate compensation: set zoom first, then divide it back out
export function placeMenu(menu: HTMLElement, visualLeft: number, visualTop: number): void {
  const zoom = useAppStore.getState().zoomLevel;
  (menu.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
  menu.style.left = visualLeft / zoom + "px";
  menu.style.top = visualTop / zoom + "px";
}

// ---------- Message rail tool summary (ported from ui/ringpop.js railToolText) ----------
// Tool message summary: tool name + command/file, comma-joined
// Subagent spawn summary for the task row's rail entry: spawn count once known (mirrors the
// TUI header meta "Task N agents"), else the flat form's agent type ⟦bracketed⟧
function taskRailSummary(args: Record<string, unknown>, details?: unknown): string {
  const d = details as { results?: unknown[]; progress?: unknown[] } | undefined;
  const count = d?.results?.length ?? d?.progress?.length ?? (Array.isArray(args.tasks) ? args.tasks.length : 0);
  if (count > 0) return t("chat.taskSummaryBatch", { count });
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  if (agent && agent !== "task") return `⟦${agent}⟧`;
  return typeof args.task === "string" ? args.task.split("\n")[0].trim() : "";
}
export function railToolText(item: ToolItem): string {
  if (item.group) {
    // Group titles and rail summaries share one source: read / terminal / device / change
    const label = ({ read: t("chat.labelReadGroup"), cmd: t("chat.labelTerminal"), device: t("chat.labelDevice") } as Record<string, string>)[item.name || ""] || t("chat.labelChange");
    // Group members are always tool entries at runtime (grouping is built in
    // items.tsx); discriminate by role to narrow
    return [label, ...item.group.flatMap((g) => (g.role === "tool" ? g.files || [] : []))].filter(Boolean).join(" · ");
  }
  const parts = [item.text];
  if (item.name === "wait") {
    // The raw tool name "wait" is meaningless in the rail; lead with the label and job counts
    parts.length = 0;
    parts.push(t("chat.labelWait"));
    const jobs = (item.details as { jobs?: { status?: string }[] } | undefined)?.jobs;
    if (jobs?.length) {
      const settled = jobs.filter((j) => j.status && j.status !== "running").length;
      parts.push(
        settled === 0
          ? t("chat.waitSummaryRunning", { count: jobs.length })
          : t("chat.waitSummarySettled", { settled, count: jobs.length }),
      );
    }
  }
  if (item.name === "task") {
    // Subagent spawn: replace the bare tool name with the label + spawn summary (name/brief/agent)
    parts.length = 0;
    parts.push(t("chat.labelTask"));
    const summary = taskRailSummary(item.args || {}, item.details);
    if (summary) parts.push(summary);
  }
  if (item.name === "yield") {
    // Subagent result submission: the bare tool name says nothing, so lead with the label
    // and the shared submission summary (failure reason / section labels / payload preview)
    parts.length = 0;
    parts.push(t("chat.labelYield"));
    const summary = yieldSummary(item.args);
    if (summary) parts.push(summary);
  }
  if (item.args?.command) parts.push(String(item.args.command));
  if (item.args?.query) parts.push(String(item.args.query));
  if (item.name === "hub") {
    const op = item.args?.op || "";
    const n = item.args?.name || item.args?.application || "";
    if (op || n) parts.push(`${op} ${n}`.trim());
  }
  if (item.files?.length) parts.push(item.files.join(t("chat.fileSep")));
  return parts.filter(Boolean).join(" · ");
}

// ---------- Global shell listeners (called once after App mounts) ----------
export function initShell(): void {
  themeMq.addEventListener("change", () => {
    if (themeMode === "system") applyTheme("system");
  });
  // Startup theme/motion restoration lives in main.tsx (before React mounts);
  // here only the system-mode media listener remains.
  attachResizer("left-resizer", "--left-w", 180, false);
  // Right panel drag handle (ZCode Side Pane size contract): min 240px, max 65% viewport width
  attachResizer("right-resizer", "--right-w", 240, true, 0.65);

  updateContentColMax();
  window.addEventListener("resize", () => {
    updateContentColMax();
    // On window resize, anchors of open composer menus go stale as buttons
    // move; just close them
    if (document.getElementById("composer")?.querySelector(".menu.open")) closeAllMenus();
  });
  // Dragging the window across screens does not always fire resize; poll as a fallback
  // .unref?.(): in the browser it returns a number with no side effect; under
  // happy-dom smoke (Node event loop) it does not block process exit
  const colMaxTimer = setInterval(updateContentColMax, 2000) as unknown as { unref?: () => void };
  colMaxTimer.unref?.();
  const mainEl = document.getElementById("main");
  if (mainEl && typeof ResizeObserver !== "undefined") new ResizeObserver(updateRailVisibility).observe(mainEl);
  document.addEventListener("keydown", (e) => {
    // The zoom modifier is exclusive: Ctrl on Windows (the Win key is too
    // system-occupied), ⌘ on macOS
    const modOnly = IS_WINDOWS ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey;
    if (!modOnly || e.altKey) return;
    if (e.key === "=" || e.key === "+") menuZoom(1);
    else if (e.key === "-") menuZoom(-1);
    else if (e.key === "0") menuZoom(0);
    else return;
    e.preventDefault();
  });

  // Global coordination of menu open/close (ported from the old window
  // click/blur -> closeAllMenus; React state-driven menus close via the
  // omp:close-menus event; toggle buttons that stopPropagation are unaffected)
  window.addEventListener("click", closeAllMenus);
  window.addEventListener("blur", closeAllMenus);
}
