// Regression for the auto-archive selection rule (host/auto-archive.ts).
// The rule decides which sessions the hourly scan may archive, so the two
// invariants under test are:
//   1. only sessions whose last activity predates the retention window are
//      candidates (the boundary second itself is NOT older than the window),
//   2. excluded sessions (already archived / pinned / pooled) never enter the
//      candidate list even when their activity is old enough.
import { expect, test } from "bun:test";
import { selectAutoArchiveCandidates, type AutoArchiveRow } from "../host/auto-archive.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 10);
const CUTOFF = NOW - 14 * DAY;

function row(path: string, daysAgo: number, key = path): AutoArchiveRow {
	return { path, key, modified: new Date(NOW - daysAgo * DAY) };
}

test("only sessions older than the window are candidates", () => {
	const rows = [row("/s/old", 20), row("/s/fresh", 3), row("/s/boundary", 14)];
	expect(selectAutoArchiveCandidates(rows, CUTOFF, new Set())).toEqual(["/s/old"]);
});

test("excluded sessions never become candidates", () => {
	const rows = [row("/s/pinned", 30), row("/s/archived", 30), row("/s/pooled", 30), row("/s/free", 30)];
	const excluded = new Set(["/s/pinned", "/s/archived", "/s/pooled"]);
	expect(selectAutoArchiveCandidates(rows, CUTOFF, excluded)).toEqual(["/s/free"]);
});

test("a session exactly at the window edge is kept", () => {
	// modified === cutoff means "not older than the window": the scan must wait
	// one more tick instead of archiving it on the boundary.
	const rows = [row("/s/edge", 0)];
	const cutoff = rows[0].modified.getTime();
	expect(selectAutoArchiveCandidates(rows, cutoff, new Set())).toEqual([]);
});
