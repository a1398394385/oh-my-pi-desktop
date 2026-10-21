// Frame-handler table types: keys = the type literals of all HostFrame members (a missing key
// fails to compile in the merged table, equivalent to the old switch's default-never
// exhaustiveness check); values = synchronous handlers narrowed to that frame.
// Handlers don't take set/get — domain handlers fetch directly via useAppStore (onMessage
// dispatches synchronously, so getState at frame-arrival time is equivalent to the old switch
// entry snapshot).
import type { HostFrame } from "../../types/frames";

// Frames the host can still send but the UI deliberately ignores: the right-panel branch tree
// was removed, so session_tree replies (the cross-file branch family) have no landing spot —
// the host keeps the query for smoke-branch.ts. The right-panel capabilities dock was removed
// too, so its snapshot/incremental frames have no consumer until a display surface returns.
// Runtime dispatch still ignores them silently via the Partial lookup in index.ts.
// kicked is consumed at the dispatch entry in store/ws.ts (takeover gate), never by a domain table
export type IgnoredFrames = "session_tree" | "kicked" | "capabilities" | "capabilities_mcp" | "extension_status";
export type FrameType = Exclude<HostFrame["type"], IgnoredFrames>;
export type FrameOf<K extends FrameType> = Extract<HostFrame, { type: K }>;
export type FrameHandler<K extends FrameType> = (msg: FrameOf<K>) => void;
export type HandlerMap = { [K in FrameType]: FrameHandler<K> };
export type HandlerSlice = Partial<HandlerMap>;
