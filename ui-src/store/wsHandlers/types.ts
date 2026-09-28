// 帧处理器表类型：键 = HostFrame 全部成员的 type 字面量（漏键在合并表编译期报错，
// 等价旧 switch 的 default never 穷尽检查）；值 = 收窄到该帧的同步处理器。
// 处理器不收 set/get——域处理器经 useAppStore 直取（onMessage 同步分发，
// 帧到达时刻的 getState 与旧 switch 入口快照等价）。
import type { HostFrame } from "../../types/frames";

export type FrameType = HostFrame["type"];
export type FrameOf<K extends FrameType> = Extract<HostFrame, { type: K }>;
export type FrameHandler<K extends FrameType> = (msg: FrameOf<K>) => void;
export type HandlerMap = { [K in FrameType]: FrameHandler<K> };
export type HandlerSlice = Partial<HandlerMap>;
