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

const TAB = { name: "main", url: "https://example.com/live", title: "Example", kind: "headless", mirrorable: true, ownerPath: "/smoke/a.jsonl" };
const OTHER = { name: "other", url: "https://other.example/x", title: "Other", kind: "headless", mirrorable: true, ownerPath: "/smoke/b.jsonl" };

// ---- Foreign-session edge: the displayed panel must stay untouched ----
dbg.useAppStore.setState({ rightCollapsed: true, rightTabs: [], rightTab: null, browserTabs: [], browserViewTab: null, browserPinned: false, activePath: "/smoke/a.jsonl" });
await dbg.landBrowserTabs([OTHER]);
await sleep(80);
let st = dbg.useAppStore.getState();
ok("foreign edge: displayed panel untouched (no mirror tab)", st.rightTab === null && !st.rightTabs.includes("mirror"));
ok("foreign edge: panel stays collapsed", st.rightCollapsed === true);

// ---- Own-session edge: auto-open the mirror in the displayed panel ----
await dbg.landBrowserTabs([OTHER, TAB]);
await sleep(80);
st = dbg.useAppStore.getState();
ok("edge: mirror tab injected and activated", st.rightTab === "mirror" && st.rightTabs.includes("mirror"));
ok("edge: right panel expanded", st.rightCollapsed === false);
ok("edge: agent view mounts (own tab pill)", (($(".bpane-tabs")?.textContent ?? "").includes("main")));
ok("edge: foreign tab pill filtered out", !(($(".bpane-tabs")?.textContent ?? "").includes("other")));
ok("edge: url row shows the mirrored page url", (($(".bpane-urlrow")?.textContent ?? "").includes("example.com/live")));
ok("edge: live badge renders", !!$(".bpane-live-badge"));

// ---- Latch: a manual collapse is not fought until the owner's tabs drain ----
dbg.useAppStore.setState({ rightCollapsed: true });
await dbg.landBrowserTabs([{ ...TAB, url: "https://example.com/next" }, OTHER]);
await sleep(80);
st = dbg.useAppStore.getState();
ok("latch: non-edge churn does not re-expand", st.rightCollapsed === true);

await dbg.landBrowserTabs([OTHER]);
await dbg.landBrowserTabs([OTHER, TAB]);
await sleep(80);
st = dbg.useAppStore.getState();
ok("drain-to-zero rearms the auto-open", st.rightCollapsed === false && st.rightTab === "mirror");

// ---- Screencast still through the frame bus -> <img> ----
// The agent view subscribes only while connected (preview sets connected).
await dbg.emitBrowserFrame({ name: "main", data: "/9j/4AAQSkZJRgABAQ", ts: Date.now(), w: 1200, h: 800, s: 1 });
await sleep(120);
const img = $(".bpane-live-img") as HTMLImageElement | null;
ok("still: live img rendered from the bus frame", !!img);
ok("still: img carries the jpeg data url", (img?.getAttribute("src") ?? "").startsWith("data:image/jpeg;base64,/9j/"));

// happy-dom rects are zero-sized; pin a viewport-sized rect for the input mapping
const rectPatch = { left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400 } as DOMRect;
if (img) {
  const patchable = img as unknown as { getBoundingClientRect(): DOMRect }; // test-only rect pin
  patchable.getBoundingClientRect = () => rectPatch;
}

// ---- Interactive mirror: viewport events map to page coords and leave as
// browser_input frames (capture by overriding the store's send) ----
const captured: Record<string, unknown>[] = [];
dbg.useAppStore.setState({ send: (obj: Record<string, unknown>) => captured.push(obj) });
const view = $(".bpane-liveview") as HTMLElement | null;
if (view && img) {
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

// ---- Manual browse stays reachable as its own tab (the mode pills are gone) ----
st = dbg.useAppStore.getState() as { rightTabs: string[] };
dbg.useAppStore.setState({ rightTabs: st.rightTabs.includes("browser") ? st.rightTabs : [...st.rightTabs, "browser"], rightTab: "browser" });
await sleep(80);
ok("manual: browser page renders its address bar", !!$(".bpane-input"));
ok("manual: no mode pills remain", document.querySelectorAll(".bpane .mcp-type-pill").length === 0);
ok("no uncaught error marker", !document.body.getAttribute("data-error"));

// ---- Drain edge: the displayed session's last tab closing auto-closes the mirror tab ----
await dbg.landBrowserTabs([OTHER]); // /smoke/a.jsonl drains, OTHER keeps browsing
await sleep(80);
st = dbg.useAppStore.getState();
ok("drain: mirror tab auto-closed", !st.rightTabs.includes("mirror"));
ok("drain: neighbor tab stays active", st.rightTab === "browser");

// ---- Drain to the LAST tab: the auto-close collapses the panel (manual-close semantics) ----
await dbg.landBrowserTabs([OTHER, TAB]); // re-arm the owner's edge, mirror re-opens
await sleep(80);
dbg.useAppStore.setState({ rightTabs: ["mirror"], rightTab: "mirror", rightCollapsed: false });
await dbg.landBrowserTabs([OTHER]); // the displayed session's last tab closes
await sleep(80);
st = dbg.useAppStore.getState();
ok("last-tab drain: right panel auto-collapses", st.rightTabs.length === 0 && st.rightCollapsed === true);

const failed = asserts.filter(([, cond]) => !cond);
for (const [name, cond] of asserts) console.log(`${cond ? "✓" : "✗"} ${name}`);
console.log(failed.length === 0 ? "SMOKE OK: browser mirror UI" : `SMOKE FAIL: ${failed.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
