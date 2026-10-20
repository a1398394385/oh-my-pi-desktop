// Right panel tab management: an ordered list of open tabs + the active one; after closing
// all, the active item is null (start page).
// Split out of RightPanel.jsx (page components also need openRightTab; a separate module
// avoids a circular dependency with the panel component).
// The tab list and recently-closed live in the store (rightTabs / rightRecentClosed); operations
// write fresh references, field subscriptions notify automatically (no _v bump needed).
import { useAppStore, setBump, type AppStore } from "../../../store";

// Right panel tab metadata (icon names from the ui/icons registry; labels hold i18n keys
// resolved via t() at render; module constants aren't recomputed on language switch, so
// translations must not be cached at the definition site)
interface TabMeta {
  label: string;
  icon: string;
}

export const TAB_META: Record<string, TabMeta> = {
  subagent: { label: "right.tabSubagent", icon: "agents" },
  gitdiff: { label: "Git Diff", icon: "branch" },
  commitdiff: { label: "right.tabCommitDiff", icon: "file" },
  bgcmd: { label: "right.tabBgcmd", icon: "term" },
  file: { label: "right.tabFile", icon: "folderOpen" },
  terminal: { label: "right.tabTerminal", icon: "termBox" },
  browser: { label: "right.tabBrowser", icon: "globe" },
  hub: { label: "right.hubTitle", icon: "agents" },
  btw: { label: "right.tabBtw", icon: "comment" },
};

// Terminal tabs are one panel tab each (`terminal:<id>`), so several terminals sit side by
// side in the tab head instead of nesting a second tab strip inside one "Terminal" tab.
const TERMINAL_PREFIX = "terminal:";
export const isTerminalTab = (name: string): boolean => name.startsWith(TERMINAL_PREFIX);
export const terminalTabId = (name: string): string => name.slice(TERMINAL_PREFIX.length);
/** Base metadata key: `terminal:<id>` -> `terminal`, every other tab is its own kind. */
export const tabKind = (name: string): string => (isTerminalTab(name) ? "terminal" : name);
export const tabMeta = (name: string): TabMeta | undefined => TAB_META[tabKind(name)];
let terminalSeq = (() => {
  try {
    return Number(localStorage.getItem("omp-terminal-seq")) || 0;
  } catch {
    return 0;
  }
})();
/** Fresh terminal tab name; ids are never reused so a reopened tab cannot attach to an old PTY.
 *  The counter is persisted: shared tab names survive reloads, so a fresh sequence would
 *  collide with a restored `terminal:1`. */
export function newTerminalTabName(): string {
  terminalSeq += 1;
  try {
    localStorage.setItem("omp-terminal-seq", String(terminalSeq));
  } catch {}
  return TERMINAL_PREFIX + terminalSeq;
}

/** Stable tab label number: the id carries it, so a tab keeps its title across sessions. */
export const terminalTabNumber = (name: string): number => Number(terminalTabId(name)) || 1;

// Tabs the user cannot open or close by hand: the "hub" tab appears only while the
// middle-card Agent Hub is open (openHub injects it, closeHub removes it). The add menu
// hides them; tab close affordances (× / middle click) are disabled for them.
export const AUTO_TABS: ReadonlySet<string> = new Set(["hub"]);

// Status tabs reached from the composer's icon only (the running-task counter): neither the
// add menu nor the empty-state launcher offers an entry, so the panel always shows live work
// rather than an empty page the user opened by hand.
export const COMPOSER_ONLY_TABS: ReadonlySet<string> = new Set(["bgcmd"]);

// Tabs opened by a page context instead of the add menu: the commit-diff viewer
// appears when a file row in the Git page is clicked. Still closable; hidden
// from the add menu because a bare tab with no target renders nothing.
export const CONTEXT_TABS: ReadonlySet<string> = new Set(["commitdiff"]);

// Tab close hooks: registered by pages with host-side resources (e.g. the terminal PTY);
// invoked to destroy them before the tab closes. Registered under the base kind and called
// with the full name so one hook serves every terminal tab instance.
const tabCloseHooks: Record<string, (name: string) => void> = {};
export function registerTabCloseHook(name: string, fn: (name: string) => void): void {
  tabCloseHooks[name] = fn;
}
// Cap on recently-closed entries (new → old)
const RECENT_MAX = 5;

export function openRightTab(name: string): void {
  if (name === "sessiontree") return;
  useAppStore.setState((st) => ({
    rightTabs: st.rightTabs.includes(name) ? st.rightTabs : [...st.rightTabs, name],
    // Remove from "recently closed" on reopen/open, keeping opened items out of the list
    rightRecentClosed: st.rightRecentClosed.some((x) => x.name === name)
      ? st.rightRecentClosed.filter((x) => x.name !== name)
      : st.rightRecentClosed,
    rightTab: name,
  }));
}

/** Expand the right panel, optionally opening/activating tab `name` first. Single owner of
 * the cross-module expand invariants: expanding yields the process card out of the way
 * (todoCollapsed: true) and clears stale detail selections (selectedFile/selectedSubagent).
 * `patch` carries caller-specific fields (fileView / selectedSubagent / fileDiffCache ...)
 * on top; passing a `name` registers the tab in the tab list via openRightTab, while callers
 * that must only switch the active tab (composer status tabs) pass rightTab via patch. */
export function expandRightPanel(name: string | null, patch?: Partial<AppStore>): void {
  if (name) openRightTab(name);
  setBump({ rightCollapsed: false, todoCollapsed: true, selectedFile: null, selectedSubagent: null, ...patch });
}

/** Tab toggle shared by the bottom-bar button and the shortcut (Mod+Alt+B): open and current →
 * collapse the right panel; otherwise switch to that tab and expand */
export function toggleRightTab(name: string): void {
  const st = useAppStore.getState();
  if (!st.rightCollapsed && st.rightTab === name) {
    setBump({ rightCollapsed: true });
  } else {
    expandRightPanel(name); // not open → add to the tab list and activate
  }
}

export function closeRightTab(name: string): void {
  const st = useAppStore.getState();
  const i = st.rightTabs.indexOf(name);
  if (i < 0) return;
  tabCloseHooks[tabKind(name)]?.(name); // destroy the page's host resources (PTY etc.) before removing from the list
  const tabs = st.rightTabs.slice();
  tabs.splice(i, 1);
  // Record into recently closed (dedup to top, cap 5)
  const recent = st.rightRecentClosed.filter((x) => x.name !== name);
  recent.unshift({ name, at: Date.now() });
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  useAppStore.setState({
    rightTabs: tabs,
    rightRecentClosed: recent,
    // Closing the current tab: the active item falls back to a neighboring tab; otherwise
    // unchanged (tab-list changes notify via field subscription)
    rightTab: st.rightTab === name ? tabs[Math.min(i, tabs.length - 1)] ?? null : st.rightTab,
    // Closing the last tab collapses the whole panel; every reopen path re-expands it
    ...(tabs.length === 0 ? { rightCollapsed: true } : {}),
  });
}

// Overview popover "recently closed" click-to-reopen: removed from the recent list then opened
// the regular way (removal inlined in openRightTab)
export function reopenRightTab(name: string): void {
  openRightTab(name);
}

// Tab head drag reorder (native HTML5 DnD): move name before `before`; null `before` means
// move to the end
export function moveRightTab(name: string, before: string | null): void {
  const tabs = useAppStore.getState().rightTabs;
  const from = tabs.indexOf(name);
  if (from < 0 || name === before) return;
  const next = tabs.slice();
  next.splice(from, 1);
  const to = before ? next.indexOf(before) : next.length;
  next.splice(to < 0 ? next.length : to, 0, name);
  useAppStore.setState({ rightTabs: next }); // fresh-reference write: components reading rightTabs re-render via field subscription
}
