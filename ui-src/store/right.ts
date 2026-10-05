// Right panel slice: tab/view mode, the file page, the three Git diff caches, right panel runtime
// state (file tree / session tree / entry tree / git write receipts).
// Moved over from store.ts (P3 wave 2). The briefDiffCache LRU gate is kept as-is.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { activeOpen } from "./session";
import type { GitStatusFile } from "../types/frames";
import type { CapabilitiesSnapshot } from "../types/frames";
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
  entryTree: null, // in-session entry tree (/tree): { sessionId, leafId, roots }
  entryTreePending: false,
  entryTreeFor: null,
  navFrom: null, // origin of navigate_tree: "fork" (output-tail fork) or null (tree-page jump); decides the receipt message
  entryTreeNav: false, // navigate_tree in flight (double-click guard)
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
  // When the right panel is remembered as expanded, the process card starts collapsed (same yield rule as toggleRight/parts.jsx)
  todoCollapsed: localStorage.getItem("omp-right-collapsed") === "0",
  rightState: rightStateInit,
  gitDiffCache: { cwd: null, files: [], loading: false },
  fileDiffCache: { path: null, diff: "", loading: false },
  briefDiffCache: new Map(),
  capabilities: null,
  capabilitiesFor: null,
  capabilitiesLoading: false,

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

// ---------- Per-session right panel snapshots: save outgoing / restore incoming on switch ----------
// Right panel tab layout is remembered per session. Snapshots are persisted to
// localStorage so they survive app restarts (key: omp-right-snapshots, LRU order
// encoded as insertion order via array of [path, snapshot] pairs).

/** Per-session snapshot: tab layout + collapsed state + gitdiff file selection + file page detail state */
interface RightPanelSnapshot {
  rightTabs: string[];
  rightTab: string | null;
  rightRecentClosed: { name: string; at: number }[];
  selectedFile: string | null;
  fileView: FileViewState | null;
  rightCollapsed: boolean; // panel expand/collapse follows the session too
}

/** Snapshot table cap (per session count). openSessions LRU cap is 8; snapshots can
 *  outlive evicted sessions, so cap the table to prevent unbounded growth. */
const RIGHT_SNAPSHOT_MAX = 32;
const RIGHT_SNAPSHOT_STORAGE_KEY = "omp-right-snapshots";

/** Restore persisted snapshots on module load; corrupted data is dropped wholesale. */
function loadRightSnapshots(): Map<string, RightPanelSnapshot> {
  try {
    const raw = localStorage.getItem(RIGHT_SNAPSHOT_STORAGE_KEY);
    if (!raw) return new Map();
    const pairs = JSON.parse(raw) as [string, RightPanelSnapshot][];
    // Backfill for entries persisted before rightCollapsed joined the snapshot
    // (undefined must not leak into setState; collapsed is the safe default)
    for (const [, snap] of pairs) if (snap.rightCollapsed === undefined) snap.rightCollapsed = true;
    return new Map(pairs);
  } catch {
    return new Map();
  }
}

const rightSnapshots = loadRightSnapshots(); // insertion order = LRU order; restore re-inserts to touch

/** Serialize the snapshot table to localStorage (a few KB at most, written on
 *  save/restore/clear — i.e. once per session switch, never per keystroke). */
function persistRightSnapshots(): void {
  try {
    localStorage.setItem(RIGHT_SNAPSHOT_STORAGE_KEY, JSON.stringify([...rightSnapshots]));
  } catch {
    // Quota failures (extremely unlikely at this size) just lose persistence,
    // in-memory behavior is unaffected.
  }
}

/** Save the right panel snapshot for session `path` (call before activePath switches away; null = no session, skip) */
export function saveRightSnapshot(path: string | null): void {
  if (!path) return;
  const st = useAppStore.getState();
  rightSnapshots.delete(path);
  rightSnapshots.set(path, {
    rightTabs: st.rightTabs.slice(),
    rightTab: st.rightTab,
    rightRecentClosed: st.rightRecentClosed.slice(),
    selectedFile: st.selectedFile,
    // Skip half-loaded views (empty text would restore stuck in loading) and image views
    // (they depend on the global imageContent frame) — neither is snapshotted
    fileView: st.fileViewPending || st.fileView?.image ? null : st.fileView,
    rightCollapsed: st.rightCollapsed,
  });
  while (rightSnapshots.size > RIGHT_SNAPSHOT_MAX) {
    rightSnapshots.delete(rightSnapshots.keys().next().value as string);
  }
  persistRightSnapshots();
}

/** Restore the right panel for session `path` (call after activateSession switches in).
 *  No snapshot (first open / newly created / first switch back after restart): inherit the
 *  tab layout (visual continuity) but clear session-scoped detail state — selectedFile/
 *  fileView data belongs to the previous session. Transients of the previous session
 *  (pending flags / subagent selection) are always cleared. */
export function restoreRightPanel(path: string): void {
  const snap = rightSnapshots.get(path);
  if (snap) {
    rightSnapshots.delete(path);
    rightSnapshots.set(path, snap); // LRU touch
    persistRightSnapshots();
  }
  useAppStore.setState(
    snap ?? {
      selectedFile: null,
      fileView: null,
      selectedSubagent: null,
      fileViewPending: null,
      briefDiffPending: null,
    },
  );
}

/** Clear all snapshots (profile switch = different session universe, paths no longer trustworthy) */
export function clearRightSnapshots(): void {
  rightSnapshots.clear();
  persistRightSnapshots();
}
