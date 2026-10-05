// UI smoke: the Agent browser live view in the right panel, driven through the
// REAL store functions (preview __dbg exposes landBrowserTabs + the frame bus
// emitter — no WS needed). Asserts the auto-open behavior (edge -> browser tab
// + panel expand, latch semantics) and the agent-view DOM (tab pills / URL row
// / screencast still). Run bun run ui:build first; host half is covered by
// smoke:browsermirror.
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
window.localStorage.setItem("omp-ui-settings", JSON.stringify({ lang: "zh-CN" }));
globalThis.navigator = window.navigator;
globalThis.WebSocket = class {};
globalThis.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
window.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
globalThis.MutationObserver = window.MutationObserver ?? (class {} as unknown as typeof MutationObserver);
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
document.body.innerHTML = '<div id="root"></div>';

// happy-dom does not load <link rel="stylesheet">: inline the built CSS so
// class presence assertions stay meaningful (same prologue as smoke-react-shell).
const distDir = join(import.meta.dir, "../ui/dist");
const distHtml = readFileSync(join(distDir, "index.html"), "utf-8");
const cssHref = distHtml.match(/<link\b[^>]*rel="stylesheet"[^>]*>/)?.[0]?.match(/href="([^"]+)"/)?.[1];
if (cssHref) {
	const styleEl = document.createElement("style");
	styleEl.textContent = readFileSync(join(distDir, cssHref), "utf-8");
	document.head.appendChild(styleEl);
}

// Globals must exist before the bundle evaluates (same exception as smoke-react-shell).
await import("../ui/dist/assets/app.js");

const sleep = (ms: number): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};
const $ = (sel: string) => document.querySelector(sel);
const asserts: [string, boolean][] = [];
const ok = (name: string, cond: boolean) => asserts.push([name, cond]);

interface DbgHook {
	useAppStore: {
		getState(): Record<string, unknown> & {
			rightTab: string | null;
			rightTabs: string[];
			rightCollapsed: boolean;
			send(obj: unknown): void;
		};
		setState(patch: Record<string, unknown>): void;
	};
	landBrowserTabs(tabs: unknown[], active: boolean): Promise<void>;
	emitBrowserFrame(frame: { name: string; data: string; ts: number; w?: number; h?: number; s?: number }): Promise<void>;
}
const dbg = (window as unknown as { __dbg?: DbgHook }).__dbg;
if (!dbg) throw new Error("__dbg hook missing (preview mode?)");
await sleep(300);

const TAB = { name: "main", url: "https://example.com/live", title: "Example", kind: "headless", mirrorable: true };

// ---- Auto-open on the activation edge ----
dbg.useAppStore.setState({ rightCollapsed: true, rightTabs: [], rightTab: null, browserTabs: [], browserViewTab: null, browserPinned: false });
await dbg.landBrowserTabs([TAB], true);
await sleep(80);
let st = dbg.useAppStore.getState();
ok("edge: browser tab injected and activated", st.rightTab === "browser" && st.rightTabs.includes("browser"));
ok("edge: right panel expanded", st.rightCollapsed === false);
ok("edge: agent view mounts (tab pill)", (($(".bpane-tabs")?.textContent ?? "").includes("main")));
ok("edge: url row shows the mirrored page url", (($(".bpane-urlrow")?.textContent ?? "").includes("example.com/live")));
ok("edge: live badge renders", !!$(".bpane-live-badge"));

// ---- Latch: a manual collapse is not fought until the tab list drains ----
dbg.useAppStore.setState({ rightCollapsed: true });
await dbg.landBrowserTabs([{ ...TAB, url: "https://example.com/next" }], false);
await sleep(80);
st = dbg.useAppStore.getState();
ok("latch: non-edge churn does not re-expand", st.rightCollapsed === true);

await dbg.landBrowserTabs([], false);
await dbg.landBrowserTabs([TAB], true);
await sleep(80);
st = dbg.useAppStore.getState();
ok("drain-to-zero rearms the auto-open", st.rightCollapsed === false && st.rightTab === "browser");

// ---- Screencast still through the frame bus -> <img> ----
// The agent view subscribes only while connected (preview sets connected).
await dbg.emitBrowserFrame({ name: "main", data: "/9j/4AAQSkZJRgABAQ", ts: Date.now(), w: 1200, h: 800, s: 1 });
await sleep(120);
const img = $(".bpane-live-img") as HTMLImageElement | null;
ok("still: live img rendered from the bus frame", !!img);
ok("still: img carries the jpeg data url", (img?.getAttribute("src") ?? "").startsWith("data:image/jpeg;base64,/9j/"));

// ---- Interactive mirror: viewport events map to page coords and leave as
// browser_input frames (capture by overriding the store's send) ----
const captured: Record<string, unknown>[] = [];
dbg.useAppStore.setState({ send: (obj: Record<string, unknown>) => captured.push(obj) });
const view = $(".bpane-liveview") as HTMLElement | null;
const rectPatch = { left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400 } as DOMRect;
if (view && img) {
  // happy-dom rects are zero-sized; pin a viewport-sized rect for the mapping
  (img as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () => rectPatch;
  view.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 300, clientY: 200, button: 0, detail: 1 }));
  view.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 300, clientY: 200, button: 0, detail: 1 }));
  view.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" }));
  view.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await sleep(80);
}
const inputFrames = captured.filter((m) => m.type === "browser_input");
const mouseDown = inputFrames.find((m) => m.op === "mouse" && m.action === "down");
const textFrame = inputFrames.find((m) => m.op === "text");
const enterFrame = inputFrames.find((m) => m.op === "key" && m.key === "enter");
ok("input: mouse press posted with mapped page coords", mouseDown !== undefined && mouseDown.x === 600 && mouseDown.y === 400, JSON.stringify(mouseDown));
ok("input: printable key posted as text op", textFrame !== undefined && textFrame.text === "a", JSON.stringify(textFrame));
ok("input: Enter posted as key down/up pair", inputFrames.filter((m) => m.op === "key" && m.key === "enter").length >= 2, JSON.stringify(enterFrame));

// ---- Manual mode stays reachable (segmented pills) ----
const pills = Array.from(document.querySelectorAll(".bpane .mcp-type-pill")).map((b) => (b.textContent ?? "").trim());
ok("mode pills render (Agent + manual)", pills.includes("Agent") && pills.some((p) => p.includes("手动") || p.includes("Manual")));
ok("no uncaught error marker", !document.body.getAttribute("data-error"));

const failed = asserts.filter(([, cond]) => !cond);
for (const [name, cond] of asserts) console.log(`${cond ? "✓" : "✗"} ${name}`);
console.log(failed.length === 0 ? "SMOKE OK: browser mirror UI" : `SMOKE FAIL: ${failed.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
