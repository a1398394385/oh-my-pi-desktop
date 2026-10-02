// Right panel slice: tab/view mode, the file page, the three Git diff caches, right panel runtime
// state (file tree / session tree / entry tree / git write receipts).
// Moved over from store.ts (P3 wave 2). The briefDiffCache LRU gate is kept as-is.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { activeOpen } from "./session";
import type { GitStatusFile } from "../types/frames";
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
  setBriefDiff(path: string, diff: string | undefined): void;
  refreshGitDiff(force?: boolean): void;
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
});

// ---------- Per-session right panel snapshots: save outgoing / restore incoming on switch ----------
// Right panel tab layout is remembered per session. Snapshots are in-memory only
// (app lifetime, not persisted across restarts).

/** Per-session snapshot: tab layout + gitdiff file selection + file page detail state */
interface RightPanelSnapshot {
  rightTabs: string[];
  rightTab: string | null;
  rightRecentClosed: { name: string; at: number }[];
  selectedFile: string | null;
  fileView: FileViewState | null;
}

/** Snapshot table cap (per session count). openSessions LRU cap is 8; snapshots can
 *  outlive evicted sessions, so cap the table to prevent unbounded growth. */
const RIGHT_SNAPSHOT_MAX = 32;
const rightSnapshots = new Map<string, RightPanelSnapshot>(); // insertion order = LRU order; restore re-inserts to touch

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
  });
  while (rightSnapshots.size > RIGHT_SNAPSHOT_MAX) {
    rightSnapshots.delete(rightSnapshots.keys().next().value as string);
  }
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
}
