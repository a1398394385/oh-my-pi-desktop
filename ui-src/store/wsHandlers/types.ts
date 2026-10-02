// Frame-handler table types: keys = the type literals of all HostFrame members (a missing key
// fails to compile in the merged table, equivalent to the old switch's default-never
// exhaustiveness check); values = synchronous handlers narrowed to that frame.
// Handlers don't take set/get — domain handlers fetch directly via useAppStore (onMessage
// dispatches synchronously, so getState at frame-arrival time is equivalent to the old switch
// entry snapshot).
import type { HostFrame } from "../../types/frames";

export type FrameType = HostFrame["type"];
export type FrameOf<K extends FrameType> = Extract<HostFrame, { type: K }>;
export type FrameHandler<K extends FrameType> = (msg: FrameOf<K>) => void;
export type HandlerMap = { [K in FrameType]: FrameHandler<K> };
export type HandlerSlice = Partial<HandlerMap>;
