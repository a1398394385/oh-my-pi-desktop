// Right panel slice: tab/view mode, the file page, the three Git diff caches, right panel runtime
// state (file tree / branch tree / git write receipts).
// Moved over from store.ts (P3 wave 2). The briefDiffCache LRU gate is kept as-is.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { activeOpen } from "./session";
import { openRightTab, closeRightTab } from "../components/main/right/tabs";
import type { BrowserTabInfo, CapabilitiesSnapshot, GitStatusFile } from "../types/frames";
import type { FileViewState } from "../types/session";
import type { RightState } from "./shapes";

export interface RightSlice {
  rightTab: string | null;
  rightTabs: string[]; // open tabs (ordered)
  rightRecentClosed: { name: string; at: number }[]; // recently closed (new→old, max 5): data source of the overview popover's "recently closed" group
  gitViewMode: string; // "tree" | … (right-panel Git Diff view)
  selectedFile: string | null;
  fileView: FileViewState | null;
  fileViewPending: string | null; // file path with a request in flight
  briefDiffPending: string | null; // inline-diff path with a request in flight
  todoCollapsed: boolean;
  rightState: RightState;
  gitDiffCache: { cwd: string | null; files: GitStatusFile[]; loading: boolean };
  fileDiffCache: { path: string | null; diff: string; loading: boolean };
  briefDiffCache: Map<string, string | undefined>; // inline diffs for edit rows, path -> text (LRU, see setBriefDiff)
  capabilities: CapabilitiesSnapshot | null; // active session's subsystem runtime snapshot (capabilities page)
  capabilitiesFor: string | null; // sessionId the snapshot belongs to (stale on session switch until refetched)
  capabilitiesLoading: boolean;
  setBriefDiff(path: string, diff: string | undefined): void;
  browserTabs: BrowserTabInfo[]; // Agent built-in browser tabs (process-global mirror list, host browser_tabs pushes)
  browserViewTab: string | null; // tab name the live view mirrors
  browserPinned: boolean; // user picked a tab by hand; suspends follow-the-agent
  setBrowserViewTab(name: string | null, pinned: boolean): void;
  refreshGitDiff(force?: boolean): void;
  fetchCapabilities(): void;
}

/** Cap of the edit-row diff cache (by file count). A full diff can reach hundreds of KB; without a cap it grows linearly with the number of edited files. */
const BRIEF_DIFF_MAX = 30;

const rightStateInit: RightState = {
  fileTreeDirs: new Map(),
  fileTreeExpanded: new Set(),
  fileTreePending: new Set(),
  expandedDirs: new Set(),
  commitMsg: "",
  sessionTree: null,
  sessionTreePending: false,
  treeFor: null,
  imageContent: null,
  gitWrite: null,
};

export const createRightSlice: StateCreator<AppStore, [], [], RightSlice> = (set, get) => ({
  rightTab: null,
  rightTabs: [],
  rightRecentClosed: [],
  gitViewMode: "tree",
  selectedFile: null,
  fileView: null,
  fileViewPending: null,
  briefDiffPending: null,
  // Launch starts with the right panel collapsed, so the process card starts expanded
  todoCollapsed: false,
  rightState: rightStateInit,
  gitDiffCache: { cwd: null, files: [], loading: false },
  fileDiffCache: { path: null, diff: "", loading: false },
  briefDiffCache: new Map(),
  capabilities: null,
  capabilitiesFor: null,
  capabilitiesLoading: false,
  browserTabs: [],
  browserViewTab: null,
  browserPinned: false,

  // Live-view tab selection: pin=true marks an explicit user pick (suspends
  // follow-the-agent); the host switches the mirrored screencast target.
  setBrowserViewTab(name, pinned) {
    useAppStore.setState({ browserViewTab: name, browserPinned: pinned });
    if (name) get().send({ type: "browser_mirror_select", name });
  },
  /** Write to the edit-row diff cache and evict the least-recently-used file (the value may be undefined: a placeholder meaning "requested, awaiting reply") */
  setBriefDiff(path, diff) {
    useAppStore.setState((st) => {
      const briefDiffCache = new Map(st.briefDiffCache); // swap the Map reference on change (LRU touch semantics kept)
      briefDiffCache.delete(path);
      briefDiffCache.set(path, diff);
      while (briefDiffCache.size > BRIEF_DIFF_MAX) {
        briefDiffCache.delete(briefDiffCache.keys().next().value as string);
      }
      return { briefDiffCache };
    });
  },

  // Git diff prefetch (moved over from right.js refreshGitDiff)
  refreshGitDiff(force = false) {
    const s = activeOpen();
    if (!s || !s.isGit) return; // not a git repo: skip the request so the host doesn't error
    const gitDiffCache = useAppStore.getState().gitDiffCache;
    if (!force && gitDiffCache.cwd === s.cwd) return;
    useAppStore.setState((st) => ({
      gitDiffCache: { ...st.gitDiffCache, loading: true, cwd: s.cwd },
    }));
    useAppStore.getState().send({ type: "get_git_diff", cwd: s.cwd });
  },

  // Capabilities page fetch: on mount, session switch, and the sp-head refresh button.
  // MCP updates also arrive live afterwards via the capabilities_mcp frame.
  fetchCapabilities() {
    const s = activeOpen();
    if (!s) {
      useAppStore.setState({ capabilities: null, capabilitiesFor: null, capabilitiesLoading: false });
      return;
    }
    useAppStore.setState({ capabilitiesLoading: true });
    get().send({ type: "get_capabilities", sessionId: s.sessionId });
  },
});

// ---------- Unified per-session right-panel slots (single source of truth) ----------
// Each session — and the "welcome" pseudo-session for the no-session view — owns one
// slot holding its tab layout, collapse state, Agent Hub open state and session-scoped
// view state. The store fields (rightTabs/rightTab/rightRecentClosed/selectedFile/
// fileView/rightCollapsed/hubOpen/hubPrevTab/hubRightWasCollapsed) are the LIVE
// PROJECTION of the current slot: switching writes the outgoing
// projection into its slot and loads the incoming one; mid-session tab operations
// only touch the projection and are captured at the next switch. Slots persist to
// localStorage as one table; host-side resources (terminal PTY) register disposers
// that run when the slot is disposed (session delete / disk gone / LRU eviction /
// profile switch).

/** One session's right-panel slot. */
interface RightSlot {
  tabs: string[];
  active: string | null;
  recentClosed: { name: string; at: number }[];
  selectedFile: string | null;
  fileView: FileViewState | null;
  collapsed: boolean;
  // ---- Agent Hub (all runtime-only: a launch always starts on the chat view) ----
  /** Whether the middle-card Agent Hub is open for this session (per-session, like the tabs). */
  hubOpen: boolean;
  /** Right tab to restore when this session's hub closes (ui slice hubPrevTab). */
  hubPrevTab: string | null;
  /** Right-panel collapse state to restore when this session's hub closes (ui slice hubRightWasCollapsed). */
  hubWasCollapsed: boolean;
  /** Runtime-only host-resource teardown callbacks; never persisted. */
  disposers: Set<() => void>;
}

/** Pseudo-session key for the no-session view (welcome / new-session page). */
const WELCOME_SLOT = "welcome";

/** Slot table cap. openSessions LRU cap is 8; slots can outlive evicted sessions
 *  (they keep per-session panel memory), so cap higher to bound growth. */
const RIGHT_SLOT_MAX = 32;
const RIGHT_SLOT_STORAGE_KEY = "omp-right-slots";

/** Persisted slot row (runtime-only fields stripped). */
type PersistedSlot = Omit<RightSlot, "disposers" | "hubOpen" | "hubPrevTab" | "hubWasCollapsed">;

/** Restore persisted slots on module load. The legacy snapshot table is dropped
 *  wholesale (deliberate one-way switch, no migration); corrupted rows are skipped. */
function loadRightSlots(): Map<string, RightSlot> {
  try {
    localStorage.removeItem("omp-right-snapshots");
    const raw = localStorage.getItem(RIGHT_SLOT_STORAGE_KEY);
    if (!raw) return new Map();
    const pairs = JSON.parse(raw) as [string, PersistedSlot][];
    const out = new Map<string, RightSlot>();
    for (const [path, p] of pairs) {
      if (!p || !Array.isArray(p.tabs)) continue;
      // The auto-injected "hub" tab is never restored: hubOpen is runtime-only, so every
      // launch starts hubless and a persisted row carrying the tab would render the hub
      // detail page with no hub behind it (rows written by older builds included it).
      const rest = p.tabs.filter((t) => t !== "hub");
      out.set(path, {
        tabs: rest,
        active: p.active === "hub" ? rest[rest.length - 1] ?? null : p.active ?? null,
        recentClosed: p.recentClosed ?? [],
        selectedFile: p.selectedFile ?? null,
        fileView: p.fileView ?? null,
        collapsed: p.collapsed ?? true,
        hubOpen: false,
        hubPrevTab: null,
        hubWasCollapsed: false,
        disposers: new Set(),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

const rightSlots = loadRightSlots(); // insertion order = LRU order; save/restore touch

/** Serialize the slot table to localStorage (a few KB at most, written on
 *  save/restore/dispose — i.e. once per session switch, never per keystroke). */
function persistRightSlots(): void {
  try {
    const rows = [...rightSlots].map(
      ([path, s]) => [path, { tabs: s.tabs, active: s.active, recentClosed: s.recentClosed, selectedFile: s.selectedFile, fileView: s.fileView, collapsed: s.collapsed } satisfies PersistedSlot],
    );
    localStorage.setItem(RIGHT_SLOT_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Quota failures just lose persistence; in-memory behavior is unaffected.
  }
}

/** Write the live projection into session `path`'s slot (null = the welcome pseudo-slot). */
export function saveRightSlot(path: string | null): void {
  const key = path ?? WELCOME_SLOT;
  const st = useAppStore.getState();
  const disposers = rightSlots.get(key)?.disposers ?? new Set(); // slot update, not destruction: keep live disposers
  rightSlots.delete(key);
  rightSlots.set(key, {
    tabs: st.rightTabs.slice(),
    active: st.rightTab,
    recentClosed: st.rightRecentClosed.slice(),
    selectedFile: st.selectedFile,
    // Skip half-loaded views (empty text would restore stuck in loading) and image views
    // (they depend on the global imageContent frame) — neither is persisted
    fileView: st.fileViewPending || st.fileView?.image ? null : st.fileView,
    collapsed: st.rightCollapsed,
    hubOpen: st.hubOpen,
    hubPrevTab: st.hubPrevTab,
    hubWasCollapsed: st.hubRightWasCollapsed,
    disposers,
  });
  trimRightSlots();
  persistRightSlots();
}

/** LRU trim: while over cap, dispose the least-recently-touched slot (eldest insert). */
function trimRightSlots(): void {
  while (rightSlots.size > RIGHT_SLOT_MAX) disposeRightSlot(rightSlots.keys().next().value as string);
}

/** Load session `path`'s slot into the live projection (null = welcome). No slot yet
 *  (first activation): materialize one from the current projection — the layout is
 *  inherited (visual continuity) while session-scoped detail state clears. Transients
 *  of the previous session are always cleared. */
export function restoreRightSlot(path: string | null): void {
  const key = path ?? WELCOME_SLOT;
  const slot = rightSlots.get(key);
  if (slot) {
    rightSlots.delete(key);
    rightSlots.set(key, slot); // LRU touch
    persistRightSlots();
    useAppStore.setState({
      rightTabs: slot.tabs.slice(),
      rightTab: slot.active,
      rightRecentClosed: slot.recentClosed.slice(),
      selectedFile: slot.selectedFile,
      fileView: slot.fileView,
      rightCollapsed: slot.collapsed,
      // Hub is per-session: the incoming session brings its own open state (its "hub"
      // tab rides along in slot.tabs) and its own selection — hubSel indexes the live
      // subagent map, so the outgoing session's id never carries over.
      hubOpen: slot.hubOpen,
      hubSel: null,
      hubPrevTab: slot.hubPrevTab,
      hubRightWasCollapsed: slot.hubWasCollapsed,
      selectedSubagent: null,
      fileViewPending: null,
      briefDiffPending: null,
    });
    return;
  }
  const st = useAppStore.getState();
  // A fresh session inherits the layout but never the outgoing session's hub: hubOpen is
  // per-session, and its auto-injected tab would otherwise render a hub detail page with
  // no hub behind it (the right panel hides the tab, not the body).
  const tabs = st.rightTabs.filter((n) => n !== "hub");
  rightSlots.set(key, {
    tabs,
    active: st.rightTab === "hub" ? tabs[tabs.length - 1] ?? null : st.rightTab,
    recentClosed: st.rightRecentClosed.slice(),
    selectedFile: null,
    fileView: null,
    collapsed: st.rightCollapsed,
    hubOpen: false,
    hubPrevTab: null,
    hubWasCollapsed: false,
    disposers: new Set(),
  });
  persistRightSlots();
  // No slot yet: detail state clears; the hub fields AND the auto-injected tab go with
  // them — the projection must land in the store too, otherwise the incoming session
  // keeps the outgoing one's tab list while its own hubOpen is already false.
  useAppStore.setState({
    selectedFile: null,
    fileView: null,
    selectedSubagent: null,
    fileViewPending: null,
    briefDiffPending: null,
    rightTabs: tabs,
    rightTab: st.rightTab && tabs.includes(st.rightTab) ? st.rightTab : tabs[tabs.length - 1] ?? null,
    hubOpen: false,
    hubSel: null,
    hubPrevTab: null,
    hubRightWasCollapsed: false,
  });
}

/** Destroy session `path`'s slot: run its disposers (host resources — terminal PTY),
 *  drop it, persist. Session deletion / disk disappearance / profile switch. */
export function disposeRightSlot(path: string): void {
  const slot = rightSlots.get(path);
  if (!slot) return;
  rightSlots.delete(path);
  for (const fn of slot.disposers) fn();
  persistRightSlots();
}

/** Register a host-resource teardown callback on session `path`'s slot (pages owning
 *  host-side resources call this on mount; the slot exists by then — activation
 *  materializes it). */
export function registerSlotDisposer(path: string, fn: () => void): void {
  rightSlots.get(path)?.disposers.add(fn);
}

/** Directed auto-open: activate tab `name` inside a background session's slot without
 *  touching the displayed panel (browser mirror auto-open lands where the browsing
 *  session lives, not where the user is looking). */
export function openTabInSlot(path: string, name: string): void {
  let slot = rightSlots.get(path);
  if (!slot) {
    // Background-created session never activated in the UI: a minimal slot with just
    // this tab (inheriting the displayed layout would leak another session's panel)
    slot = { tabs: [name], active: name, recentClosed: [], selectedFile: null, fileView: null, collapsed: false, hubOpen: false, hubPrevTab: null, hubWasCollapsed: false, disposers: new Set() };
    rightSlots.set(path, slot);
  } else {
    rightSlots.delete(path);
    rightSlots.set(path, slot); // LRU touch
    if (!slot.tabs.includes(name)) slot.tabs = [...slot.tabs, name];
    slot.active = name;
    slot.collapsed = false; // auto-open implies "shown": expand on the next visit, same as the foreground branch
  }
  trimRightSlots();
  persistRightSlots();
}

/** Remove tab `name` from background session `path`'s slot (mirror auto-close
 *  on the owner's drain edge). Neighbor fallback and the last-tab collapse
 *  mirror the foreground closeRightTab semantics. */
export function closeTabInSlot(path: string, name: string): void {
  const slot = rightSlots.get(path);
  if (!slot) return;
  const i = slot.tabs.indexOf(name);
  if (i < 0) return;
  slot.tabs = slot.tabs.filter((t) => t !== name);
  if (slot.active === name) slot.active = slot.tabs[Math.min(i, slot.tabs.length - 1)] ?? null;
  if (slot.tabs.length === 0) slot.collapsed = true;
  persistRightSlots();
}

/** Clear every slot (profile switch = different session universe, paths no longer
 *  trustworthy); disposers run — host resources die with the table. */
export function clearRightSlots(): void {
  for (const slot of rightSlots.values()) for (const fn of slot.disposers) fn();
  rightSlots.clear();
  persistRightSlots();
}

// ---------- Agent browser mirror landing (browser_tabs pushes; process-global, not per-session) ----------

// Owners whose activation edge has already been surfaced. An owner is latched
// from its first tab until its tab list drains to zero — a manual collapse in
// between is never fought, and a fresh burst re-opens. Per-owner (not global):
// the mirror is session-scoped, so each session gets its own edge.
const browserOwnerLatch = new Set<string>();

/** Land a browser_tabs push: store the global list, then surface per-owner
 *  activation edges (a session's first tab) — the displayed session's edge
 *  opens the mirror right panel; a background session's edge pre-opens the
 *  mirror inside ITS slot without touching the displayed panel. The drain
 *  edge (a session's last tab closing) auto-closes that session's mirror tab
 *  the same way a manual close would. */
export function landBrowserTabs(tabs: BrowserTabInfo[]): void {
  useAppStore.setState({ browserTabs: tabs });
  const owners = new Set<string>();
  for (const tab of tabs) {
    if (tab.ownerPath) owners.add(tab.ownerPath);
  }
  const st = useAppStore.getState();
  for (const owner of owners) {
    if (browserOwnerLatch.has(owner)) continue;
    browserOwnerLatch.add(owner);
    if (owner === st.activePath) {
      if (st.rightTab !== "mirror" || !st.rightTabs.includes("mirror") || st.rightCollapsed) {
        openRightTab("mirror");
        if (st.rightCollapsed) useAppStore.setState({ rightCollapsed: false });
      }
    } else {
      openTabInSlot(owner, "mirror");
    }
  }
  for (const prev of browserOwnerLatch) {
    if (owners.has(prev)) continue;
    browserOwnerLatch.delete(prev);
    // Drain edge: close the mirror tab through the regular path (last-tab
    // close collapses the panel there); background owners close in-slot.
    if (prev === st.activePath) closeRightTab("mirror");
    else closeTabInSlot(prev, "mirror");
  }
}

/** Drop mirror UI state (host restart ready frame: the old list is stale until the next subscribe). */
export function resetBrowserMirrorUi(): void {
  browserOwnerLatch.clear();
  useAppStore.setState({ browserTabs: [], browserViewTab: null, browserPinned: false });
}
