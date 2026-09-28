// 帧处理器汇总表：五域合并。穷尽检查用键联合交叉断言（TS 对对象 spread 跳过
// 缺键检查，靠 HandlerMap 注解抓不住漏帧）：HostFrame 全部成员必须在某域键集
// 中，Missing 非 never 时 AssertNever 编译期报错——等价旧 switch 的 default never。
// 运行期未知帧（宿主超前版本）查表得 undefined，维持旧 default 的静默忽略语义。
// 守卫（stamped event 去重）在 store/ws.ts 的分发入口做，各域处理器只管业务落地。
import { configHandlers, type ConfigFrames } from "./config";
import { sessionHandlers, type SessionFrames } from "./session";
import { streamHandlers, type StreamFrames } from "./stream";
import { filesHandlers, type FilesFrames } from "./files";
import { settingsHandlers, type SettingsFrames } from "./settings";
import type { HandlerMap } from "./types";
import type { HostFrame } from "../../types/frames";

// 穷尽断言：漏接帧类型时 Missing 收窄为该字面量，AssertNever 约束不满足即报错
type Covered = ConfigFrames | SessionFrames | StreamFrames | FilesFrames | SettingsFrames;
type Missing = Exclude<HostFrame["type"], Covered>;
type AssertNever<T extends never> = T;
type _allFramesCovered = AssertNever<Missing>;

export const frameHandlers: HandlerMap = {
  ...configHandlers,
  ...sessionHandlers,
  ...streamHandlers,
  ...filesHandlers,
  ...settingsHandlers,
};

/** 单帧分发：表驱动（unknown 运行期帧静默忽略，同旧 switch default 兜底） */
export function dispatchFrame(msg: HostFrame): void {
  const h = (frameHandlers as Partial<Record<string, (m: HostFrame) => void>>)[msg.type];
  h?.(msg);
}
