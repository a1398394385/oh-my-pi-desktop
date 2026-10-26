// Worktree domain frames: reqId-echoed replies for the sidebar worktree
// dialogs (create/status/remove). Pure landing — resolution of the awaiting
// caller happens in store/worktree.ts's pending map. Handler params are typed
// against the local mirror interfaces (store/worktree.ts); once the wire
// frames are hooked up, the index spread typechecks them against the real
// HostFrame members (identical shapes).
import { landWorktreeFrame } from "../worktree";
import type { WorktreeCreatedReply, WorktreeRemovedReply, WorktreeStatusReply } from "../worktree";

export const worktreeHandlers = {
  worktree_created: (msg: WorktreeCreatedReply) => landWorktreeFrame(msg),
  worktree_status_result: (msg: WorktreeStatusReply) => landWorktreeFrame(msg),
  worktree_removed: (msg: WorktreeRemovedReply) => landWorktreeFrame(msg),
};

// Domain key set (for the exhaustive-assertion cross-check in index)
export type WorktreeFrames = keyof typeof worktreeHandlers;
