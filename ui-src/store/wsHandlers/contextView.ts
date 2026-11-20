// Context viewer domain frames: reqId-echoed replies for the standalone context
// viewer (context_view_open / list / entry / release). Pure landing — resolution
// of the awaiting caller happens in store/contextView.ts's pending map.
import { landContextViewFrame } from "../contextView";
import type {
  ContextViewEntryBodyFrame,
  ContextViewErrorFrame,
  ContextViewIndexFrame,
  ContextViewPageFrame,
  ContextViewReleasedFrame,
} from "../../types/frames";

export const contextViewHandlers = {
  context_view_index: (msg: ContextViewIndexFrame | ContextViewErrorFrame) => landContextViewFrame(msg),
  context_view_page: (msg: ContextViewPageFrame | ContextViewErrorFrame) => landContextViewFrame(msg),
  context_view_entry_body: (msg: ContextViewEntryBodyFrame | ContextViewErrorFrame) => landContextViewFrame(msg),
  context_view_released: (msg: ContextViewReleasedFrame | ContextViewErrorFrame) => landContextViewFrame(msg),
};

// Domain key set (for the exhaustive-assertion cross-check in index)
export type ContextViewFrames = keyof typeof contextViewHandlers;
