// Global shortcuts: the registry (display data source for the settings page
// "Keyboard Shortcuts") + the single keydown dispatch.
// Key bindings copied from OMP CLI (oh-my-pi docs/keybindings.md and the app.*
// actions in packages/tui/src/app-keybindings.ts); only keys with matching
// desktop actions were migrated:
//   · TUI editor keys (Ctrl+A/E/K/U/W, Ctrl+Y, Alt+B/F, Ctrl+]/Alt+]) not
//     migrated -- the macOS WebView already has system conventions (⌘←/→ line
//     start/end, ⌥←/→ word move, ⌥⌫ delete word, ⌘A select all); overriding
//     them would break user expectations;
//   · Terminal-specific keys (Ctrl+Z suspend, Ctrl+D exit, Alt+L reset display,
//     Ctrl+G external editor, Ctrl+L live voice, space long-press STT,
//     Ctrl+Shift+V raw paste) have no matching capability, not migrated;
//   · app.history.search / app.retry / app.tools.toggleVisibility /
//     app.session.* have no desktop action, not migrated.
// Difference vs the CLI: in the CLI Esc owns the interrupt semantics outright,
// while in the GUI Esc is already consumed by the settings page/find bar/open
// popups, so the Esc routing triggers only when no other Esc consumer exists
// (see the guards in handleEsc).
// Keys bound inside components (⌘N new / ⌘, settings / ⌘F find / zoom / keys
// inside the composer) are only registered here for display, never re-bound --
// re-binding means double triggering.
import {
  useAppStore, setBump, send, toast, activeOpen, openSessionByPath, getAvailableProjects,
  getSupportedThinkingForModel, pickModelId, pickThinkingLevel, toolExpandKey,
  type TimerHandle,
} from "./store";
import { t } from "./i18n";
import { saveUiPrefs, applyAppearance } from "./appearance";
import { toggleSidebar, toggleRightPanel, closeAllMenus } from "./shell";
import { IS_WINDOWS, MOD, modDown } from "./platform";
import { computeSidebarSessionShortcuts, isSessionRunning } from "./components/sidebar/util";

// ---------- Actions ----------

// Double-Esc action window (500ms)
const DOUBLE_ESC_MS = 500;
let doubleEscTimer: TimerHandle | undefined;
let escArmedAction: "clear" | "tree" | null = null;

/** Global Esc routing:
 *  1. tree page: one esc switches back to messages;
 *  2. composer has text: two esc presses clear the composer;
 *  3. composer empty: two esc presses summon the tree (while generating, the
 *     first press aborts generation).
 */
function handleEsc(): boolean | undefined {
  const st = useAppStore.getState();
  if (st.settingsOpen || st.findOpen) return false; // settings / find bar consumes Esc first
  if (document.querySelector(".menu.open")) {
    closeAllMenus(); // close open popups first (composer menus / settings dropdowns)
    return false;
  }
  if (document.querySelector(".lp-mask")) {
    return false; // modal dialogs like the tree-jump confirmation close first
  }

  // 1. tree page: one esc switches back to messages
  if (st.mainViewMode === "tree") {
    st.setMainViewMode("chat");
    setTimeout(() => {
      const inp = document.querySelector("#composer #input") as HTMLElement | null;
      inp?.focus();
    }, 0);
    return true;
  }

  // Second Esc while in the clear confirmation stage: perform the clear
  if (escArmedAction === "clear") {
    clearTimeout(doubleEscTimer);
    escArmedAction = null;
    setBump({ escArmedUntil: 0 });
    st.setComposerValue("", []);
    return true;
  }

  // Second Esc while in the tree confirmation stage: summon the tree
  if (escArmedAction === "tree") {
    clearTimeout(doubleEscTimer);
    escArmedAction = null;
    st.setMainViewMode("tree");
    return true;
  }

  const s = activeOpen();
  const bashRunning = !!s?.items?.some((x) => x.role === "bash" && x.running);
  const hasText = !!(st.draftHasContent || (st.pendingFiles && st.pendingFiles.length > 0));

  // 2. Composer has text: the first Esc hints clearing (no toast; the send
  // button briefly flipping to the cancel icon is the hint)
  if (hasText) {
    escArmedAction = "clear";
    setBump({ escArmedUntil: Date.now() + DOUBLE_ESC_MS });
    clearTimeout(doubleEscTimer);
    doubleEscTimer = setTimeout(() => {
      escArmedAction = null;
      setBump({ escArmedUntil: 0 });
    }, DOUBLE_ESC_MS + 20);
    return false;
  }

  // 3. Composer empty: while generating, the first Esc aborts generation
  if (s && (s.streaming || bashRunning)) {
    send({ type: bashRunning && !s.streaming ? "bash_abort" : "abort_session", sessionId: s.sessionId });
    return true;
  }

  // 4. Composer empty: record the tree action window and silently wait for the
  // second Esc to summon the tree
  if (!s && !st.isCreatingNew) return false;
  escArmedAction = "tree";
  clearTimeout(doubleEscTimer);
  doubleEscTimer = setTimeout(() => {
    escArmedAction = null;
  }, DOUBLE_ESC_MS + 20);
  return false;
}

/** app.model.cycleForward / cycleBackward: move through models in host delivery
 * order (same order as the model menu) */
function cycleModel(delta: number): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (!s && !st.isCreatingNew) return;
  const ids = [...st.modelNames.keys()];
  if (ids.length === 0) {
    toast(t("composer.noModels"));
    return;
  }
  const cur = s?.model || st.newSessionModel;
  const i = ids.indexOf(cur);
  pickModelId(i < 0 ? ids[delta > 0 ? 0 : ids.length - 1] : ids[(i + delta + ids.length) % ids.length]);
}

/** app.thinking.cycle: cycle through tiers supported by the current model (auto -> off -> each tier -> auto) */
function cycleThinking(): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (!s && !st.isCreatingNew) return;
  const levels = getSupportedThinkingForModel(s?.model || st.newSessionModel);
  if (levels.length === 0) return;
  pickThinkingLevel(levels[(levels.indexOf(s?.thinking || st.newSessionThinking) + 1) % levels.length]);
}

/** app.model.select: open the model selection menu (Composer consumes menuSignal) */
function openModelMenu(): void {
  const st = useAppStore.getState();
  if (st.settingsOpen) return; // menus under the settings overlay are invisible, do not open
  if (!activeOpen() && !st.isCreatingNew) return;
  setBump({ menuSignal: { name: "model", seq: (st.menuSignal?.seq ?? 0) + 1 } });
}

/** app.plan.toggle: plan mode open/close (session only, same routing as the permission mode menu) */
function togglePlanMode(): void {
  const s = activeOpen();
  if (!s) return;
  send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: !s.planMode });
}

/** app.agents.hub: right sidebar open/close (same routing as the topbar right-panel button) */
function toggleSubagents(): void {
  toggleRightPanel();
}

/** app.thinking.toggle: the thinking block "expand while running, collapse when
 * done" switch (= appearance page "Show thinking process") */
function toggleThinking(): void {
  const showThinking = !useAppStore.getState().uiPrefs.showThinking;
  // Write a new object (selector components sense it by reference) + _v bump (the
  // old "write + notify"); the trailing toast carries its own bump
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking } }));
  saveUiPrefs();
  applyAppearance();
  // Sync the host setting: without writing it back, the next settings/ready
  // frame's hideThinkingBlock would overwrite and revert it
  send({ type: "set_setting", key: "hideThinkingBlock", value: !showThinking });
  // Immediate feedback: only follow thinking rows currently streaming (finished
  // collapsed rows and rows the user manually expanded stay untouched)
  const s = activeOpen();
  if (s) {
    for (const it of s.items) {
      if (it.role === "thinking" && it.streaming) it.expanded = showThinking;
    }
  }
  toast(t(showThinking ? "misc.thinkingExpandOn" : "misc.thinkingExpandOff"));
}

/** app.tools.expand: the tool output "expand while running, collapse when done" switch */
function toggleToolOutput(): void {
  const expandToolOutput = !useAppStore.getState().uiPrefs.expandToolOutput;
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, expandToolOutput } }));
  saveUiPrefs();
  // Immediate feedback: only follow tool rows currently running (finished rows
  // keep the user's current expand/collapse state)
  const s = activeOpen();
  if (s) {
    for (const it of s.items) {
      if (it.role === "tool" && it.running) it[toolExpandKey(it.name)] = expandToolOutput;
    }
  }
  toast(t(expandToolOutput ? "misc.toolExpandOn" : "misc.toolExpandOff"));
}

/** Command/Ctrl + 1~9: jump to a left-sidebar session (running ones first, top
 * up with unread ones when fewer than 9) */
function handleSessionJump(digit: string): boolean {
  const st = useAppStore.getState();
  if (st.settingsOpen) return false;
  if (document.querySelector(".lp-mask")) return false;

  // Take visible items from the same source as the sidebar badges (allProjects
  // order + history-project fallback), keeping key jumps consistent with display
  const shortcuts = computeSidebarSessionShortcuts({ ...st, availableProjects: getAvailableProjects() });
  for (const [path, d] of shortcuts.entries()) {
    if (d === digit) {
      openSessionByPath(path);
      setTimeout(() => {
        const inp = document.querySelector("#composer #input") as HTMLElement | null;
        inp?.focus();
      }, 0);
      return true;
    }
  }
  return false;
}

// ---------- Registry ----------
// keys = keycap display; chords = dispatch bindings (empty = bound inside a
// component, registered here for display only); run = action
export interface ShortcutItem {
  keys: string[];
  chords?: string[];
  label: string;
  run?: (e?: KeyboardEvent) => unknown; // actions judge context themselves: returning false = unhandled (do not intercept the default behavior)
}
export interface ShortcutGroup {
  title: string;
  desc: string;
  items: ShortcutItem[];
}
// Registry labels/titles/descs are getters: the module-level array re-reads the
// active language on every access, so consumers see translated copy after a
// language switch without rebuilding the registry.
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    get title() { return t("misc.keysGroupGeneral"); },
    get desc() { return t("misc.keysGroupGeneralDesc"); },
    items: [
      { keys: ["Esc"], chords: ["escape"], get label() { return t("misc.keysEscRoute"); }, run: handleEsc },
      { keys: [MOD, "N"], get label() { return t("misc.newTask"); } },
      { keys: [MOD, "1~9"], get label() { return t("misc.keysJumpSession"); } },
      { keys: [MOD, "B"], chords: ["meta+b"], get label() { return t("misc.keysToggleSidebar"); }, run: toggleSidebar },
      { keys: [MOD, ","], get label() { return t("misc.keysToggleSettings"); } },
      { keys: ["Esc"], get label() { return t("misc.keysCloseOverlays"); } },
      { keys: [MOD, "F"], get label() { return t("misc.keysFindInSession"); } },
      { keys: ["Alt", "A"], chords: ["alt+a"], get label() { return t("misc.keysToggleRight"); }, run: toggleSubagents },
    ],
  },
  {
    get title() { return t("misc.keysGroupModel"); },
    get desc() { return t("misc.keysGroupModelDesc"); },
    items: [
      { keys: ["Ctrl", "P"], chords: ["ctrl+p"], get label() { return t("misc.keysNextModel"); }, run: () => cycleModel(1) },
      { keys: ["Ctrl", "⇧", "P"], chords: ["ctrl+shift+p"], get label() { return t("misc.keysPrevModel"); }, run: () => cycleModel(-1) },
      { keys: ["Alt", "M"], chords: ["alt+m"], get label() { return t("misc.keysOpenModelMenu"); }, run: openModelMenu },
      { keys: ["⇧", "Tab"], chords: ["shift+tab"], get label() { return t("misc.keysCycleThinking"); }, run: cycleThinking },
      { keys: ["Ctrl", "T"], chords: ["ctrl+t"], get label() { return t("misc.keysThinkingExpand"); }, run: toggleThinking },
      { keys: ["Alt", "⇧", "P"], chords: ["alt+shift+p"], get label() { return t("misc.keysPlanToggle"); }, run: togglePlanMode },
    ],
  },
  {
    get title() { return t("misc.keysGroupDisplay"); },
    get desc() { return t("misc.keysGroupDisplayDesc"); },
    items: [
      { keys: ["Ctrl", "O"], chords: ["ctrl+o"], get label() { return t("misc.keysToolExpand"); }, run: toggleToolOutput },
    ],
  },
  {
    get title() { return t("misc.keysGroupComposer"); },
    get desc() { return t("misc.keysGroupComposerDesc"); },
    items: [
      { keys: ["↵"], get label() { return t("misc.keysSend"); } },
      { keys: ["⇧", "↵"], get label() { return t("misc.keysNewline"); } },
      { keys: ["Ctrl", "↵"], get label() { return t("misc.keysSteer"); } },
      { keys: ["Ctrl", "Q"], get label() { return t("misc.keysQueue"); } },
      { keys: ["Alt", "↑"], get label() { return t("misc.keysRecall"); } },
    ],
  },
  {
    // Keys inside the tree page are bound in the SessionTreeStream component;
    // registered here for display only (no re-binding -- re-binding means double triggering)
    get title() { return t("misc.keysGroupTree"); },
    get desc() { return t("misc.keysGroupTreeDesc"); },
    items: [
      { keys: ["↑", "↓"], get label() { return t("misc.keysTreeMove"); } },
      { keys: ["↵"], get label() { return t("misc.keysTreeJump"); } },
    ],
  },
  {
    get title() { return t("misc.keysGroupZoom"); },
    get desc() { return t("misc.keysGroupZoomDesc"); },
    items: [
      { keys: [MOD, "+"], get label() { return t("misc.keysZoomIn"); } },
      { keys: [MOD, "−"], get label() { return t("misc.keysZoomOut"); } },
      { keys: [MOD, "0"], get label() { return t("misc.keysZoomReset"); } },
    ],
  },
];

// ---------- Dispatch ----------
const BINDINGS = new Map<string, ShortcutItem>();
for (const g of SHORTCUT_GROUPS) {
  for (const it of g.items) for (const c of it.chords ?? []) BINDINGS.set(c, it);
}

/** Normalize the key: letters/digits take e.code (macOS Option combos rewrite
 * e.key, e.g. ⌥P yields "π") */
function chordOf(e: KeyboardEvent): string {
  const code = e.code || "";
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit([0-9])$/.exec(code);
  const key = letter ? letter[1].toLowerCase() : digit ? digit[1] : (e.key || "").toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  parts.push(key);
  return parts.join("+");
}

// ---------- ⌘ held state and transient project expansion ----------
// While ⌘ is held, collapsed projects containing running sessions expand
// transiently (pure frontend visual state: no set_project_expanded sent, nothing
// persisted) so running session rows and badges stay visible; on release only
// the auto-expanded batch is reverted -- manual expand/collapse done by the user
// during the hold (via the normal ProjGroup path, persistence included) is
// unaffected.
let autoExpandedProjects: Set<string> | null = null;

function setCommandPressed(on: boolean): void {
  const st = useAppStore.getState();
  if (st.isCommandPressed === on) return;
  if (!on) {
    if (autoExpandedProjects) {
      const cur = useAppStore.getState();
      useAppStore.setState({
        isCommandPressed: false,
        expandedProjects: new Set([...cur.expandedProjects].filter((c) => !autoExpandedProjects!.has(c))),
      });
      autoExpandedProjects = null;
    } else {
      useAppStore.setState({ isCommandPressed: false });
    }
    return;
  }
  // Manage mode is already fully expanded; no transient expansion needed
  const toExpand = new Set<string>();
  if (!st.isProjectManageMode) {
    for (const p of getAvailableProjects()) {
      if (st.expandedProjects.has(p.cwd)) continue;
      if (p.sessions.some((s) => isSessionRunning(st.openSessions.get(s.path)))) toExpand.add(p.cwd);
    }
  }
  autoExpandedProjects = toExpand.size > 0 ? toExpand : null;
  useAppStore.setState(
    toExpand.size > 0
      ? { isCommandPressed: true, expandedProjects: new Set([...st.expandedProjects, ...toExpand]) }
      : { isCommandPressed: true },
  );
}

function onKeyDown(e: KeyboardEvent): void {
  // Modifier held state: holding Command (Ctrl on Windows) activates the
  // sidebar shortcut badge hints + transient expansion
  if (modDown(e)) {
    setCommandPressed(true);
  }

  // Shortcut session jump: Command/Ctrl + 1~9 (⌘0 is reserved for zoom reset,
  // bound in the shell.ts global listener)
  if (modDown(e) && !e.altKey && !e.shiftKey) {
    const codeM = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    const digit = codeM?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null);
    if (digit && handleSessionJump(digit)) {
      e.preventDefault();
      return;
    }
  }

  let item = BINDINGS.get(chordOf(e));
  // ⌘ bindings fall to Ctrl on Windows: when the original chord misses, retry
  // with ctrl swapped to meta (existing ctrl+X bindings already matched with
  // priority in the previous step, unaffected)
  if (!item && IS_WINDOWS && e.ctrlKey && !e.metaKey) {
    item = BINDINGS.get(chordOf(e).replace("ctrl", "meta"));
  }
  if (!item?.run) return;
  if (item.run(e) === false) return; // actions judge context themselves: unhandled means do not intercept the default behavior
  e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  // Close the visual hints and revert transiently expanded projects when the modifier is released
  if (!modDown(e) || (IS_WINDOWS ? e.key === "Control" : e.key === "Meta")) {
    setCommandPressed(false);
  }
}

function onBlur(): void {
  setCommandPressed(false);
}

/** Mount the global shortcut listeners (called once at App startup) */
export function initKeys(): void {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) onBlur();
  });
}
