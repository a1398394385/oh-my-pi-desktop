// Window shell: theme (dark/light/system), motion, ⌘ and menu zoom, menu
// coordination, sidebar drag-resize, content column width segments, message
// rail visibility, fixed menu coordinate compensation, railToolText.
// Ported 1:1 from ui/shell.js + the railToolText section of ui/ringpop.js; no
// dependency on old ui/ modules.
// DOM side effects stay imperative; React components cooperate via the
// omp:close-menus / omp:zoom custom events.
import { useAppStore, send, setBump, effZoom, type TimerHandle } from "./store";
import { expandRightPanel } from "./components/main/right/tabs";
import type { ToolItem } from "./types/session";
import { IS_MAC, IS_WINDOWS } from "./platform";
import { yieldSummary } from "./components/chat/util";
import { t } from "./i18n";
import { THEMES, type ThemeId } from "./theme-registry";
import { REMOTE } from "./store/layout";

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
  // Remote clients are read-only on the host (spec §3.5): the theme stays a local
  // preference there instead of being rejected by the denylist
  if (!REMOTE) send({ type: "set_ui_prefs", theme: mode });
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

/** True when animations may run: data-motion forces on/off, absent follows the OS. Mirrors
 *  the CSS contract in global/animations.css — gate JS-driven animation (Web Animations,
 *  reveal timers) with this, since CSS rules cannot reach those. */
export function motionEnabled(): boolean {
  const mode = document.documentElement.dataset.motion;
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  if (rightCollapsed) setBump({ rightCollapsed });
  else expandRightPanel(null); // expandRightPanel owns the todoCollapsed yield + selection cleanup
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
      const dx = (ev.clientX - startX) / effZoom();
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

// ---------- Content column drag-resize ----------
// The center content column (messages + composer share --col-w, see center.css)
// can be widened/narrowed by dragging the gutter strips beside it. The drag
// writes a user override (--col-user-max) that --col-w caps with the four-stage
// shrink, so oversized stored values degrade gracefully on small windows.
// Both handles move the column symmetrically (dx × 2) to keep it centered.

// Restore the persisted override once at boot (initShell). The width itself applies to
// every page hosting the content column, so this must not wait for the session detail
// page (where the handles live) to mount — otherwise entering it would jump once.
export function restoreColWidth(): void {
  try {
    const saved = localStorage.getItem("omp-w---col-user-max");
    if (saved) document.documentElement.style.setProperty("--col-user-max", Math.round(+saved) + "px");
  } catch {}
}
// Handles are rendered only on the session detail page (MainColumn), so the mousedown
// wiring follows their mount instead of initShell's one-shot boot.
export function bindColResizer(): void {
  for (const side of ["left", "right"] as const) {
    (document.querySelector(`.col-resize-h[data-side="${side}"]`) as HTMLElement | null)?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const startX = e.clientX;
      // Current content column width: the dock when present, else any shared-rule
      // child of #stream (empty-state hint); 680 = the default on a typical window
      const col = document.querySelector<HTMLElement>("#main .dock") ?? document.querySelector<HTMLElement>("#stream > *");
      const startW = col?.offsetWidth ?? 680;
      let moved = false;
      const move = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / useAppStore.getState().zoomLevel;
        if (dx !== 0) moved = true;
        const outward = side === "right" ? dx : -dx;
        document.documentElement.style.setProperty("--col-user-max", Math.round(Math.max(480, startW + outward * 2)) + "px");
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
        el.classList.remove("dragging");
        // A press-only gesture must not overwrite the saved preference
        if (moved) {
          try {
            localStorage.setItem("omp-w---col-user-max", document.documentElement.style.getPropertyValue("--col-user-max").replace("px", ""));
          } catch {}
        }
      };
      document.body.classList.add("resizing");
      el.classList.add("dragging");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
}

// ---------- Cmd +/-/0 and native menu zoom ----------
// Only the four top containers are zoomed (sidebar / main / right / settings):
// zooming the whole body would double-scale position:fixed menus, misplacing
// the rendered context menus / theme menus and their click hit targets.
// (zoomTargets is lazily initialized: the targets do not exist before App mounts)
let zoomTargets: (HTMLElement | null)[] | null = null;

// Native macOS traffic lights: window points, while style.zoom scales every CSS px.
// tauri.conf.json's trafficLightPosition is applied once at window creation, so the
// lights must be re-placed whenever the zoom changes — the top-left blank strip they
// sit in is CSS-scaled and they have to stay on its center line.
// #navNew's viewport top is the strip's bottom edge in points (getBoundingClientRect
// reports the outer, unzoomed space even inside a style.zoom subtree); wry's placement
// puts the button center at y − 2.2 points, hence the offset back.
const TRAFFIC_CENTER_BIAS = 2.2;
function syncTrafficLights(): void {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!IS_MAC || !invoke) return;
  const stripBottom = document.getElementById("navNew")?.getBoundingClientRect().top ?? 50 * effZoom();
  void invoke("set_traffic_light_y", { y: stripBottom / 2 + TRAFFIC_CENTER_BIAS });
}

export function applyZoom(): void {
  // Re-resolve when a target is missing or detached: App can remount after a
  // language/key change (Root renders <App key={lang}>), leaving the cached
  // nodes orphaned and silently dropping every later zoom write
  if (!zoomTargets || zoomTargets.some((el) => !el || !el.isConnected)) zoomTargets = ["sidebar", "main", "right", "settings"].map((id) => document.getElementById(id));
  // style.zoom is a non-standard property (absent from TS lib.dom): assert the
  // write, semantics unchanged from the original. The narrow baseline folds in here:
  // phone zoom level 100% renders the 80% size the phone layout was tuned at.
  const z = effZoom();
  for (const el of zoomTargets) if (el) (el.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
  // Native macOS traffic lights keep physical coordinates while style.zoom scales CSS px;
  // publish the factor so UI pinned next to them (--top-toggle-*) divides back to points
  document.documentElement.style.setProperty("--ui-zoom", String(z));
  syncTrafficLights();
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
  try { localStorage.setItem("omp-zoom", String(useAppStore.getState().zoomLevel)); } catch {}
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
  // rect diff is visual (both boxes live in the zoomed subtree); the 65px threshold
  // is layout px, so divide the zoom factor back out
  const z = effZoom();
  const m = (dock.getBoundingClientRect().left - main.getBoundingClientRect().left) / z;
  main.classList.toggle("rail-off", m < 65);
}
// Fixed menu coordinate compensation: set zoom first, then divide it back out
export function placeMenu(menu: HTMLElement, visualLeft: number, visualTop: number): void {
  const zoom = effZoom();
  (menu.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
  menu.style.left = visualLeft / zoom + "px";
  menu.style.top = visualTop / zoom + "px";
}

// ---------- Message rail tool summary (ported from ui/ringpop.js railToolText) ----------
// Tool message summary: tool name + command/file, comma-joined
// Subagent spawn summary for the task row's rail entry: spawn count once known (mirrors the
// TUI header meta "Task N agents"), else the flat form's agent type [bracketed]
function taskRailSummary(args: Record<string, unknown>, details?: unknown): string {
  const d = details as { results?: unknown[]; progress?: unknown[] } | undefined;
  // Widest signal wins: async-only calls settle `results: []` and keep the batch in `progress`.
  const count = Math.max(d?.results?.length ?? 0, d?.progress?.length ?? 0, Array.isArray(args.tasks) ? args.tasks.length : 0);
  if (count > 0) return t("chat.taskSummaryBatch", { count });
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  if (agent && agent !== "task") return `[${agent}]`;
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
  // ACP context management: the rail leads with the label rather than the raw tool name
  // (recall_block also carries the block id it fetched back)
  const ctxLabel = (
    {
      context_status: t("chat.labelContextStatus"),
      compress_context: t("chat.labelCompressContext"),
      recall_block: t("chat.labelRecallBlock"),
    } as Record<string, string>
  )[item.name || ""];
  if (ctxLabel) {
    parts.length = 0;
    parts.push(ctxLabel);
    if (item.name === "recall_block" && item.args?.id) parts.push(String(item.args.id));
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
  restoreColWidth();

  updateContentColMax();
  // Apply the persisted zoom level (store hydrated from localStorage at init):
  // the zoom targets only exist now that App has mounted, and nothing else
  // calls applyZoom before the first menuZoom/shortcut
  applyZoom();
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

  // Soft keyboard (phones): iOS Safari keeps the layout viewport at full height when the
  // keyboard opens, so the height:100% shell leaves the composer underneath it and Safari
  // pans the visual viewport up to reach the focused field — the page reads as jumping while
  // typing. Feed visualViewport.height into --app-h (base.css) so the shell shrinks to what
  // is actually visible; Chromium already resizes the layout viewport (interactive-widget in
  // ui/index.html) and reports the same value here, so this is a no-op there.
  const vv = window.visualViewport;
  if (vv) {
    let lastAppH = 0;
    const syncAppHeight = () => {
      const h = Math.round(vv.height);
      if (h !== lastAppH) {
        lastAppH = h;
        document.documentElement.style.setProperty("--app-h", `${h}px`);
      }
      // iOS pans the layout viewport to reveal the focused field BEFORE the shell shrinks
      // (the pan arrives as a visualViewport scroll, not a resize). The pan outlives the
      // shrink and pushes the whole app above the visible area — the phone sees only the
      // composer and the keyboard. Undo it after every viewport change; window scroll is
      // otherwise unused (body is overflow:hidden, the chat scrolls inside #stream).
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    syncAppHeight();
    vv.addEventListener("resize", syncAppHeight);
    vv.addEventListener("scroll", syncAppHeight);
  }
}
