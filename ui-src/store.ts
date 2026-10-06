// P3 end state: the data layer lives in store/ (index composes eight slices:
// ui/session/projects/right/settings/models/entry-tree/ws + shapes/terminal/utils/groupExpand).
// This file is a barrel re-export keeping the external import path "../store"
// unchanged. History: the S/useStore/notify version bridges and the container
// liveRef proxy were retired when components moved fully to selector-based
// subscriptions (2026-09-24).
import { useAppStore } from "./store/index";
export { useAppStore, setBump } from "./store/index";
export type { AppStore } from "./store/index";
export { invoke } from "./store/ws";
export { onTerminalFrame } from "./store/terminal";
export { fmtTokens, fmtDurationMs, pathBase } from "./store/utils";
export {
  activeOpen,
  findBySessionId,
  activateSession,
  openSessionByPath,
  evictOpenSessions,
  isJunkPlaceholder,
  toolExpandKey,
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

// Compatibility aliases: old local type names → the single source in types/ (zero changes to external import paths)
export type DiskSession = DiskSessionRow;
export type { DiskProject, TodoPhase } from "./types/frames";
export type SessionItem = ChatItem;
export type QueueMsg = QueuedMessage;
export type { OpenSession, SubagentState, SubagentToolCall, AppState } from "./types/session";

/** Git write-response union / terminal frame union / shape types (forwarded from store/shapes.ts, import path preserved) */
export type { GitWriteFrame, TerminalFrame, UiPrefs, RightState } from "./store/shapes";

/** setTimeout handle (DOM and Node environments return different types; unified alias — returns Timeout when the TS environment includes Node types) */
export type TimerHandle = ReturnType<typeof setTimeout>;

// ---------- Functional forwarding of method-style slice actions (signatures match the old module functions) ----------
export const send = (obj: unknown): void => useAppStore.getState().send(obj);
export const setConnected = (ok: boolean, text: string): void => useAppStore.getState().setConnected(ok, text);
export const connect = (): Promise<void> => useAppStore.getState().connect();
export const toast = (msg: unknown): void => useAppStore.getState().toast(msg);
export const setComposerValue = (text: string, images: unknown[] | null = []): void =>
  useAppStore.getState().setComposerValue(text, images);
export const setMainViewMode = (mode: "chat" | "tree"): void =>
  useAppStore.getState().setMainViewMode(mode);
export const showWelcomeScreen = (preferredCwd?: string | null): void =>
  useAppStore.getState().showWelcomeScreen(preferredCwd);
export const hideWelcomeScreen = (): void => useAppStore.getState().hideWelcomeScreen();
export const setWelcomeProject = (cwd?: string): void => useAppStore.getState().setWelcomeProject(cwd);
export const initNewSessionModel = (force = false): void => useAppStore.getState().initNewSessionModel(force);
export const pickModelId = (id: string, role?: string): void => useAppStore.getState().pickModelId(id, role);
export const pickThinkingLevel = (lv: string): void => useAppStore.getState().pickThinkingLevel(lv);
export type AvailableProject = { cwd: string; remote?: boolean; remoteLabel?: string; sessions: DiskSessionRow[] };
export const getAvailableProjects = (): AvailableProject[] =>
  useAppStore.getState().getAvailableProjects();
export const saveUnseen = (): void => useAppStore.getState().saveUnseen();
export const expandProject = (cwd: string): void => useAppStore.getState().expandProject(cwd);
export const setBriefDiff = (path: string, diff: string | undefined): void =>
  useAppStore.getState().setBriefDiff(path, diff);
export const refreshGitDiff = (force = false): void => useAppStore.getState().refreshGitDiff(force);
export const openSettings = (pageId = "pg-general"): void => useAppStore.getState().openSettings(pageId);
export const closeSettings = (): void => useAppStore.getState().closeSettings();
export const refreshSettingsData = (): void => useAppStore.getState().refreshSettingsData();

export { ingestModels, getSupportedThinkingForModel } from "./store/models";
