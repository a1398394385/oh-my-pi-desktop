// Continuous session-title refresh: regenerate the title after every settled
// turn when the desktop switch is on (deepseek-harness "regenerate per user
// message" behavior). The base only titles untitled sessions once, so this is
// desktop-only; user-renamed sessions (titleSource "user") are never touched
// because the base's setSessionName refuses auto renames there anyway.
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";
import { buildReplanTitleContext } from "@oh-my-pi/pi-coding-agent/session/messages";

// Structural slice of PoolEntry; importing the full type would add a
// session-titles.ts→state.ts edge to check-host-boundaries for one field.
type TitleEntry = {
	session: { messages: Parameters<typeof buildReplanTitleContext>[0]; generateTitle: (text: string, extra: undefined, signal: AbortSignal) => Promise<string | null | undefined>; titleGenerationSignal: AbortSignal };
	manager: { titleSource: string | undefined; getSessionName(): string | undefined; setSessionName(name: string, source: "auto" | "user"): Promise<void> | void };
};

/** Whether per-turn title refresh is enabled (sessionTitles.refresh, off by default). */
export function readSessionTitleRefresh(): boolean {
	return readDesktopSection("sessionTitles").refresh === true;
}

/** Write sessionTitles.refresh back (merge-write preserves the section's other fields). */
export function writeSessionTitleRefresh(enabled: boolean): void {
	writeDesktopSection("sessionTitles", { ...readDesktopSection("sessionTitles"), refresh: enabled });
}

// Per-entry in-flight flag; WeakMap avoids widening the shared PoolEntry type.
const inFlight = new WeakSet<object>();

/**
 * Maybe regenerate the session title after a terminal agent_end. Fire-and-forget:
 * must never throw into the turn-end path. The base's own first-title generation
 * may still be in flight; both writes use "auto" source, so last write wins and
 * nothing gets pinned — acceptable.
 */
export function maybeRefreshSessionTitle(entry: TitleEntry): void {
	try {
		if (!readSessionTitleRefresh()) return;
		if (entry.manager.titleSource === "user") return;
		if (inFlight.has(entry)) return;
		const context = buildReplanTitleContext(entry.session.messages);
		if (!context) return;
		inFlight.add(entry);
		void (async () => {
			try {
				const title = await entry.session.generateTitle(
					context,
				undefined,
					entry.session.titleGenerationSignal,
				);
				if (!title || title === entry.manager.getSessionName()) return;
				await entry.manager.setSessionName(title, "auto");
			} catch (err) {
				console.warn("[session-titles] title refresh failed:", err);
			} finally {
				inFlight.delete(entry);
			}
		})();
	} catch (err) {
		console.warn("[session-titles] title refresh gate failed:", err);
	}
}
