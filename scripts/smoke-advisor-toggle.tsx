// Header advisor toggle (MainHeader eye button, right of the collab globe).
// Renders the real desktop App with a capturing MockWebSocket and asserts:
// the eye renders only with an open session, the click sends set_advisor_mode,
// the advisor_mode frame lights it (and the title flips), and a no-model
// error surfaces as a red toast while the lit state follows the frame flag.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-advisor-toggle.tsx
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");

const win = new Window({ url: "http://localhost:1420/?ws=1234" });

class MockWebSocket {
  static sent: string[] = [];
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  onopen: null | (() => void) = null;
  send(data: string) { MockWebSocket.sent.push(data); }
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

Object.assign(globalThis, {
  window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator,
  location: win.location, Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
  DocumentFragment: win.DocumentFragment, Text: win.Text, Selection: win.Selection, Range: win.Range,
  CustomEvent: win.CustomEvent, Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  // shell.ts calls matchMedia at module load (theme query)
  matchMedia: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
});
(win as unknown as Record<string, unknown>).matchMedia = (globalThis as Record<string, unknown>).matchMedia;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Dynamic imports are required, not style: the DOM globals above must be installed
// before the store modules evaluate (same contract as smoke-remote-layout).
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { onMessage } = await import("../ui-src/store/ws");
const { default: App } = await import("../ui-src/App");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => { root.render(createElement(App)); });
// main.tsx owns the boot-time connect; mounting <App> alone does not dial the host
void useAppStore.getState().connect();

const PATH = "/tmp/adv";
const seedSession = {
  sessionId: "sid-1", cwd: PATH, items: [], pendingApprovals: [], assistantDraft: "",
  streaming: false, turnStartAt: null, subagents: new Map(), model: null, thinking: "auto",
  isGit: false, todos: [], title: null, isSubagent: false, advisorMode: false,
};
// Two call sites share the seed shape; the argument flips the seeded eye state
const openWith = (advisorMode: boolean) => {
  useAppStore.setState({
    activePath: PATH,
    openSessions: new Map([[PATH, { ...seedSession, advisorMode } as never]]),
  });
};
const eyeBtn = () => document.querySelector(".chat-head button.advisor-toggle") as HTMLElement | null;
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
const feed = (frame: object) => act(async () => { onMessage(frame as never); });
const lastSent = () => JSON.parse(MockWebSocket.sent.at(-1)!);

try {
  // 1. No open session: no eye button (advisor is a per-session toggle)
  assert.ok(!eyeBtn(), "eye hidden without an open session");

  // 2. Open session renders the eye off; the click sends the RPC with the flipped flag
  openWith(false);
  await act(async () => {});
  assert.ok(eyeBtn(), "eye renders with an open session");
  assert.equal(eyeBtn()!.getAttribute("title"), "开启顾问：由第二模型安静复审每轮并提示风险", "off state title");
  assert.ok(!eyeBtn()!.classList.contains("on"), "off state is not lit");
  MockWebSocket.sent.length = 0;
  await click(eyeBtn()!);
  assert.equal(lastSent().type, "set_advisor_mode", "click sends set_advisor_mode");
  assert.equal(lastSent().sessionId, "sid-1", "rpc carries the session id");
  assert.equal(lastSent().enabled, true, "rpc flips the flag");

  // 3. Host confirmation frame lights the eye and flips the title
  await feed({ type: "advisor_mode", sessionId: "sid-1", enabled: true });
  assert.ok(eyeBtn()!.classList.contains("on"), "frame lights the eye");
  assert.equal(eyeBtn()!.getAttribute("title"), "关闭顾问：停止第二模型对每轮的复审", "on state title");
  assert.equal(useAppStore.getState().openSessions.get(PATH)?.advisorMode, true, "store flag updated");

  // 4. Toggle off round-trips through the same seam
  await click(eyeBtn()!);
  assert.equal(lastSent().enabled, false, "second click turns it off");
  await feed({ type: "advisor_mode", sessionId: "sid-1", enabled: false });
  assert.ok(!eyeBtn()!.classList.contains("on"), "off frame unlights the eye");

  // 5. No-model error frame: the overlay stays on (setting on) and the red toast shows
  await click(eyeBtn()!);
  await feed({ type: "advisor_mode", sessionId: "sid-1", enabled: true, error: "Advisor enabled, but no model is assigned to the 'advisor' role" });
  assert.ok(eyeBtn()!.classList.contains("on"), "error frame keeps the lit state");
  assert.equal(useAppStore.getState().toastErr, true, "error toast flagged");
  assert.ok(useAppStore.getState().toastMsg?.includes("no model"), "toast carries the no-model text");

  console.log("✓ advisor header toggle: render / rpc / frame / toast all correct");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await act(async () => { root.unmount(); });
  await win.happyDOM.abort();
}
// happy-dom leaves residual handles in this full-App smoke: exit explicitly (precedent: smoke-remote-layout.ts)
process.exit(process.exitCode ?? 0);
