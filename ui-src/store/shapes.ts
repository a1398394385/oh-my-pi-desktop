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

/** Agent process display style: standard = today's folding, detailed = no read-only run
 * fold, expanded = no read-only run fold and no same-type event merging. */
export type AgentProcessStyle = "standard" | "detailed" | "expanded";

/** UI prefs (runtime shape: theme/motion + appearance fields + lang).
 * Persistence is file-first — omp-desktop.json's ui section is the source of
 * truth; the merged omp-ui-settings localStorage (plus the omp-theme /
 * omp-motion keys for those two) is only the first-frame render cache. */
export interface UiPrefs {
  theme: string; // ThemeId | "system" (expanded to accept custom theme IDs)
  motion: "system" | "on" | "off";
  agentProcessStyle: AgentProcessStyle;
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  lineNumbers: boolean;
  codeWrap: boolean;
  showThinking: boolean;
  expandToolOutput: boolean;
  ctxRingProbeCount?: boolean;
  /** Message-rail music-reactive ticks (drives railAudio.ts capture). */
  railMusic?: boolean;
  /** Capture device id (WASAPI endpoint on Windows; ignored on macOS); empty string = system default. */
  railMusicDevice?: string;
  /** Desktop alerts for background session events: system notification (undefined = on). */
  notifyDesktop?: boolean;
  /** Desktop alerts: platform alert sound (undefined = on). */
  notifySound?: boolean;
  lang: "zh-CN" | "en";
  terminalInheritProfile?: boolean;
  /** Experimental: every session of one project shares one set of terminal tabs (right dock
   *  and bottom dock independently) instead of per-session terminals. */
  terminalShared?: boolean;
  terminalFont?: string;
  /** Terminal font size in px (10-20); 13 = the historical hardcoded default. */
  terminalFontSize?: number;
}

/** Right panel runtime state (RightState container shape; entry-tree node types come from types/frames) */
export interface RightState {
  fileTreeDirs: Map<string, DirEntry[]>;
  fileTreeExpanded: Set<string>;
  fileTreePending: Set<string>;
  expandedDirs: Set<string>;
  commitMsg: string;
  imageContent: ImageContentFrame | null; // read_image reply (consumed by the image preview page)
  gitWrite: GitWriteFrame | null; // git write-op reply (the reply settles the button busy state)
}
