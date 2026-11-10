// Auto-archive scan: a periodic pass that files sessions whose last activity
// is older than the retention window into the archive list.
//
// What the scan leaves alone (mirrors the settings copy):
//   - already archived sessions (compared by normalized path: the archive
//     record keeps the spelling the request used, disk rows carry the base's
//     realpath — a bare string compare would file the same session twice)
//   - pinned sessions (the pin is the user's explicit "keep this around")
//   - sessions in the memory pool (open in a UI or running — archiving one
//     would evict a live session from under the user)
import { SessionManager } from "./bootstrap.ts";
import { applyActivityTimes } from "./activity-time.ts";
import { H, sessions } from "./state.ts";
import { saveDesktopProjects } from "./profile.ts";
import { retireAutomationsForPaths } from "./automations/store.ts";
import { readAutoArchiveConfig, selectAutoArchiveCandidates, type AutoArchiveRow } from "./auto-archive.ts";
import { refreshAllSessionLists } from "./rpc/session.ts";
import { safeStderr } from "./stderr.ts";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";

/** Scan cadence. Hourly: the retention window is measured in days, so a
    finer scan is indistinguishable to the user. */
const AUTO_ARCHIVE_SCAN_INTERVAL_MS = 60 * 60_000;

/** Normalized comparison key. The base's realpath spelling and the spelling
    the request used must not create two records for one session. */
function comparisonKey(p: string): string {
	try {
		return normalizePathForComparison(p);
	} catch {
		return p;
	}
}

/**
 * One scan pass. Returns how many sessions were archived.
 */
export async function runAutoArchiveSweep(): Promise<number> {
	const config = readAutoArchiveConfig();
	if (!config.enabled) return 0;

	const all = await SessionManager.listAll();
	// mtime tracks non-activity writes (session_exit frames); use the last
	// message time instead (same source the sidebar sorts by).
	await applyActivityTimes(all);

	// One realpath lookup per distinct path (the base hits the filesystem).
	const keyCache = new Map<string, string>();
	const key = (p: string): string => {
		let k = keyCache.get(p);
		if (k === undefined) {
			k = comparisonKey(p);
			keyCache.set(p, k);
		}
		return k;
	};

	const excluded = new Set<string>();
	for (const p of H.desktopProjects.archivedSessions) excluded.add(key(p));
	for (const p of H.desktopProjects.pinnedSessions) excluded.add(key(p));
	for (const entry of sessions.values()) {
		excluded.add(key(entry.path));
		for (const p of entry.previousPaths ?? []) excluded.add(key(p));
	}

	const rows: AutoArchiveRow[] = all.map((s) => ({ path: s.path, key: key(s.path), modified: s.modified }));
	const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
	const candidates = selectAutoArchiveCandidates(rows, cutoff, excluded);
	if (candidates.length === 0) return 0;

	for (const p of candidates) H.desktopProjects.archivedSessions.push(p);
	await saveDesktopProjects();
	// Archiving retires the session, so automations that deliver into it can
	// never run again (same semantics as the manual archive action).
	retireAutomationsForPaths(candidates, "archive");
	await refreshAllSessionLists();
	return candidates.length;
}

/** Background scan: never awaited by callers, failures reported and retried
    on the next tick instead of tearing the host down. */
export function triggerAutoArchiveSweep(): void {
	void runAutoArchiveSweep().catch((err) => {
		safeStderr(`[auto-archive] sweep failed: ${String(err)}\n`);
	});
}

/** Start the periodic scan. The timer is unref'd (never holds the process
    open) and the config is re-read on every tick, so a profile switch needs
    no re-arm. */
export function startAutoArchiveSweep(): void {
	// Sweep at startup too: the switch may have been on for weeks before this
	// host came up, and an hourly-only timer would leave that backlog in place.
	triggerAutoArchiveSweep();
	const timer = setInterval(triggerAutoArchiveSweep, AUTO_ARCHIVE_SCAN_INTERVAL_MS);
	timer.unref?.();
}
