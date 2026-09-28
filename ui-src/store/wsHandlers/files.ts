// 文件与 git 域帧：新建会话的分支信息、git 状态/diff、git 写操作回执、
// 文件页内容、目录树、图片查看、终端帧直推。自 store/ws.ts onMessage 平移。
import { useAppStore } from "../index";
import { emitTerminalFrame } from "../terminal";
import type { HandlerSlice, FrameOf } from "./types";

function onGitWrite(msg: FrameOf<"git_staged" | "git_unstaged" | "git_discarded" | "git_committed" | "git_pushed">) {
  useAppStore.setState((s) => ({ rightState: { ...s.rightState, gitWrite: msg } })); // 回包驱动按钮 busy 态收口
  if (msg.type === "git_staged" || msg.type === "git_unstaged" || msg.type === "git_discarded") {
    if (msg.ok) {
      if (msg.type === "git_discarded") useAppStore.getState().toast("已丢弃更改");
      useAppStore.getState().refreshGitDiff();
    } else useAppStore.getState().toast(msg.error ?? "git 操作失败");
  } else if (msg.type === "git_committed") {
    if (msg.ok) {
      useAppStore.getState().toast(`已提交 ${(msg.commit ?? "").slice(0, 7)}`);
      useAppStore.getState().refreshGitDiff();
    } else useAppStore.getState().toast(msg.error ?? "提交失败");
  } else {
    useAppStore.getState().toast(msg.ok ? "已推送" : (msg.error ?? "推送失败"));
  }
}

// PTY 输出/退出帧：直推终端页订阅者（帧高频，不走 bump 全量重渲染）
function onTerminalFrame(msg: FrameOf<"terminal_created" | "terminal_data" | "terminal_exit">) {
  emitTerminalFrame(msg);
}

export const filesHandlers = {
  git_branches(msg) {
    if (msg.cwd !== useAppStore.getState().newSessionProject) return;
    useAppStore.setState((s) => ({
      newSessionIsGit: !!msg.isGit,
      newSessionBranch: msg.current || "",
      newSessionBranches: msg.branches || [],
    }));
  },
  git_branch_switched(msg) {
    if (msg.cwd !== useAppStore.getState().newSessionProject) return;
    useAppStore.setState((s) => ({ newSessionBranch: msg.branch }));
    useAppStore.getState().toast(`已切换分支到 ${msg.branch}`);
  },
  git_status(msg) {
    const dirs = new Set<string>();
    for (const f of msg.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    useAppStore.setState((s) => ({
      gitDiffCache: { cwd: msg.cwd, files: msg.files, loading: false },
      rightState: { ...s.rightState, expandedDirs: dirs },
    }));
  },
  git_staged: onGitWrite,
  git_unstaged: onGitWrite,
  git_discarded: onGitWrite,
  git_committed: onGitWrite,
  git_pushed: onGitWrite,
  terminal_created: onTerminalFrame,
  terminal_data: onTerminalFrame,
  terminal_exit: onTerminalFrame,
  file_diff(msg) {
    useAppStore.setState((s) => ({
      fileDiffCache: { path: msg.path, diff: msg.diff, loading: false },
      briefDiffPending: s.briefDiffPending === msg.path ? null : s.briefDiffPending,
    }));
    useAppStore.getState().setBriefDiff(msg.path, msg.diff); // 同一份回包同时喂给编辑行内联展开
  },
  file_content(msg) {
    // 文件页全文件内容回包：无条件写入（用户可能已切走 tab）
    useAppStore.setState((s) => {
      if (!s.fileView || s.fileView.path !== msg.path) return { fileViewPending: null };
      const fv = { ...s.fileView };
      if (msg.error) fv.error = msg.error;
      else Object.assign(fv, { text: msg.text, startLine: 1, lineNumbers: null, full: true, error: null });
      return { fileViewPending: null, fileView: fv };
    });
  },
  dir_list(msg) {
    // 文件树单层回包：填充缓存（嵌套容器换新引用,订 rightState 的 selector 才能感知）
    useAppStore.setState((s) => ({
      rightState: {
        ...s.rightState,
        fileTreePending: new Set([...s.rightState.fileTreePending].filter((p) => p !== msg.path)),
        fileTreeDirs: new Map(s.rightState.fileTreeDirs).set(msg.path, msg.entries ?? []),
      },
    }));
  },
  image_content(msg) {
    useAppStore.setState((s) => ({ rightState: { ...s.rightState, imageContent: msg } }));
  },
} satisfies HandlerSlice;

// 域键集（供 index 的穷尽断言交叉验证）
export type FilesFrames = keyof typeof filesHandlers;
