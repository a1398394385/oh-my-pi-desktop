// P3 终态:数据层在 store/(index 组合六 slice:ui/session/projects/right/settings/ws
// + shapes/terminal/utils/groupExpand)。本文件是桶转发,保持外部 import 路径 "../store" 不变。
// 历史:S/useStore/notify 版本桥与容器 liveRef 代理已随组件全量 selector 化退役(2026-09-24)。
import { useAppStore } from "./store/index";
export { useAppStore, setBump } from "./store/index";
export { invoke } from "./store/ws";
export { onTerminalFrame } from "./store/terminal";
export { fmtTokens, fmtDurationMs } from "./store/utils";
export {
  activeOpen,
  findBySessionId,
  activateSession,
  evictOpenSessions,
  isJunkPlaceholder,
  toolExpandKey,
  ingestModels,
  getSupportedThinkingForModel,
  sealRunItems,
  dropQueueMsg,
  editQueueMsg,
  sendNowQueueMsg,
  requeueSteerMsg,
  updateSession,
  patchSessionItem,
} from "./store/session";

import type { DiskProject, DiskSessionRow, TodoPhase, QueuedMessage } from "./types/frames";
import type { ChatItem } from "./types/session";

// 兼容别名:旧本地类型名 → types/ 唯一来源(外部 import 路径零改动)
export type DiskSession = DiskSessionRow;
export type { DiskProject, TodoPhase } from "./types/frames";
export type SessionItem = ChatItem;
export type QueueMsg = QueuedMessage;
export type { OpenSession, SubagentState, SubagentToolCall, AppState } from "./types/session";

/** git 写操作回包联合 / 终端帧联合 / 形状类型（store/shapes.ts 转发,保持 import 路径） */
export type { GitWriteFrame, TerminalFrame, UiPrefs, RightState } from "./store/shapes";

/** setTimeout 句柄(DOM 与 Node 环境返回类型不同,统一别名;TS 环境含 Node 类型时返回 Timeout) */
export type TimerHandle = ReturnType<typeof setTimeout>;

// ---------- 方法型 slice action 的函数式转发（签名与旧模块函数一致） ----------
export const send = (obj: unknown): void => useAppStore.getState().send(obj);
export const setConnected = (ok: boolean, text: string): void => useAppStore.getState().setConnected(ok, text);
export const connect = (): Promise<void> => useAppStore.getState().connect();
export const toast = (msg: unknown): void => useAppStore.getState().toast(msg);
export const setComposerValue = (text: string, images: unknown[] | null = []): void =>
  useAppStore.getState().setComposerValue(text, images);
export const showWelcomeScreen = (preferredCwd?: string | null): void =>
  useAppStore.getState().showWelcomeScreen(preferredCwd);
export const hideWelcomeScreen = (): void => useAppStore.getState().hideWelcomeScreen();
export const setWelcomeProject = (cwd?: string): void => useAppStore.getState().setWelcomeProject(cwd);
export const initNewSessionModel = (force = false): void => useAppStore.getState().initNewSessionModel(force);
export const pickModelId = (id: string): void => useAppStore.getState().pickModelId(id);
export const pickThinkingLevel = (lv: string): void => useAppStore.getState().pickThinkingLevel(lv);
export const getAvailableProjects = (): { cwd: string; sessions: DiskSessionRow[] }[] =>
  useAppStore.getState().getAvailableProjects();
export const saveUnseen = (): void => useAppStore.getState().saveUnseen();
export const setBriefDiff = (path: string, diff: string | undefined): void =>
  useAppStore.getState().setBriefDiff(path, diff);
export const refreshGitDiff = (force = false): void => useAppStore.getState().refreshGitDiff(force);
export const openSettings = (pageId = "pg-general"): void => useAppStore.getState().openSettings(pageId);
export const closeSettings = (): void => useAppStore.getState().closeSettings();
export const refreshSettingsData = (): void => useAppStore.getState().refreshSettingsData();
