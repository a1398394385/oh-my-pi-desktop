// Agent browser live mirror: watches the SDK's module-global tab registry (the
// in-process browser the Agent drives) and streams a CDP screencast of the
// selected tab to the UI over the WebSocket, so the right-panel browser page
// can show the Agent's browsing in real time.
//
// Wiring: the SDK's browser tool (eval prelude "browser") runs in this host
// process, so importing the tab supervisor through the package's sub-path
// export yields the SAME module instance the AgentSession uses — listTabs()/
// getTab() see live tabs with no SDK-side changes. Pages live inside tab
// worker threads, but the puppeteer Browser handle (host-side CDP connection)
// is shared: an extra CDPSession on the tab's target gives us
// Page.startScreencast without disturbing the worker (Chromium multiplexes
// CDP sessions per target; this is exactly how DevTools mirrors a page).
//
// Frames: browser_tabs (stamped push, tab list + activation edge for the
// auto-open signal) and browser_frame (unstamped jpeg stills, terminal-data
// style). The screencast only runs while the UI subscribed (browser page
// visible); the 500ms poll always runs (cheap snapshot + diff) so the
// activation edge is detected even before the UI opens the page.
import type * as SupervisorModule from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { CDPSession, Target } from "puppeteer-core";
import { stampEvent } from "./state.ts";

/** Minimal send surface of a UI WebSocket connection. */
export interface MirrorWs {
	send(data: string): unknown;
}

/** JSON-safe tab projection sent to the UI (ManagedTabInfo + viewability). */
export interface MirrorTabInfo {
	name: string;
	url: string;
	title: string;
	kind: string;
	/** Whether this backend supports a CDP screencast (cmux/tern surfaces do not). */
	mirrorable: boolean;
}

/** Page.screencastFrame CDP event (only the fields the mirror consumes). */
interface ScreencastFrameEvent {
	sessionId: number;
	data: string;
	metadata?: {
		deviceWidth?: number;
		deviceHeight?: number;
		pageScaleFactor?: number;
	};
}

// Browser kind tags backed by a puppeteer Browser handle (CDP reachable).
// Static membership table — Record, not Set.
const MIRRORABLE_KINDS: Record<string, true> = {
	headless: true,
	spawned: true,
	connected: true,
	relay: true,
};
const POLL_MS = 500;

// Min gap between pushed screencast frames; Chromium only produces frames on
// change, this just caps burst cost (jpeg ~40-90KB each over the JSON WS).
const FRAME_MIN_INTERVAL_MS = 90;
// Backoff after a failed attach (dead target, closed browser) so a wedged tab
// cannot turn the poll into a tight retry loop.
const ATTACH_BACKOFF_MS = 4000;
// Wake-on-view/input rate limit: repeated pokes on a settle-frozen tab coalesce.
const WAKE_MIN_INTERVAL_MS = 2_000;

// Type-only handle on the SDK tab supervisor module; the runtime import stays
// dynamic so host startup never eagerly loads puppeteer.
type Supervisor = typeof SupervisorModule;
let supervisorPromise: Promise<Supervisor> | null = null;
function supervisor(): Promise<Supervisor> {
	supervisorPromise ??= import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
	return supervisorPromise;
}


// ---------- Mirror state ----------
let pollTimer: Timer | null = null;
let lastTabsJson = "[]";
let lastTabs: MirrorTabInfo[] = [];
// The current UI connection (main.ts open/close keeps this fresh). Tab-list
// pushes go here regardless of subscription; the screencast needs subscribe.
let uiWs: MirrorWs | null = null;
let subscribed = false;
let selected: string | null = null;
let streamWidth = 960;
let attachment: { name: string; cdp: CDPSession; wokeAt: number } | null = null;
let attachBackoffUntil = 0;

// ---------- Lifecycle (main.ts) ----------
export function startBrowserMirror(): void {
	if (pollTimer) return;
	pollTimer = setInterval(() => void poll(), POLL_MS);
}

export function browserMirrorOnWsOpen(ws: MirrorWs): void {
	uiWs = ws;
}

export function browserMirrorOnWsClose(ws: MirrorWs): void {
	if (uiWs === ws) {
		uiWs = null;
		subscribed = false;
		void teardownAttachment();
	}
}

// ---------- RPC surface (host/rpc/browser.ts) ----------
export function browserMirrorSubscribe(ws: MirrorWs, opts: { width?: number }): void {
	uiWs = ws;
	subscribed = true;
	if (opts.width && Number.isFinite(opts.width)) {
		streamWidth = Math.max(320, Math.min(2200, Math.round(opts.width * 1.5)));
	}
	// Immediate snapshot so the page renders the tab list before any change.
	sendTabs(lastTabs, false);
	void poll();
}

export function browserMirrorUnsubscribe(): void {
	subscribed = false;
	void teardownAttachment();
}

export function browserMirrorSelect(name: string): void {
	if (selected === name) return;
	selected = name || null;
	void teardownAttachment();
	void poll();
}

// ---------- Interactive input (UI -> CDP Input domain) ----------
// The mirror is bidirectional: the UI maps viewport clicks to page CSS
// coordinates and posts them here; forwarding goes to the attached tab's CDP
// session only, silently dropped otherwise (no attachment / other tab).

// Special-key table: key name -> CDP key event fields. Printable text arrives
// as op "text" (Input.insertText), not synthesized key events.
const SPECIAL_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	tab: { key: "Tab", code: "Tab", vk: 9 },
	escape: { key: "Escape", code: "Escape", vk: 27 },
	delete: { key: "Delete", code: "Delete", vk: 46 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	home: { key: "Home", code: "Home", vk: 36 },
	end: { key: "End", code: "End", vk: 35 },
	pageup: { key: "PageUp", code: "PageUp", vk: 33 },
	pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

/** One UI input event, already mapped to page CSS coordinates by the browser page. */
export interface MirrorInput {
	name: string;
	op: "mouse" | "wheel" | "key" | "text";
	action?: "down" | "up" | "move";
	x?: number;
	y?: number;
	button?: string;
	count?: number;
	deltaX?: number;
	deltaY?: number;
	key?: string;
	text?: string;
}

export function browserMirrorInput(input: MirrorInput): void {
	const current = attachment;
	if (!current || current.name !== input.name || !subscribed) return;
	// A settle-frozen page silently drops input. Wake first, THEN dispatch —
	// both ride the same CDPSession, whose commands process in send order,
	// so the lifecycle write lands before the input event.
	void wakeIfFrozen(input.name).then(() => dispatchInput(input, current.cdp));
}

function dispatchInput(input: MirrorInput, cdp: CDPSession): void {
	const x = Number(input.x ?? 0);
	const y = Number(input.y ?? 0);
	// Detached: the promise is intentionally unobserved — a dropped input
	// event mid-teardown is harmless and must not crash the RPC shell.
	if (input.op === "mouse") {
		const type = input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : "mouseMoved";
		const button = input.button === "middle" || input.button === "right" ? input.button : "left";
		void cdp
			.send("Input.dispatchMouseEvent", {
				type,
				x,
				y,
				button: type === "mouseMoved" ? "none" : button,
				buttons: type === "mouseMoved" ? 0 : 1,
				clickCount: type === "mouseMoved" ? 0 : Math.max(1, Math.min(3, Number(input.count) || 1)),
			})
			.catch(() => undefined);
		return;
	}
	if (input.op === "wheel") {
		void cdp
			.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x,
				y,
				deltaX: Number(input.deltaX ?? 0),
				deltaY: Number(input.deltaY ?? 0),
			})
			.catch(() => undefined);
		return;
	}
	if (input.op === "key") {
		const special = SPECIAL_KEYS[(input.key ?? "").toLowerCase()];
		if (!special) return;
		const base = { key: special.key, code: special.code, windowsVirtualKeyCode: special.vk };
		void cdp
			.send("Input.dispatchKeyEvent", {
				type: input.action === "up" ? "keyUp" : "keyDown",
				...base,
				...(input.action === "up" ? {} : { text: special.text }),
			})
			.catch(() => undefined);
		return;
	}
	if (input.op === "text" && input.text) {
		void cdp.send("Input.insertText", { text: input.text.slice(0, 2000) }).catch(() => undefined);
	}
}

// ---------- Poll: registry snapshot + diff + attach reconciliation ----------
async function poll(): Promise<void> {
	try {
		const { listTabs } = await supervisor();
		const tabs: MirrorTabInfo[] = listTabs().map((tab) => ({
			name: tab.name,
			url: tab.url,
			title: tab.title,
			kind: tab.kind,
			mirrorable: MIRRORABLE_KINDS[tab.kind] === true,
		}));
		const json = JSON.stringify(tabs);
		if (json !== lastTabsJson) {
			const becameActive = lastTabs.length === 0 && tabs.length > 0;
			lastTabs = tabs;
			lastTabsJson = json;
			// Activation edges always reach the UI (auto-open signal); other
			// churn only while subscribed (fresh url/title for the live view).
			if (becameActive || subscribed) sendTabs(tabs, becameActive);
		}
		await reconcile(tabs);
	} catch {
		// SDK module not loadable / transient registry error: the poll stays
		// silent and retries on the next tick.
	}
}

function sendTabs(tabs: MirrorTabInfo[], becameActive: boolean): void {
	if (!uiWs) return;
	try {
		uiWs.send(JSON.stringify(stampEvent({ type: "browser_tabs", tabs, active: becameActive })));
	} catch {
		// dead connection: main.ts close() clears uiWs
	}
}

async function reconcile(tabs: MirrorTabInfo[]): Promise<void> {
	if (subscribed && (!selected || !tabs.some((t) => t.name === selected && t.mirrorable))) {
		selected = tabs.find((t) => t.mirrorable)?.name ?? null;
	}
	const wanted = subscribed && uiWs ? tabs.find((t) => t.name === selected && t.mirrorable) : undefined;
	if (attachment && attachment.name !== wanted?.name) await teardownAttachment();
	if (!wanted || attachment) return;
	if (Date.now() < attachBackoffUntil) return;
	try {
		await attach(wanted);
	} catch {
		attachBackoffUntil = Date.now() + ATTACH_BACKOFF_MS;
	}
}

async function attach(tabInfo: MirrorTabInfo): Promise<void> {
	const { getTab } = await supervisor();
	const tab = getTab(tabInfo.name);
	if (!tab || tab.state !== "alive") throw new Error("tab gone");
	const handle = tab.browser;
	if (!("browser" in handle) || !handle.browser.connected) throw new Error("browser disconnected");
	// Target identity: discovery on the host connection covers worker-created
	// pages; the tab's targetId comes from the supervisor registry. puppeteer
	// keeps the targetId private (_targetId) — one named cast read per target.
	const target = handle.browser.targets().find((t) => {
		const withId = t as Target & { _targetId?: string };
		return withId._targetId === tab.targetId;
	});
	if (!target || target.type() !== "page") throw new Error("target not discovered");
	const cdp = await target.createCDPSession();
	let lastSentAt = 0;
	cdp.on("Page.screencastFrame", (ev) => {
		const frame = ev as ScreencastFrameEvent;
		// Always ack, even when dropping for rate limiting or liveness —
		// Chromium stops casting after two unacked frames.
		void cdp
			.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
			.catch(() => undefined);
		if (!subscribed || !uiWs || attachment?.cdp !== cdp) return;
		const now = Date.now();
		if (now - lastSentAt < FRAME_MIN_INTERVAL_MS) return;
		lastSentAt = now;
		// Geometry lets the UI map clicks back to page CSS coordinates
		// (device pixels / page scale factor = viewport CSS pixels).
		const meta = frame.metadata;
		try {
			uiWs.send(
				JSON.stringify({
					type: "browser_frame",
					name: tabInfo.name,
					data: frame.data,
					ts: now,
					w: meta?.deviceWidth,
					h: meta?.deviceHeight,
					s: meta?.pageScaleFactor,
				}),
			);
		} catch {
			// dead connection: close() unsubscribes
		}
	});
	cdp.on("disconnected", () => {
		if (attachment?.cdp === cdp) attachment = null;
	});
	const maxDim = streamWidth;
	await cdp.send("Page.startScreencast", {
		format: "jpeg",
		quality: 60,
		maxWidth: maxDim,
		maxHeight: maxDim,
		everyNthFrame: 1,
	});
	attachment = { name: tabInfo.name, cdp, wokeAt: 0 };
	// A settle-frozen page drops input and stops producing frames; watching it
	// implies active. Idempotent — the supervisor's next run re-asserts either state.
	void wakeIfFrozen(tabInfo.name);
}

/**
 * Page.setWebLifecycleState("active") when the supervisor considers the tab
 * settle-frozen. Rate-limited per attachment; the supervisor's `frozen` flag
 * stays untouched (its unfreeze path re-sends "active", which is a no-op).
 */
async function wakeIfFrozen(name: string): Promise<void> {
	const current = attachment;
	if (!current || current.name !== name) return;
	const { getTab } = await supervisor();
	const tab = getTab(name);
	if (!tab?.frozen) return;
	const now = Date.now();
	if (now - current.wokeAt < WAKE_MIN_INTERVAL_MS) return;
	current.wokeAt = now;
	await current.cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
}

async function teardownAttachment(): Promise<void> {
	const current = attachment;
	attachment = null;
	if (!current) return;
	try {
		await current.cdp.send("Page.stopScreencast");
	} catch {
		// session already dead
	}
	try {
		await current.cdp.detach();
	} catch {
		// session already dead
	}
}
