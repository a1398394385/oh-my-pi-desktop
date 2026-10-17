// 18.5 async background jobs (auto-backgrounded bash/eval, background task tools):
// bg_jobs frame assembly shared by the RPC reply (rpc/session.ts get_bg_jobs /
// cancel_bg_job) and the host-side corrections (session-lifecycle.ts load backlog +
// turn_start broadcast).
import type { PoolEntry } from "./state.ts";

/** One bg_jobs frame row: snapshot identity enriched with live inspection data
 *  (command/cwd only exist on process-backed jobs; pids are live only while running). */
export interface BgJobRow {
	id: string;
	type: string;
	label: string | null;
	command: string | null;
	cwd: string | null;
	pids: number[];
	exitCode: number | null;
	running: boolean;
}

// Background job rows for the bg_jobs frame: snapshot list (running + recent, already
// owner-scoped by the base) enriched per id with inspection data. Deduped by id in
// case a row transitions between lists. `type`/`label` come off the snapshot item
// itself: process-less jobs (eval cells, task rows) have no command, so the label is
// their only title.
export function bgJobsPayload(session: PoolEntry["session"]): BgJobRow[] {
	const snapshot = session.getAsyncJobSnapshot?.();
	if (!snapshot) return [];
	const rows = new Map<string, { id: string; status?: string; type?: string; label?: string }>();
	for (const job of [...(snapshot.running ?? []), ...(snapshot.recent ?? [])]) rows.set(job.id, job);
	return [...rows.values()].map((job) => {
		const inspected = session.inspectAsyncJob?.(job.id);
		return {
			id: job.id,
			type: typeof job.type === "string" ? job.type : "unknown",
			label: typeof job.label === "string" && job.label ? job.label : null,
			command: inspected?.command ?? null,
			cwd: inspected?.cwd ?? null,
			pids: Array.isArray(inspected?.pids) ? inspected.pids : [],
			exitCode: typeof inspected?.exitCode === "number" ? inspected.exitCode : null,
			running: job.status === "running",
		};
	});
}

/** turn_start correction decision: the frame to send plus the latch to store, or
 *  null when nothing needs to be sent. */
export interface BgJobsCorrection {
	jobs: BgJobRow[];
	hadRunning: boolean;
}

// turn_start correction broadcast: auto-backgrounded bash goes silent after the
// "Backgrounded as job" tool result (stopUpdates), and a finished job's async-result
// delivery resumes the loop as a fresh turn — so turn_start is the natural point to
// re-push the snapshot and let the UI drop the finished badge. Returns null when
// nothing needs to be sent (no running job and none since the last frame);
// `hadRunning` is the caller's per-session latch, fed back via .hadRunning.
export function bgJobsCorrection(session: PoolEntry["session"], hadRunning: boolean): BgJobsCorrection | null {
	const jobs = bgJobsPayload(session);
	const running = jobs.some((j) => j.running);
	if (!running && !hadRunning) return null;
	return { jobs, hadRunning: running };
}
