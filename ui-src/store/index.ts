// zustand 单一 store(P3 波 2:slice 组合式)。AppStore = 六个 slice 的交集组合;
// 字段与初值自 store.ts 平移,字段名零改动。各 slice 文件的模块级函数闭包引用本文件
// useAppStore(运行时调用,加载期无求值——ESM 循环安全)。
import { create } from "zustand";
import { createUiSlice, type UiSlice } from "./ui";
import { createSessionSlice, type SessionSlice } from "./session";
import { createProjectsSlice, type ProjectsSlice } from "./projects";
import { createRightSlice, type RightSlice } from "./right";
import { createSettingsSlice, type SettingsSlice } from "./settings";
import { createWsSlice, type WsSlice } from "./ws";

export interface AppStore extends UiSlice, SessionSlice, ProjectsSlice, RightSlice, SettingsSlice, WsSlice {}

export const useAppStore = create<AppStore>()((...a) => ({
  ...createUiSlice(...a),
  ...createSessionSlice(...a),
  ...createProjectsSlice(...a),
  ...createRightSlice(...a),
  ...createSettingsSlice(...a),
  ...createWsSlice(...a),
}));

/** 写入 helper(zustand setState 的直通别名;保留具名入口便于组件书写与后续收口) */
export function setBump(partial: Partial<AppStore>): void {
  useAppStore.setState(partial);
}

// 注:不挂全局 subscribe 自动兜底——subscribe 回调(即使微任务延迟)里再 set 会与 React 19 的
// useSyncExternalStore 同步级联成死循环(#185 / 异步死循环,均已实测);渲染触发一律靠显式 setState 换值/换引用。