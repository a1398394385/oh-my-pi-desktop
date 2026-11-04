// Advisor on/off state for the header eye toggle (MainHeader.tsx). Mirrors the
// computer-mode seam: the base owns the runtime (per-session `advisor.enabled`
// settings overlay — the same layer /advisor on|off writes), the desktop adds
// the frame + RPC so the header button and the slash command stay in lockstep.
import { sendSessionState, type PoolEntry } from "./state.ts";
import { hostI18n } from "./i18n/host.ts";
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";

/**
 * Desktop-owned "default on" switch for advisor (omp-desktop.json
 * advisor.defaultEnabled). The base's global `advisor.enabled` is the master
 * gate and its listener applies live to every open session; this switch only
 * decides whether a *fresh* session also starts with the advisor running.
 * Sessions already on disk are untouched — the value is read at spawn only.
 */
export function readAdvisorDefaultEnabled(): boolean {
	return readDesktopSection("advisor").defaultEnabled === true;
}

/** Persist the default-on switch (merge-write, same contract as the computer switch). */
export function writeAdvisorDefaultEnabled(enabled: boolean): void {
	writeDesktopSection("advisor", { ...readDesktopSection("advisor"), defaultEnabled: enabled });
}

/** Advisor state frame: the header eye icon lights up on it. */
export function pushAdvisorMode(
	ws: { send(data: string): unknown },
	sessionId: string,
	entry: PoolEntry,
	error?: string,
) {
	sendSessionState(
		ws,
		entry,
		JSON.stringify({
			type: "advisor_mode",
			sessionId,
			// The overlay is the button's lit state; a stale runtime without the
			// overlay must not keep the eye lit (setAdvisorEnabled(false) clears it).
			enabled: entry.session.isAdvisorEnabled(),
			...(error ? { error } : {}),
		}),
	);
}

/**
 * Toggle the per-session advisor opt-in. `setAdvisorEnabled` returns whether a
 * live advisor runtime actually came up; on = overlay without a resolvable
 * 'advisor' role model keeps the setting but reports the no-model condition
 * (same message the /advisor command prints), off is unconditional.
 */
export function setAdvisorMode(
	ws: { send(data: string): unknown },
	sessionId: string,
	entry: PoolEntry,
	enabled: boolean,
) {
	const active = entry.session.setAdvisorEnabled(enabled);
	const error = enabled && !active ? hostI18n.t("errors.advisorNoModel") : undefined;
	pushAdvisorMode(ws, sessionId, entry, error);
}
