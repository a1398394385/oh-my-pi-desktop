// Collab data-domain frames: the collab_state frame is the single landing
// shape for collab_start/join/leave replies, collab_state reads, and live
// participant pushes (host/rpc/collab.ts fans the same frame out over the
// session's uiSockets). A reply with error lands the message for the dialog
// and clears the busy gate; a role→guest transition triggers a transcript
// refetch because the SDK switched this session onto its replica file.
// Typed explicitly (not `satisfies HandlerSlice`): the HostFrame union member
// lands with the main session's registration (CollabStateFrame already lives
// in host/wire/frames-live.ts); the inferred table type stays spread-compatible
// with HandlerMap once the union member + index.ts registration land.
import { useAppStore } from "../index";
import type { CollabStateFrame } from "../../types/frames";

export const collabHandlers = {
  collab_state(msg: CollabStateFrame) {
    const s = useAppStore.getState();
    const prev = s.collabStates.get(msg.sessionId);
    const next = new Map(s.collabStates);
    next.set(msg.sessionId, msg.state);
    useAppStore.setState({
      collabStates: next,
      collabBusy: false,
      collabError: msg.error ? { sessionId: msg.sessionId, message: msg.error, at: Date.now() } : null,
    });
    // Guest replica activation: the session file changed under the open view
    // (handleResumeSession), so pull the fresh transcript once.
    if (msg.state.role === "guest" && prev?.role !== "guest") {
      s.send({ type: "get_messages", sessionId: msg.sessionId });
    }
  },
};

// Domain key set (for the exhaustive-assertion cross-check in index)
export type CollabFrames = keyof typeof collabHandlers;
