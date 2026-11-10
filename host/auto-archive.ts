// Auto-archive configuration: the retention window offered by the settings
// page and the pure rule that decides which sessions a scan may archive.
//
// Storage: the omp-desktop.json "autoArchive" section (per profile), same
// pattern as the other desktop-owned switches (sessionTitles / keepalive /
// autoReview). The scan reads the section fresh on every tick, so a profile
// switch needs no re-arm.
//
// This module stays a leaf (desktop-json only) so the settings frame can
// project the values without pulling the scan (and the session RPC layer)
// into its import graph; the scan itself lives in auto-archive-sweep.ts.
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";

/** Retention windows offered by the settings dropdown (days). The UI reads
    the same list from the settings frame, so the two never drift apart. */
export const AUTO_ARCHIVE_RETENTION_DAYS = [7, 14, 30, 90] as const;

/** Fallback when the stored value is missing or out of range. */
export const AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS = 14;

export interface AutoArchiveConfig {
	enabled: boolean;
	retentionDays: number;
}

/** Read the autoArchive section (missing file / section -> defaults). */
export function readAutoArchiveConfig(): AutoArchiveConfig {
	const section = readDesktopSection("autoArchive");
	const days = Number(section.retentionDays);
	return {
		enabled: section.enabled === true,
		retentionDays: (AUTO_ARCHIVE_RETENTION_DAYS as readonly number[]).includes(days) ? days : AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS,
	};
}

/** Merge-write the autoArchive section (sibling sections and unmentioned
    fields of this section survive). */
export function writeAutoArchiveConfig(patch: { enabled?: boolean; retentionDays?: number }): AutoArchiveConfig {
	const current = readAutoArchiveConfig();
	const next = { ...current, ...patch };
	writeDesktopSection("autoArchive", { enabled: next.enabled, retentionDays: next.retentionDays });
	return next;
}

/** One session as the scan sees it: the on-disk path, the comparison key and
    the last-activity timestamp. */
export interface AutoArchiveRow {
	path: string;
	key: string;
	modified: Date;
}

/**
 * Rows whose last activity predates the cutoff and that are not excluded.
 * Pure, so the retention rules can be tested without touching the disk.
 */
export function selectAutoArchiveCandidates(rows: AutoArchiveRow[], cutoffMs: number, excludedKeys: Set<string>): string[] {
	const candidates: string[] = [];
	for (const row of rows) {
		if (row.modified.getTime() >= cutoffMs) continue;
		if (excludedKeys.has(row.key)) continue;
		candidates.push(row.path);
	}
	return candidates;
}
