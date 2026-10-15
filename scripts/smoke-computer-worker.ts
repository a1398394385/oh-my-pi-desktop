// Regression smoke for worker THREAD dispatch through the desktop host entry (BUG-044).
//
// host/host.ts ran `runCli(argv)` and then unconditionally `process.exit(0)`. The SDK re-enters this
// entry as a worker THREAD for the selectors that own their port directly (computer, browser tab,
// terminal output, eval): `runCli` returns as soon as the dispatched worker module has taken the
// message port, so the exit killed the thread right after its `ready` handshake. Every desktop
// computer-use call died with `Computer worker exited` before the native session was ever created
// (the stats-sync selector sidestepped it with its own branch, which is why only that one was caught).
//
// The host entry is exercised from source (`host/host.ts`) rather than from the compiled artifact:
// the SDK loads thread workers through `workerHostEntry()`, which inside a compiled artifact is the
// bun-internal embed path (`B:/~BUN/root/omp-host.exe`) and is not addressable from a plain bun
// process. Subprocess worker shapes off the artifact stay covered by scripts/smoke-worker-dispatch.ts.
//
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-computer-worker.ts [worker entry path]
import * as fs from "node:fs";
import * as path from "node:path";

// The worker inherits this process' env; force the isolated test profile before anything spawns.
process.env.OMP_PROFILE = "omp-desktop-test";
process.env.PI_PROFILE = "omp-desktop-test";

const entry = process.argv[2] ?? path.join(import.meta.dir, "..", "host", "host.ts");
if (!fs.existsSync(entry)) throw new Error(`worker entry not found: ${entry}`);

const COMPUTER_WORKER_ARG = "__omp_worker_computer";
const READY_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 20_000;

type Outbound =
	| { type: "ready" }
	| { type: "pong"; id: string }
	| { type: "closed" }
	| { type: "capabilities"; id: string; ok: boolean }
	| { type: "result"; id: string; ok: boolean };

const failures: string[] = [];
const fail = (message: string): void => {
	failures.push(message);
	console.error(`  ✗ ${message}`);
};

const waitFor = (worker: Worker, expected: Outbound["type"], timeoutMs: number): Promise<string | null> => {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const onMessage = (event: MessageEvent): void => {
		if ((event.data as Outbound)?.type !== expected) return;
		clearTimeout(timer);
		worker.removeEventListener("message", onMessage);
		resolve(null);
	};
	const timer = setTimeout(() => {
		worker.removeEventListener("message", onMessage);
		resolve(`${expected} timed out after ${timeoutMs}ms`);
	}, timeoutMs);
	worker.addEventListener("message", onMessage);
	return promise;
};

const worker = new Worker(entry, { type: "module", argv: [COMPUTER_WORKER_ARG] });

// The pre-fix failure mode: the host entry exits the thread as soon as runCli returns, so the worker
// is torn down without ever answering. Surface that as a first-class failure instead of a hang.
let exitReason: string | null = null;
worker.addEventListener("close", () => {
	exitReason ??= "worker thread exited before the close handshake completed";
});
worker.addEventListener("error", event => {
	fail(`worker error: ${String((event as ErrorEvent).message ?? event)}`);
});

console.log(`computer worker smoke: entry=${entry}`);

const readyError = await waitFor(worker, "ready", READY_TIMEOUT_MS);
if (readyError) fail(exitReason ?? `ready handshake failed: ${readyError}`);

if (failures.length === 0) {
	const pong = waitFor(worker, "pong", REPLY_TIMEOUT_MS);
	worker.postMessage({ type: "ping", id: `computer-smoke-${Date.now()}` });
	const pongError = await pong;
	if (pongError) fail(exitReason ?? `ping/pong failed: ${pongError}`);

	const closed = waitFor(worker, "closed", REPLY_TIMEOUT_MS);
	worker.postMessage({ type: "close" });
	const closeError = await closed;
	if (closeError) fail(exitReason ?? `close handshake failed: ${closeError}`);
}

await Promise.resolve(worker.terminate());

if (failures.length > 0) {
	console.error(`\ncomputer worker smoke: FAILED (${failures.length})`);
	process.exit(1);
}
console.log("computer worker smoke: all checks passed");
