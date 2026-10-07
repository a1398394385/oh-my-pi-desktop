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
  type TimerHandle, type AppStore,
} from "./store";
import { t } from "./i18n";
import { saveUiPrefs, applyAppearance } from "./appearance";
import type { ModelRoleEntry } from "./types/frames";
import { toggleSidebar, toggleRightPanel, closeAllMenus } from "./shell";
import { IS_WINDOWS, MOD, modDown } from "./platform";
import { computeSidebarSessionShortcuts, isSessionRunning } from "./components/main/sidebar/util";
import { stashClearedDraft } from "./components/composer/lexical/draft";

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

  // 0. agent hub: Esc closes it (and restores the right panel / composer focus)
  if (st.hubOpen) {
    st.closeHub();
    return true;
  }

  // 1. subagent session: Esc returns to the parent session's Agent Hub
  const s = activeOpen();
  if (s?.isSubagent && s.parentPath) {
    const subFilePath = st.activePath;
    const parentPath = s.parentPath;
    const parent = st.openSessions.get(parentPath);
    let matchedId: string | null = null;
    if (parent && subFilePath) {
      for (const [id, sub] of parent.subagents) {
        if (sub.sessionFile === subFilePath) {
          matchedId = id;
          break;
        }
      }
    }
    if (st.openSessions.has(parentPath)) {
      openSessionByPath(parentPath);
      useAppStore.getState().openHub();
      if (matchedId) useAppStore.getState().setHubSel(matchedId);
    } else {
      useAppStore.setState({ pendingOpenHub: true, pendingHubSel: matchedId });
      openSessionByPath(parentPath);
    }
    return true;
  }

  // 2. tree page: one esc switches back to messages
  if (st.mainViewMode === "tree") {
    st.setMainViewMode("chat");
    setTimeout(() => {
      const inp = document.querySelector("#composer #input") as HTMLElement | null;
      inp?.focus();
    }, 0);
    return true;
  }

  // Second Esc while in the clear confirmation stage: perform the clear (the
  // cleared draft goes to the recall stash while composer.recallClearedDrafts
  // is on -- same path as Ctrl+C in the composer)
  if (escArmedAction === "clear") {
    clearTimeout(doubleEscTimer);
    escArmedAction = null;
    setBump({ escArmedUntil: 0 });
    if (st.hostSettings?.values?.["composer.recallClearedDrafts"] !== false) {
      stashClearedDraft(st.activePath || "welcome");
    }
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

/** app.model.cycleForward / cycleBackward: cycle role models the CLI way —
 * through the settings cycleOrder (default smol/default/slow), each role
 * resolving to its model, unresolvable roles skipped, "default" falling back
 * to the current model. With a live session the host runs the exact CLI path
 * (session.cycleRoleModels: keeps role-slot tracking + explicit role thinking
 * levels); the creating-new state computes the same cycle locally.
 * While cycling, the model menu auto-opens in preview mode (cyclePreview):
 * only the cycle list is shown with the switched-to slot highlighted; it
 * auto-collapses after a 0.8s cycling pause or when Ctrl is released */
let cyclePreviewT: TimerHandle | undefined;

function closeCyclePreview(): void {
  clearTimeout(cyclePreviewT);
  cyclePreviewT = undefined;
  if (!useAppStore.getState().cyclePreview) return;
  setBump({ cyclePreview: null });
  closeAllMenus();
}

/** Resolve the current cycle slot, mirroring the host's getRoleModelCycle:
 * the previous preview slot wins while its role AND model still match
 * (= lastRole tracking); otherwise the first entry whose model equals the
 * current model; 0 as the last resort. Model-only matching alone would
 * mispredict when two roles resolve to the same model (e.g. default and a
 * custom role pointing at one model — the landing looks like a skip) */
function cycleIndex(
  entries: { role: string; model: string }[],
  cur: string,
  prev?: { activeRole: string; activeModel: string } | null,
): number {
  if (prev) {
    const i = entries.findIndex((e) => e.role === prev.activeRole);
    if (i !== -1 && entries[i].model === prev.activeModel) return i;
  }
  const byModel = entries.findIndex((e) => e.model === cur);
  return byModel === -1 ? 0 : byModel;
}

/** Open/re-arm the ctrl+p preview menu. next = the exact slot when the caller
 * computed it; otherwise a local prediction (instant highlight; the host's
 * cycle_model receipt corrects the first press) */
function openCyclePreview(
  st: AppStore,
  delta: number,
  cur: string,
  next?: { role: string; model: string },
): void {
  const entries = roleCycleEntries(st.hostSettings?.values.cycleOrder, st.modelRoles ?? [], cur);
  if (entries.length < 2) return; // nothing to cycle: no preview (the host reply toasts)
  const i = cycleIndex(entries, cur, st.cyclePreview);
  const target = next ?? entries[(i + delta + entries.length) % entries.length];
  if (!st.settingsOpen) {
    setBump({ cyclePreview: { entries, activeRole: target.role, activeModel: target.model }, menuSignal: { name: "model", seq: (st.menuSignal?.seq ?? 0) + 1 } });
  }
  clearTimeout(cyclePreviewT);
  cyclePreviewT = setTimeout(closeCyclePreview, 800);
}

function cycleModel(delta: number): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (s?.isSubagent) return;
  if (!s && !st.isCreatingNew) return;
  if (s) {
    st.send({ type: "cycle_model", sessionId: s.sessionId, direction: delta > 0 ? "forward" : "backward" });
    openCyclePreview(st, delta, s.model ?? "");
    return;
  }
  const cur = st.newSessionModel;
  const entries = roleCycleEntries(st.hostSettings?.values.cycleOrder, st.modelRoles ?? [], cur);
  if (entries.length === 0) {
    toast(t("composer.noModels"));
    return;
  }
  if (entries.length === 1) {
    toast(t("composer.onlyOneRoleModel"));
    return;
  }
  const next = entries[(cycleIndex(entries, cur, st.cyclePreview) + delta + entries.length) % entries.length];
  pickModelId(next.model);
  openCyclePreview(st, delta, cur, next);
}

/** Resolve the creating-new role cycle (same semantics as the base
 * getRoleModelCycle): cycleOrder roles -> resolved models, skipping roles
 * with no resolvable model; the "default" role falls back to the current
 * model when unassigned */
function roleCycleEntries(cycleOrder: unknown, roles: ModelRoleEntry[], cur: string): { role: string; model: string }[] {
  const order = Array.isArray(cycleOrder) ? (cycleOrder as string[]) : ["smol", "default", "slow"];
  const byId = new Map(roles.map((r) => [r.id, r]));
  const entries: { role: string; model: string }[] = [];
  for (const role of order) {
    const model = role === "default" ? (byId.get(role)?.resolved ?? cur) : byId.get(role)?.resolved;
    if (model) entries.push({ role, model });
  }
  return entries;
}

/** app.thinking.cycle: cycle through tiers supported by the current model (auto -> off -> each tier -> auto).
 * Same transient-menu treatment as ctrl+p: the think menu auto-opens (normal
 * content — it already ✓-marks the current tier) and auto-collapses after a
 * 0.8s cycling pause or when Shift is released */
let thinkMenuT: TimerHandle | undefined;

function closeThinkMenu(): void {
  clearTimeout(thinkMenuT);
  thinkMenuT = undefined;
  if (!useAppStore.getState().thinkMenuAuto) return;
  useAppStore.setState({ thinkMenuAuto: false });
  closeAllMenus();
}

function cycleThinking(): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (s?.isSubagent) return;
  if (!s && !st.isCreatingNew) return;
  const levels = getSupportedThinkingForModel(s?.model || st.newSessionModel);
  if (levels.length === 0) return;
  pickThinkingLevel(levels[(levels.indexOf(s?.thinking || st.newSessionThinking) + 1) % levels.length]);
  if (!st.settingsOpen) {
    setBump({ thinkMenuAuto: true, menuSignal: { name: "think", seq: (st.menuSignal?.seq ?? 0) + 1 } });
  }
  clearTimeout(thinkMenuT);
  thinkMenuT = setTimeout(closeThinkMenu, 800);
}

/** app.model.select: open the model selection menu (Composer consumes menuSignal);
 * a manual open always shows the full menu — clear any ctrl+p preview state */
function openModelMenu(): void {
  const st = useAppStore.getState();
  if (st.settingsOpen) return; // menus under the settings overlay are invisible, do not open
  const s = activeOpen();
  if (s?.isSubagent) return;
  if (!s && !st.isCreatingNew) return;
  setBump({ cyclePreview: null, menuSignal: { name: "model", seq: (st.menuSignal?.seq ?? 0) + 1 } });
}

/** app.plan.toggle: plan mode open/close (same routing as the permission mode menu:
 * live toggle in a session, local create_session intent on the new-session page) */
function togglePlanMode(): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (s?.isSubagent) return;
  if (s) send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: !s.planMode });
  else if (st.isCreatingNew) setBump({ newSessionPlanMode: !st.newSessionPlanMode });
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
      { keys: [MOD, "Alt", "B"], chords: ["alt+meta+b", "meta+alt+b"], get label() { return t("misc.keysToggleRight"); }, run: toggleSubagents },
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
      { keys: ["Ctrl", "C"], get label() { return t("misc.keysClearDraft"); } },
      { keys: ["Ctrl", "↑/↓"], get label() { return t("misc.keysRecallCleared"); } },
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
  {
    // OS / native-shell bindings: dispatched outside the web app (native menu
    // bar, window manager, Rust shell). Display only -- never re-bound here.
    get title() { return t("misc.keysGroupSystem"); },
    get desc() { return t("misc.keysGroupSystemDesc"); },
    items: [
      // Close-to-background: CloseRequested is intercepted in the Rust shell (lib.rs)
      { keys: IS_WINDOWS ? ["Alt", "F4"] : [MOD, "W"], get label() { return t("misc.keysSystemClose"); } },
      // macOS native menu bar only (build_menu is a no-op on other platforms)
      ...(IS_WINDOWS ? [] : [
        { keys: [MOD, "Q"], get label() { return t("misc.keysSystemQuit"); } },
        { keys: [MOD, "H"], get label() { return t("misc.keysSystemHide"); } },
        { keys: [MOD, "M"], get label() { return t("misc.keysSystemMinimize"); } },
      ]),
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

// Agent Hub open gesture: double-tap ← while focus sits anywhere in the middle card
// (#main) and the composer draft is empty — same 500ms window as the hub's close gesture
const HUB_LEFT_WINDOW_MS = 500;
let hubLastLeftAt = 0;
// Clicking the message flow never lands DOM focus inside #main (non-focusable content blurs
// to body), so a target-containment check alone makes the gesture unreachable after a click.
// Track the last pointerdown scope and let body focus inherit it.
let lastPointerInMain = false;

function onKeyDown(e: KeyboardEvent): void {
  // Modifier held state: holding Command (Ctrl on Windows) activates the
  // sidebar shortcut badge hints + transient expansion
  if (modDown(e)) {
    setCommandPressed(true);
  }

  // Agent Hub open gesture: bare ← inside #main with an empty draft. Checked before the
  // binding lookup (a bare arrow has no registered binding); while the hub is open its own
  // capture-phase listener owns ← (double-tap closes), so this only fires when closed.
  if (
    e.key === "ArrowLeft" &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.repeat
  ) {
    const st = useAppStore.getState();
    if (!st.hubOpen && !st.settingsOpen && !st.draftHasContent && e.target instanceof Node) {
      const main = document.getElementById("main");
      const inScope = e.target === document.body ? lastPointerInMain : !!main?.contains(e.target);
      if (inScope) {
        const now = Date.now();
        if (now - hubLastLeftAt <= HUB_LEFT_WINDOW_MS) {
          hubLastLeftAt = 0;
          e.preventDefault();
          const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
          if (s?.isSubagent && s.parentPath) {
            // Subagent session: double-tap ← returns to parent main session (aligned with TUI unfocus)
            openSessionByPath(s.parentPath);
            return;
          }
          st.openHub();
          return;
        }
        hubLastLeftAt = now;
      }
    }
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
  // ctrl+p preview / shift+tab think menu: releasing the modifier collapses them immediately
  if (e.key === "Control") closeCyclePreview();
  if (e.key === "Shift") closeThinkMenu();
}

function onBlur(): void {
  setCommandPressed(false);
}

/** Mount the global shortcut listeners (called once at App startup) */
export function initKeys(): void {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  // Pointer scope memory for the hub open gesture (see hubLastLeftAt above); capture phase so
  // it records even when inner controls stopPropagation
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerInMain = e.target instanceof Node && !!document.getElementById("main")?.contains(e.target);
    },
    true,
  );
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) onBlur();
  });
}
