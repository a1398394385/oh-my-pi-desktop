// CtxCard cache-warming section smoke: mount the real CtxCard in happy-dom against the real
// store with a fake WS, open the popcard through the real hover timer (mouseenter → 150ms),
// then drive keepalive_status frames through the real wsHandlers dispatch and assert the
// request shape, the three section cells (probes / next-run countdown / spend) and the
// enabled=false + stale-session no-render paths.
// Run: PATH=/Volumes/MacApps/Home/.bun/bin:$PATH bun run scripts/smoke-ctx-keepalive.ts
//
// The store / i18n / component modules are dynamic imports ON PURPOSE (same reason as
// smoke-ghost-text.ts): their module top levels touch window / document, which must be the
// happy-dom globals installed below before evaluation; a static import would run them first.
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;

// Same global scaffold as smoke-ghost-text: the UI modules read window/document/localStorage
// and DOM constructors off the bare global scope; happy-dom only exposes them on its window
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
window.localStorage.setItem("omp-ui-settings", JSON.stringify({ lang: "zh-CN" }));
globalThis.navigator = window.navigator;
globalThis.WebSocket = class {};
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.matchMedia = (q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
globalThis.location = window.location;
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.MutationObserver = window.MutationObserver;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Document = window.Document;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Text = window.Text;
globalThis.Range = window.Range;

document.body.innerHTML = '<div id="host"></div>';

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../ui-src/store");
const { dispatchFrame } = await import("../ui-src/store/wsHandlers");
const { default: CtxCard } = await import("../ui-src/components/chat/CtxCard");

// ---- Store seeding: active session + fake WS capturing sends ----
const sent: { type: string; sessionId?: string }[] = [];
useAppStore.setState({
  activePath: "/p/s1",
  openSessions: new Map([
    [
      "/p/s1",
      {
        sessionId: "s1",
        items: [],
        assistantDraft: "",
        streaming: false,
        subagents: new Map(),
        model: "m",
        thinking: "off",
        isGit: false,
        todos: [],
        pendingApprovals: [],
      },
    ],
  ]),
  ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket,
});

// ---- Mount the card on a hoverable anchor ----
const anchor = document.createElement("span");
document.body.appendChild(anchor);
const root = createRoot(document.getElementById("host")!);
root.render(React.createElement(CtxCard, { anchor }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error("assertion failed: " + label);
};
const sec = () => document.querySelector(".ring-pop .ka-sec");
const cells = () => [...document.querySelectorAll(".ka-sec .grid > div")].map((c) => c.textContent ?? "");

await sleep(50); // let the anchor effect attach its listeners before hovering

// ---- 1) hover opens the card through the 150ms timer and fires the status request ----
anchor.dispatchEvent(new window.Event("mouseenter"));
ok(!document.querySelector(".ring-pop"), "card stays closed inside the hover timer");
ok(!sec(), "no section before any reply (no in-flight placeholder)");
await sleep(250); // enter timer is 150ms
ok(!!document.querySelector(".ring-pop"), "card popped after the hover timer");
ok(sent.some((m) => m.type === "get_keepalive_status" && m.sessionId === "s1"), "get_keepalive_status sent for the session");

// ---- 2) enabled reply renders the three cells (values through the real zh i18n) ----
dispatchFrame({
  type: "keepalive_status",
  sessionId: "s1",
  enabled: true,
  active: true,
  probes: 12,
  hits: 10,
  misses: 2,
  errors: 0,
  savedUsd: 0.31,
  spendUsd: 0.0012,
  nextProbeAt: Date.now() + 93_000, // → 01:33 at the first tick
});
await sleep(80);
ok(!!sec(), "section rendered after the reply landed");
const c2 = cells();
ok(c2.length === 3, "three metric cells");
ok(c2[0] === "运行次数12命中 10 · 未中 2", "probes cell: count + hits/misses sub-line");
ok(c2[1] === "下次运行01:33", "next-run cell: mm:ss countdown");
ok(c2[2] === "消耗成本$0.0012节省 $0.31", "spend cell: $0.0012 shape + saved secondary");

// ---- 3) null nextProbeAt shows the paused label ----
dispatchFrame({
  type: "keepalive_status",
  sessionId: "s1",
  enabled: true,
  active: false,
  probes: 12,
  hits: 10,
  misses: 2,
  errors: 0,
  savedUsd: 0.31,
  spendUsd: 0.0012,
  nextProbeAt: null,
});
await sleep(80);
ok(cells()[1] === "下次运行已暂停", "paused label when nothing is scheduled");

// ---- 4) enabled=false renders no section at all ----
dispatchFrame({
  type: "keepalive_status",
  sessionId: "s1",
  enabled: false,
  active: false,
  probes: 0,
  hits: 0,
  misses: 0,
  errors: 0,
  savedUsd: 0,
  spendUsd: 0,
  nextProbeAt: null,
});
await sleep(80);
ok(!sec(), "enabled=false renders no section");

// ---- 5) a reply for another session is dropped ----
dispatchFrame({
  type: "keepalive_status",
  sessionId: "zzz",
  enabled: true,
  active: true,
  probes: 5,
  hits: 4,
  misses: 1,
  errors: 0,
  savedUsd: 0.1,
  spendUsd: 0.0005,
  nextProbeAt: Date.now() + 60_000,
});
await sleep(80);
ok(!sec(), "stale-session reply dropped");

root.unmount();
console.log("smoke-ctx-keepalive: all assertions passed");
process.exit(0);
