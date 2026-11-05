// 18.5 async background jobs (auto-backgrounded bash/eval, background task tools):
// bg_jobs frame assembly shared by the RPC reply (rpc/session.ts get_bg_jobs /
// cancel_bg_job) and the host-side corrections (session-lifecycle.ts load backlog +
// turn_start broadcast).
import { stampEvent, type PoolEntry } from "./state.ts";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";

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
	// One-line "what it does / when it ends" from the base's job-widget authoring
	// (AsyncJobSnapshotItem.caption; unset with async.widgets off).
	caption: string | null;
	// Live widget view (title/headline/stage/blocks); null for settled jobs and
	// while the base has no registry.
	widget: JobWidgetView | null;
}

// Background job rows for the bg_jobs frame: snapshot list (running + recent, already
// owner-scoped by the base) enriched per id with inspection data. Deduped by id in
// case a row transitions between lists. `type`/`label` come off the snapshot item
// itself: process-less jobs (eval cells, task rows) have no command, so the label is
// their only title.
export function bgJobsPayload(session: PoolEntry["session"]): BgJobRow[] {
	const snapshot = session.getAsyncJobSnapshot?.();
	if (!snapshot) return [];
	const rows = new Map<string, { id: string; status?: string; type?: string; label?: string; caption?: string }>();
	for (const job of [...(snapshot.running ?? []), ...(snapshot.recent ?? [])]) rows.set(job.id, job);
	// One call builds the id→view map for the whole frame; the base returns [] with
	// widgets off or no registry, so every row then gets null.
	const widgets = new Map((session.getRunningJobWidgets?.() ?? []).map((w) => [w.id, w.view]));
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
			caption: typeof job.caption === "string" && job.caption ? job.caption : null,
			widget: widgets.get(job.id) ?? null,
		};
	});
}

// Live bg_jobs refresh: a job's widget and caption advance from its streamed output
// with no session event, so while any job runs the snapshot is re-pushed. 1500ms per
// session: one lightweight frame per tick, and a text widget gains nothing faster.
const BG_JOBS_REFRESH_MS = 1500;

export interface BgJobsRefresh {
	/** Push the snapshot now when a job is running (or just settled since the last
	 *  frame) and arm the ticker. */
	sync(): void;
	/** Stop the ticker (entry.unsubscribe). */
	stop(): void;
}

export function createBgJobsRefresh(
	session: PoolEntry["session"],
	sessionId: string,
	bus: { send(data: string): unknown },
): BgJobsRefresh {
	// Latch: after the last running job settles, one more frame clears the UI badge
	// even though nothing is running.
	let hadRunning = false;
	let timer: NodeJS.Timeout | null = null;
	const push = (): boolean => {
		const jobs = bgJobsPayload(session);
		const running = jobs.some((j) => j.running);
		if (running || hadRunning) bus.send(JSON.stringify(stampEvent({ type: "bg_jobs", sessionId, jobs })));
		hadRunning = running;
		return running;
	};
	const stop = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};
	return {
		sync: () => {
			if (!push()) return stop();
			if (timer) return;
			timer = setInterval(() => {
				if (!push()) stop();
			}, BG_JOBS_REFRESH_MS);
			timer.unref?.();
		},
		stop,
	};
}
