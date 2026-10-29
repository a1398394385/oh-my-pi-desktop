// Browser mirror frame bus (screencast stills skip the global notify, pushing
// straight to subscribers to avoid whole-tree re-renders — same shape as the
// terminal frame bus in store/terminal.ts).
import type { BrowserMirrorFrame, BrowserPickFrame } from "../types/frames";

const browserFrameListeners = new Set<(frame: BrowserMirrorFrame) => void>();
export function onBrowserFrame(fn: (frame: BrowserMirrorFrame) => void): () => boolean {
	browserFrameListeners.add(fn);
	return () => browserFrameListeners.delete(fn);
}
export function emitBrowserFrame(frame: BrowserMirrorFrame): void {
	for (const fn of browserFrameListeners) fn(frame);
}

// Picker probes ride their own bus: they repaint the pointer readout only, and
// the mirror view unmounts/unsubscribes together anyway.
const browserPickListeners = new Set<(frame: BrowserPickFrame) => void>();
export function onBrowserPick(fn: (frame: BrowserPickFrame) => void): () => boolean {
	browserPickListeners.add(fn);
	return () => browserPickListeners.delete(fn);
}
export function emitBrowserPick(frame: BrowserPickFrame): void {
	for (const fn of browserPickListeners) fn(frame);
}
