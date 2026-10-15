// File and git domain frames: branch info for the new-session page, git status/diff, git write-op
// receipts, file page content, directory tree, image viewing, terminal frames pushed straight
// through. Moved over from store/ws.ts onMessage.
import { useAppStore } from "../index";
import { emitTerminalFrame } from "../terminal";
import { t } from "../../i18n";
import type { HandlerSlice, FrameOf } from "./types";

function onGitWrite(msg: FrameOf<"git_staged" | "git_unstaged" | "git_discarded" | "git_committed" | "git_pushed">) {
  useAppStore.setState((s) => ({ rightState: { ...s.rightState, gitWrite: msg } })); // the reply settles the button busy state
  if (msg.type === "git_staged" || msg.type === "git_unstaged" || msg.type === "git_discarded") {
    if (msg.ok) {
      if (msg.type === "git_discarded") useAppStore.getState().toast(t("notify.changesDiscarded"));
      useAppStore.getState().refreshGitDiff();
    } else useAppStore.getState().toast(msg.error ?? t("notify.gitOpFailed"));
  } else if (msg.type === "git_committed") {
    if (msg.ok) {
      useAppStore.getState().toast(t("notify.committed", { sha: (msg.commit ?? "").slice(0, 7) }));
      useAppStore.getState().refreshGitDiff();
    } else useAppStore.getState().toast(msg.error ?? t("notify.commitFailed"));
  } else {
    useAppStore.getState().toast(msg.ok ? t("notify.pushed") : (msg.error ?? t("notify.pushFailed")));
  }
}

// PTY output/exit frames: pushed straight to terminal-page subscribers (high frame rate, no bump-triggered full re-renders)
function onTerminalFrame(msg: FrameOf<"terminal_created" | "terminal_data" | "terminal_exit">) {
  emitTerminalFrame(msg);
}

export const filesHandlers = {
  git_branches(msg) {
    // cwd-routed: the same frame feeds the new-session picker and the main-column
    // header chip (active session's cwd) — both sinks are independent
    const st = useAppStore.getState();
    if (msg.cwd === st.newSessionProject) {
      useAppStore.setState({
        newSessionIsGit: !!msg.isGit,
        newSessionBranch: msg.current || "",
        newSessionBranches: msg.branches || [],
      });
    }
    const activeCwd = st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined;
    if (msg.cwd === activeCwd) {
      useAppStore.setState({
        headerGit: { cwd: msg.cwd, isGit: !!msg.isGit, current: msg.current, branches: msg.branches || [] },
      });
    }
  },
  git_branch_switched(msg) {
    const st = useAppStore.getState();
    const activeCwd = st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined;
    let matched = false;
    if (msg.cwd === st.newSessionProject) {
      matched = true;
      useAppStore.setState({ newSessionBranch: msg.branch });
    }
    if (msg.cwd === activeCwd && st.headerGit) {
      matched = true;
      useAppStore.setState({ headerGit: { ...st.headerGit, current: msg.branch } });
    }
    if (matched) useAppStore.getState().toast(t("notify.branchSwitched", { branch: msg.branch }));
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
    useAppStore.getState().setBriefDiff(msg.path, msg.diff); // the same reply also feeds the edit-row inline expansion
  },
  file_content(msg) {
    // File page full-content reply: write unconditionally (the user may have switched tabs away)
    useAppStore.setState((s) => {
      if (!s.fileView || s.fileView.path !== msg.path) return { fileViewPending: null };
      const fv = { ...s.fileView };
      if (msg.error) fv.error = msg.error;
      else Object.assign(fv, { text: msg.text, startLine: 1, lineNumbers: null, full: true, error: null });
      return { fileViewPending: null, fileView: fv };
    });
  },
  dir_list(msg) {
    // File-tree single-level reply: fill the cache (nested containers get fresh references so selectors subscribed to rightState notice)
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

// Domain key set (for the exhaustive-assertion cross-check in index)
export type FilesFrames = keyof typeof filesHandlers;
