// 终端数据帧总线（PTY 输出/退出不经全局 notify，直推订阅者，避免整树重渲染）。
// PLAN P3 明确:本总线不经 zustand,原样保留为独立模块。
import type { TerminalFrame } from "./shapes";

const terminalListeners = new Set<(frame: TerminalFrame) => void>();
export function onTerminalFrame(fn: (frame: TerminalFrame) => void): () => boolean {
  terminalListeners.add(fn);
  return () => terminalListeners.delete(fn);
}
export function emitTerminalFrame(frame: TerminalFrame): void {
  for (const fn of terminalListeners) fn(frame);
}
