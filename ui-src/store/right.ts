// 右栏 slice：tab/视图模式、文件页、Git diff 三缓存、右栏运行态（文件树/会话树/条目树/git 写回执）。
// 自 store.ts 平移（P3 波 2）。briefDiffCache 的 LRU 闸门原样保留。
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { activeOpen } from "./session";
import type { GitStatusFile } from "../types/frames";
import type { FileViewState } from "../types/session";
import type { RightState } from "./shapes";

export interface RightSlice {
  rightTab: string | null;
  rightTabs: string[]; // 已打开 tab（有序）
  rightRecentClosed: { name: string; at: number }[]; // 最近关闭（新→旧，最多 5 条）：总览 popover「最近关闭」组数据源
  gitViewMode: string; // "tree" | …（右栏 Git Diff 视图）
  selectedFile: string | null;
  fileView: FileViewState | null;
  fileViewPending: string | null; // 请求中的文件路径
  briefDiffPending: string | null; // 请求中的行内 diff 路径
  todoCollapsed: boolean;
  rightState: RightState;
  gitDiffCache: { cwd: string | null; files: GitStatusFile[]; loading: boolean };
  fileDiffCache: { path: string | null; diff: string; loading: boolean };
  briefDiffCache: Map<string, string | undefined>; // 编辑行内联 diff,path -> 文本（LRU，见 setBriefDiff）
  setBriefDiff(path: string, diff: string | undefined): void;
  refreshGitDiff(force?: boolean): void;
}

/** 编辑行 diff 缓存上限（按文件数）。整份 diff 可达数百 KB，无上限会随编辑过的文件数线性增长。 */
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
  entryTree: null, // 会话内条目树（/tree）：{ sessionId, leafId, roots }
  entryTreePending: false,
  entryTreeFor: null,
  navFrom: null, // navigate_tree 来源："fork"（output 尾部分叉）或 null（树页跳转），决定回执文案
  entryTreeNav: false, // navigate_tree 进行中（防连点）
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
  // 右栏记忆为展开时进程卡初值收起（让位规则同 toggleRight/parts.jsx）
  todoCollapsed: localStorage.getItem("omp-right-collapsed") === "0",
  rightState: rightStateInit,
  gitDiffCache: { cwd: null, files: [], loading: false },
  fileDiffCache: { path: null, diff: "", loading: false },
  briefDiffCache: new Map(),

  /** 写入编辑行 diff 缓存并淘汰最久未用的文件（值可为 undefined：占位表示「已请求、待回包」） */
  setBriefDiff(path, diff) {
    useAppStore.setState((st) => {
      const briefDiffCache = new Map(st.briefDiffCache); // 变更换 Map 引用(LRU touch 语义保留)
      briefDiffCache.delete(path);
      briefDiffCache.set(path, diff);
      while (briefDiffCache.size > BRIEF_DIFF_MAX) {
        briefDiffCache.delete(briefDiffCache.keys().next().value as string);
      }
      return { briefDiffCache };
    });
  },

  // Git diff 预取（原 right.js refreshGitDiff 平移）
  refreshGitDiff(force = false) {
    const s = activeOpen();
    if (!s || !s.isGit) return; // 非 git 仓库不请求，不触发宿主报错
    const gitDiffCache = useAppStore.getState().gitDiffCache;
    if (!force && gitDiffCache.cwd === s.cwd) return;
    useAppStore.setState((st) => ({
      gitDiffCache: { ...st.gitDiffCache, loading: true, cwd: s.cwd },
    }));
    useAppStore.getState().send({ type: "get_git_diff", cwd: s.cwd });
  },
});
