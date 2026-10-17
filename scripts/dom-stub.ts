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
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: globalThis.matchMedia, listeners } as unknown as Window & typeof globalThis;
