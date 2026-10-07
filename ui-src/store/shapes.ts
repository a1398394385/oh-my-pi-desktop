// Store shape types (pure type module): container shapes needed when AppStore composes the slices.
// Moved over from store.ts, which re-exports them so external import paths stay unchanged.
import type {
  DirEntry,
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

/** UI prefs (runtime shape: theme/motion + appearance fields + lang).
 * Persistence is file-first — omp-desktop.json's ui section is the source of
 * truth; the merged omp-ui-settings localStorage (plus the omp-theme /
 * omp-motion keys for those two) is only the first-frame render cache. */
export interface UiPrefs {
  theme: string; // ThemeId | "system" (expanded to accept custom theme IDs)
  motion: "system" | "on" | "off";
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  lineNumbers: boolean;
  codeWrap: boolean;
  showThinking: boolean;
  expandToolOutput: boolean;
  ctxRingProbeCount?: boolean;
  /** Message-rail music-reactive ticks (Windows only; drives railAudio.ts capture). */
  railMusic?: boolean;
  /** WASAPI render endpoint id; empty string = console default endpoint. */
  railMusicDevice?: string;
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
  imageContent: ImageContentFrame | null; // read_image reply (consumed by the image preview page)
  gitWrite: GitWriteFrame | null; // git write-op reply (the reply settles the button busy state)
}
