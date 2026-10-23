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
  documentElement: { style: {}, setAttribute: () => {} },
  body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} }, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }),
} as unknown as Document;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: globalThis.matchMedia, location: globalThis.location, listeners } as unknown as Window & typeof globalThis;
