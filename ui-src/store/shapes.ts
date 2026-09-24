// store 形状类型(纯类型模块):AppStore 组合各 slice 时需要的容器形状。
// 自 store.ts 平移,store.ts 以 re-export 转发保持外部 import 路径不变。
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

/** git 写操作回包的联合（staged/unstaged/discarded/committed/pushed 共分支消费） */
export type GitWriteFrame =
  | GitStagedFrame
  | GitUnstagedFrame
  | GitDiscardedFrame
  | GitCommittedFrame
  | GitPushedFrame;

/** 终端帧联合（terminal_created/data/exit 共分支消费，直推终端页订阅者） */
export type TerminalFrame = TerminalCreatedFrame | TerminalDataFrame | TerminalExitFrame;

/** UI 偏好（omp-ui-settings localStorage 合并后的运行时形状） */
export interface UiPrefs {
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  lineNumbers: boolean;
  codeWrap: boolean;
  showThinking: boolean;
  expandToolOutput: boolean;
  lang: string;
}

/** 右栏运行态（RightState 容器形状；分支树/条目树节点类型取自 types/frames） */
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
  navFrom: string | null; // navigate_tree 来源："fork"（output 尾部分叉）或 null（树页跳转），决定回执文案
  entryTreeNav: boolean; // navigate_tree 进行中（防连点）
  imageContent: ImageContentFrame | null; // read_image 回包（图片预览页消费）
  gitWrite: GitWriteFrame | null; // git 写操作回包（回包驱动按钮 busy 态收口）
}
