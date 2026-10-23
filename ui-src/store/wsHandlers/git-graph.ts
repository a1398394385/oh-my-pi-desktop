// Git graph domain frames: reqId-echoed replies for the middle-column Git page
// (git_graph / git_commit_detail / git_commit_file_diff). Pure landing —
// resolution of the awaiting caller happens in store/git-graph.ts's pending map.
import { landGitGraphFrame } from "../git-graph";
import type { CommitFileDiffFrame, FileVersionsFrame, GitCommitDetailFrame, GitGraphFrame } from "../../types/frames";

export const gitGraphHandlers = {
  git_graph: (msg: GitGraphFrame) => landGitGraphFrame(msg),
  git_commit_detail: (msg: GitCommitDetailFrame) => landGitGraphFrame(msg),
  commit_file_diff: (msg: CommitFileDiffFrame) => landGitGraphFrame(msg),
  file_versions: (msg: FileVersionsFrame) => landGitGraphFrame(msg),
};

// Domain key set (for the exhaustive-assertion cross-check in index)
export type GitGraphFrames = keyof typeof gitGraphHandlers;
