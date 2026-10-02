// Store shape types (pure type module): container shapes needed when AppStore composes the slices.
// Moved over from store.ts, which re-exports them so external import paths stay unchanged.
import type {
  DirEntry,
  EntryTreeNode,
  GitCommittedFrame,
  GitDiscardedFrame,
  GitPushedFrame,
  GitStagedFrame,
  GitUnstagedFrame,
  ImageContentFrame,
  SessionBranch,
  TerminalCreatedFrame,
  TerminalDataFrame,
  TerminalExitFrame,
} from "../types/frames";

/** Union of git write-op replies (staged/unstaged/discarded/committed/pushed share one branch) */
export type GitWriteFrame =
  | GitStagedFrame
  | GitUnstagedFrame
  | GitDiscardedFrame
  | GitCommittedFrame
  | GitPushedFrame;

/** Terminal frame union (terminal_created/data/exit share one branch, pushed straight to terminal-page subscribers) */
export type TerminalFrame = TerminalCreatedFrame | TerminalDataFrame | TerminalExitFrame;

/** UI prefs (runtime shape after merging the omp-ui-settings localStorage) */
export interface UiPrefs {
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  lineNumbers: boolean;
  codeWrap: boolean;
  showThinking: boolean;
  expandToolOutput: boolean;
  lang: "zh-CN" | "en";
  terminalInheritProfile?: boolean;
  terminalFont?: string;
}

/** Right panel runtime state (RightState container shape; branch-tree/entry-tree node types come from types/frames) */
export interface RightState {
  fileTreeDirs: Map<string, DirEntry[]>;
  fileTreeExpanded: Set<string>;
  fileTreePending: Set<string>;
  expandedDirs: Set<string>;
  commitMsg: string;
  sessionTree: { sessionId: string | null; branches: SessionBranch[] } | null;
  sessionTreePending: boolean;
  treeFor: string | null;
  entryTree: { sessionId: string | null; leafId: string | null; roots: EntryTreeNode[] } | null;
  entryTreePending: boolean;
  entryTreeFor: string | null;
  navFrom: string | null; // origin of navigate_tree: "fork" (output-tail fork) or null (tree-page jump); decides the receipt message
  entryTreeNav: boolean; // navigate_tree in flight (double-click guard)
  imageContent: ImageContentFrame | null; // read_image reply (consumed by the image preview page)
  gitWrite: GitWriteFrame | null; // git write-op reply (the reply settles the button busy state)
}
