// Right panel tab management: an ordered list of open tabs + the active one; after closing
// all, the active item is null (start page).
// Split out of RightPanel.jsx (page components also need openRightTab; a separate module
// avoids a circular dependency with the panel component).
// The tab list and recently-closed live in the store (rightTabs / rightRecentClosed); operations
// write fresh references, field subscriptions notify automatically (no _v bump needed).
import { useAppStore, setBump } from "../../../store";

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
  bgcmd: { label: "right.tabBgcmd", icon: "term" },
  file: { label: "right.tabFile", icon: "folderOpen" },
  tree: { label: "right.tabTree", icon: "fork" },
  terminal: { label: "right.tabTerminal", icon: "termBox" },
  browser: { label: "right.tabBrowser", icon: "globe" },
  caps: { label: "right.tabCaps", icon: "stats" },
  hub: { label: "right.hubTitle", icon: "agents" },
};

// Tabs the user cannot open or close by hand: the "hub" tab appears only while the
// middle-card Agent Hub is open (openHub injects it, closeHub removes it). The add menu
// hides them; tab close affordances (× / middle click) are disabled for them.
export const AUTO_TABS: ReadonlySet<string> = new Set(["hub"]);

// Tab close hooks: registered by pages with host-side resources (e.g. the terminal PTY);
// invoked to destroy them before the tab closes
// (used by TerminalPage: closing the "Terminal" tab kills the pty-bridge subprocess)
const tabCloseHooks: Record<string, () => void> = {};
export function registerTabCloseHook(name: string, fn: () => void): void {
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

/** Tab toggle shared by the bottom-bar button and the shortcut (Mod+Alt+B): open and current →
 * collapse the right panel; otherwise switch to that tab and expand */
export function toggleRightTab(name: string): void {
  const st = useAppStore.getState();
  if (!st.rightCollapsed && st.rightTab === name) {
    setBump({ rightCollapsed: true });
  } else {
    openRightTab(name); // not open → add to the tab list and activate
    setBump({ selectedFile: null, selectedSubagent: null, rightCollapsed: false, todoCollapsed: true }); // expanding the right panel collapses the process card out of the way (same as parts.jsx)
  }
}

export function closeRightTab(name: string): void {
  const st = useAppStore.getState();
  const i = st.rightTabs.indexOf(name);
  if (i < 0) return;
  tabCloseHooks[name]?.(); // destroy the page's host resources (PTY etc.) before removing from the list
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
