// Computer-use display reconciliation (desktop side).
//
// Why: the base stores `computer.display` as the raw Win32 monitor handle that
// xcap's Monitor::id() returns (crates/pi-natives/src/desktop/win32/capture.rs
// asks for the id, xcap's windows backend answers `self.h_monitor.0 as u32` from
// EnumDisplayMonitors). That handle is assigned by the kernel and is stable only
// inside one boot: after a restart the stored value names nothing, and the base
// then hard-fails every computer-use call with `InvalidTarget: selected display
// '<old id>' is not active` (capture.rs, DisplaySelector::Id arm) until the user
// re-picks a display by hand.
//
// Fix (desktop-owned, base untouched): remember which *physical* monitor the
// user picked by a boot-stable identity -- the EDID friendly name plus resolution
// and primary flag, all of which survive the handle change -- in the
// `computerDisplay` section of omp-desktop.json, and re-point computer.display at
// that monitor's current id whenever the stored value no longer resolves.
//
// Never guess: an unresolvable value with no remembered monitor (first run after
// this fix, or a monitor that is genuinely gone) is left alone and reported,
// instead of silently retargeting the capture to some other screen.
import { readFileSync, writeFileSync } from "node:fs";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";
import type { DesktopSession } from "@oh-my-pi/pi-natives";
import { settingsGet, settingsSet } from "./settings-compat.ts";
import { H } from "./state.ts";
import { safeStderr } from "./stderr.ts";

const DISPLAY_KEY = "computer.display";
/** Composite selector: every display at once, so there is no single monitor to track. */
const ALL_DISPLAYS = "all";

/** One physical display, shaped for the UI's displays frame (DisplaysFrame). */
export type PhysicalDisplay = { id: string; name: string; width: number; height: number; isPrimary: boolean };
/** Boot-stable identity of the picked monitor: what the handle-based id cannot carry. */
type DisplayHint = Omit<PhysicalDisplay, "id">;

/**
 * Enumerate physical displays through the natives desktop adapter. A short-lived
 * session is enough (listDisplays is read-only) and failures degrade to an empty
 * list plus the error text (same contract the display dropdown expects).
 */
export async function listPhysicalDisplays(): Promise<{ displays: PhysicalDisplay[]; error: string | null }> {
	let displays: PhysicalDisplay[] = [];
	let error: string | null = null;
	let session: DesktopSession | null = null;
	try {
		session = createDesktopSession({});
		displays = (await session.listDisplays()).map(d => ({
			id: String(d.id),
			name: String(d.name ?? d.id),
			width: d.width,
			height: d.height,
			isPrimary: !!d.isPrimary,
		}));
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		await session?.close().catch(() => {});
	}
	return { displays, error };
}

/** Read omp-desktop.json in full (missing/corrupt file -> empty object, same tolerance as browser-config.ts). */
function readDesktopJson(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** The remembered monitor; a missing or malformed section reads as null (no memory -> no substitute). */
function readDisplayHint(): DisplayHint | null {
	const section = readDesktopJson().computerDisplay;
	if (!section || typeof section !== "object") return null;
	const hint = section as Record<string, unknown>;
	if (typeof hint.name !== "string" || typeof hint.width !== "number" || typeof hint.height !== "number") return null;
	return { name: hint.name, width: hint.width, height: hint.height, isPrimary: hint.isPrimary === true };
}

/** Remember the picked monitor, merge-writing its section and leaving every other key of the file intact. */
function rememberDisplay(display: PhysicalDisplay): void {
	const next: DisplayHint = { name: display.name, width: display.width, height: display.height, isPrimary: display.isPrimary };
	const prev = readDisplayHint();
	if (prev && prev.name === next.name && prev.width === next.width && prev.height === next.height && prev.isPrimary === next.isPrimary) return;
	writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...readDesktopJson(), computerDisplay: next }, null, 2));
}

/**
 * Resolve the remembered monitor against the current enumeration. Name + exact
 * geometry wins; a lone name match covers a resolution switch; a lone
 * shape+primary match covers a renamed monitor. Two candidates at the same
 * specificity stay unresolved -- retargeting the wrong screen is worse than a
 * stale value the user can see and fix.
 */
function matchDisplay(displays: PhysicalDisplay[], hint: DisplayHint | null): PhysicalDisplay | null {
	if (!hint) return null;
	const named = displays.filter(d => d.name === hint.name);
	const exact = named.filter(d => d.width === hint.width && d.height === hint.height);
	if (exact.length === 1) return exact[0];
	if (named.length === 1) return named[0];
	const sameShape = displays.filter(d => d.width === hint.width && d.height === hint.height && d.isPrimary === hint.isPrimary);
	return sameShape.length === 1 ? sameShape[0] : null;
}

/**
 * Re-point computer.display at the monitor the user picked and refresh the
 * remembered identity. Called on every profile apply (host boot included) and
 * right after a pick; a value that still resolves only refreshes the memory.
 */
export async function reconcileComputerDisplay(): Promise<void> {
	const current = settingsGet(H.settings, DISPLAY_KEY);
	if (typeof current !== "string" || current === ALL_DISPLAYS) return;
	const { displays, error } = await listPhysicalDisplays();
	if (error) {
		safeStderr(`[host] computer.display 对账跳过：显示器枚举失败（${error}）\n`);
		return;
	}
	const hit = displays.find(d => d.id === current);
	if (hit) {
		rememberDisplay(hit);
		return;
	}
	const replacement = matchDisplay(displays, readDisplayHint());
	if (!replacement) {
		safeStderr(`[host] computer.display=${current} 已失效，且无匹配的历史选择，请在设置页重选显示器\n`);
		return;
	}
	settingsSet(H.settings, DISPLAY_KEY, replacement.id);
	await H.settings.flush();
	rememberDisplay(replacement);
	safeStderr(`[host] computer.display ${current} → ${replacement.id}（${replacement.name}）：显示器 id 随开机失效，已按上次选择重新指向\n`);
}
