// Minimal DOM globals for driving the ui-src store outside a browser (bun test
// has no DOM; the store import graph pulls in shell.ts which touches
// matchMedia/document/localStorage at module scope).
const listeners: Record<string, unknown> = {};
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
} as unknown as Storage;
// layout.ts reads location.search at module scope (REMOTE detection); preview=1 keeps it off the remote path
globalThis.location = { search: "?preview=1", href: "http://localhost/" } as unknown as Location;
globalThis.navigator = { language: "zh-CN", userAgent: "bun-test" } as unknown as Navigator;


globalThis.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  // Focused by default: notifyDesktop bails out when the user is looking at the session, so
  // tests that drive turn_end never reach the desktop-notification branch.
  hasFocus: () => true,
  documentElement: { style: {}, setAttribute: () => {} },
  body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} }, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }),
} as unknown as Document;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: globalThis.matchMedia, location: globalThis.location, listeners } as unknown as Window & typeof globalThis;

// Process-wide Tauri stub. ui-src/store/ws.ts captures window.__TAURI__.core.invoke once, at
// module load, so whichever test file loads the store graph first decides what every later
// file in the same bun process sees. The stub therefore lives here — shared by every
// dom-stub consumer — and desktop notifications land on one channel all files can assert on.
// Consumers must not overwrite window.__TAURI__ with their own stub.
export const desktopNotifications: { title: string; body: string; path?: string }[] = [];
const tauriInvoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
	if (cmd === "send_desktop_notification") {
		desktopNotifications.push(args as { title: string; body: string; path?: string });
	}
	return undefined;
};
(globalThis.window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke: tauriInvoke } };
