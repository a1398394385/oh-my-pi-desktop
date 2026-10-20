// Terminal tab state for both docks. The right panel keeps one panel tab per terminal
// (store `rightTabs`); shared mode ("project shared terminals" pref) keeps those tab names
// in a per-project registry instead of the per-session slot, so every session of the same
// project sees the same set. The bottom dock's strip lives here as per-group tab lists
// ("global" = the historical cross-session strip; "p:<cwd>" when sharing). This module also
// hosts the Ctrl+Tab cycle for both docks and stays out of TerminalPage so the global
// binding can import it without pulling xterm into the startup chunk.
import { useSyncExternalStore } from "react";
import { useAppStore, setBump, activeOpen } from "../../../store";
import { isTerminalTab, openRightTab, newTerminalTabName } from "./tabs";

export interface BottomTabs {
  ids: string[];
  active: string;
}

const subs = new Set<() => void>();
let seq = 1;

function notify(): void {
  for (const f of subs) f();
}

/** Bottom-dock tab lists per group key. Groups materialize on first use with one tab. */
const bottomGroups = new Map<string, BottomTabs>();

function groupOf(key: string): BottomTabs {
  let g = bottomGroups.get(key);
  if (!g) {
    g = { ids: ["b" + seq], active: "b" + seq };
    seq += 1;
    bottomGroups.set(key, g);
  }
  return g;
}

function commit(key: string, next: BottomTabs): void {
  bottomGroups.set(key, next);
  notify();
}

export function useBottomTermTabs(groupKey: string): BottomTabs {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => groupOf(groupKey),
  );
}

/** PTY cleanup callback: registered by TerminalPage (xterm lives there). */
let disposeTab: ((scope: string, tab: string) => void) | null = null;
export function registerTermTabDisposer(fn: (scope: string, tab: string) => void): void {
  disposeTab = fn;
}

/** Project cwd used as the sharing key; mirrors TerminalPage's PTY cwd fallbacks. */
function projectCwd(): string {
  const st = useAppStore.getState();
  return activeOpen()?.cwd || st.newSessionProject || st.getAvailableProjects()[0]?.cwd || "";
}

/** Bottom-dock grouping: shared mode isolates one strip per project, otherwise the strip is
 *  the historical global one (PTYs stay per session either way). */
export function termGroupKey(): string {
  const st = useAppStore.getState();
  return st.uiPrefs.terminalShared === true ? "p:" + projectCwd() : "global";
}

/** PTY owner key: shared mode groups PTYs by project, otherwise per session path. */
export function termOwnerKey(sessionPath: string): string {
  return useAppStore.getState().uiPrefs.terminalShared === true ? "p:" + projectCwd() : sessionPath;
}

/** Right-panel terminal tab registry per project key (shared mode only). Persisted so a
 *  reload or HMR keeps the tab list; the PTYs themselves are rebuilt on demand. */
const PROJECT_TABS_KEY = "omp-terminal-project-tabs";

function loadProjectTabs(): Map<string, string[]> {
  try {
    const raw = localStorage.getItem(PROJECT_TABS_KEY);
    if (!raw) return new Map();
    const rows = JSON.parse(raw) as [string, string[]][];
    return new Map(rows.filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.filter((n) => isTerminalTab(n))]));
  } catch {
    return new Map();
  }
}

const projectTabs = loadProjectTabs();

function persistProjectTabs(): void {
  try {
    localStorage.setItem(PROJECT_TABS_KEY, JSON.stringify([...projectTabs]));
  } catch {
    // Quota failures only lose the tab list across reloads.
  }
}

/** Open one new terminal in the right panel: a fresh panel tab in both modes; shared mode
 *  also registers it under the current project so sibling sessions see it. */
export function openNewTermTab(): void {
  const st = useAppStore.getState();
  const shared = st.uiPrefs.terminalShared === true;
  const key = "p:" + projectCwd();
  const used = new Set([...st.rightTabs, ...(projectTabs.get(key) ?? [])]);
  // The persisted id counter can lag a restored registry (older builds, cleared storage):
  // skip taken names so a fresh tab never collides with a restored one.
  let name = newTerminalTabName();
  while (used.has(name)) name = newTerminalTabName();
  if (shared) {
    projectTabs.set(key, [...(projectTabs.get(key) ?? []), name]);
    persistProjectTabs();
  }
  openRightTab(name);
}

/** Drop a closed terminal tab from every project registry (tab ids are unique). */
export function forgetRightTermTab(name: string): void {
  let changed = false;
  for (const [key, list] of projectTabs) {
    if (!list.includes(name)) continue;
    projectTabs.set(key, list.filter((x) => x !== name));
    changed = true;
  }
  if (changed) persistProjectTabs();
}

/** Reconcile the live right-panel tabs with the current project's terminals (shared mode).
 *  Runs after a session switch: keeps this session's own non-terminal tabs, drops terminals
 *  registered to other projects, and appends the current project's missing ones. */
export function syncSharedRightTabs(): void {
  const st = useAppStore.getState();
  if (st.uiPrefs.terminalShared !== true) return;
  const key = "p:" + projectCwd();
  // Adopt terminals opened before sharing was turned on (or before a reload): they belong
  // to this project like any other shared terminal, so enabling the pref keeps them.
  const live = st.rightTabs.filter(isTerminalTab);
  const registered = projectTabs.get(key) ?? [];
  const adopt = live.filter((n) => !registered.includes(n));
  if (adopt.length) {
    projectTabs.set(key, [...registered, ...adopt]);
    persistProjectTabs();
  }
  const wanted = projectTabs.get(key) ?? [];
  const tabs = st.rightTabs.filter((n) => !isTerminalTab(n) || wanted.includes(n));
  const missing = wanted.filter((n) => !tabs.includes(n));
  // A slot restored after the terminals were filtered out carries no active tab: land on
  // the shared terminal instead of an empty start page (empty list keeps the start page).
  let active = st.rightTab;
  if (!active || !tabs.includes(active)) active = tabs[tabs.length - 1] ?? null;
  if (!missing.length && tabs.length === st.rightTabs.length && active === st.rightTab) return;
  useAppStore.setState({ rightTabs: [...tabs, ...missing], rightTab: active ?? null });
}

export function addBottomTermTab(groupKey: string): void {
  const id = "b" + seq;
  seq += 1;
  const g = groupOf(groupKey);
  commit(groupKey, { ids: [...g.ids, id], active: id });
}

export function activateBottomTermTab(groupKey: string, id: string): void {
  const g = groupOf(groupKey);
  if (g.active === id || !g.ids.includes(id)) return;
  commit(groupKey, { ids: g.ids, active: id });
}

export function closeBottomTermTab(groupKey: string, id: string): void {
  const g = groupOf(groupKey);
  // One terminal per dock is the floor: the last tab has nothing to fall back to
  if (g.ids.length < 2) return;
  const i = g.ids.indexOf(id);
  if (i === -1) return;
  const ids = g.ids.filter((x) => x !== id);
  const active = id === g.active ? ids[Math.min(i, ids.length - 1)] : g.active;
  disposeTab?.("bottom", id);
  commit(groupKey, { ids, active });
}

/** Dock the Ctrl+Tab binding targets: the pane holding focus, else the bottom dock (it
 *  renders over the center column), else the right panel while its active tab is a terminal.
 *  Overlays own the keyboard while open, so the docks behind them stay inert. */
function visibleTermScope(): "right" | "bottom" | null {
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const pane = el?.closest<HTMLElement>(".tpane");
  if (pane) return pane.dataset.scope === "bottom" ? "bottom" : "right";
  const st = useAppStore.getState();
  if (st.settingsOpen || st.paletteOpen) return null;
  if (st.bottomTerminalOpen && !st.narrow) return "bottom";
  if (!st.rightCollapsed && isTerminalTab(st.rightTab ?? "")) return "right";
  return null;
}

/** Ctrl+Tab / Ctrl+Shift+Tab: cycle the visible dock's tabs. Returns false when no dock is
 *  visible so the binding leaves the key alone. */
export function cycleTermTab(dir: 1 | -1): boolean {
  const scope = visibleTermScope();
  if (!scope) return false;
  if (scope === "bottom") {
    const key = termGroupKey();
    const g = groupOf(key);
    if (g.ids.length < 2) return true;
    const i = g.ids.indexOf(g.active);
    commit(key, { ids: g.ids, active: g.ids[(i + dir + g.ids.length) % g.ids.length] });
    return true;
  }
  const st = useAppStore.getState();
  const names = st.rightTabs.filter(isTerminalTab);
  if (names.length < 2) return true;
  const i = names.indexOf(st.rightTab ?? "");
  setBump({ rightTab: names[(i + dir + names.length) % names.length] });
  return true;
}
