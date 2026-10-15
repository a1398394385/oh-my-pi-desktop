// Terminal frame bus (PTY output/exit skips the global notify, pushing straight to subscribers
// to avoid whole-tree re-renders).
// PLAN P3 is explicit: this bus bypasses zustand and stays a standalone module as-is.
import type { TerminalFrame } from "./shapes";

const terminalListeners = new Set<(frame: TerminalFrame) => void>();
export function onTerminalFrame(fn: (frame: TerminalFrame) => void): () => boolean {
  terminalListeners.add(fn);
  return () => terminalListeners.delete(fn);
}
export function emitTerminalFrame(frame: TerminalFrame): void {
  for (const fn of terminalListeners) fn(frame);
}
