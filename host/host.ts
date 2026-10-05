// Thin host entry (main module of the compiled artifact).
//
// argv routing: zero args = desktop host (the Tauri shell never spawns with
// args), dynamically loading main.ts; non-empty = run as the CLI, handing off
// to the SDK's runCli. The latter covers `__omp_worker_*` selectors: in
// compiled form the SDK re-enters worker subprocesses into the current
// executable (worker-client.ts resolveWorkerSpawnCmd → [process.execPath,
// workerArg]). The omp CLI itself dispatches these selectors in cli.ts; if this
// artifact did not dispatch them, every worker would be started as a full
// desktop host — never exiting, each resident at ~250MB; on Windows the daemon
// broker client retries after its 10s connect timeout, leaking one host
// process every 10s (unbounded memory growth, BUG-026).
//
// The routing must happen before the host's static graph is evaluated (ESM
// static imports run before any top-level code), so the host body lives in
// main.ts and the worker path only dynamically pulls the light CLI entry
// (whose static graph excludes runtime loading of the TUI and native addons).
// The GUI-launched host has a stripped PATH (nvm/Homebrew commands invisible):
// fire the PATH augment before loading the body (overlapping main.ts's static
// graph load incl. the SDK); main.ts awaits the same promise.
import { augmentGuiPath } from "./gui-path.ts";
import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";

// Declare in BOTH branches, before any dynamic import: this entry dispatches
// `__omp_worker_*` selectors (below), and the desktop host itself spawns
// in-process worker THREADS that re-enter it via workerHostEntry() (stats sync
// parse workers in omp-stats createSyncWorker, js_eval workers in eval/js).
// Without the declaration the desktop branch leaves workerHostEntry() null and
// those spawns fall back to the bundled worker-module URL — inside the compiled
// artifact that resolves to the virtual embedded path (B:\~BUN\root\*.ts),
// which Bun cannot load as a worker entry on Windows, so every stats sync
// fails with ModuleNotFound (darwin stats stays on the serial parse path and
// never spawns, masking the bug there).
declareWorkerHostEntry();

const argv = process.argv.slice(2);
if (argv.length === 0) {
	augmentGuiPath();
	await import("./main.ts");
} else if (argv[0] === "__omp_worker_stats_sync") {
	// Stats sync worker THREAD (omp-stats createSyncWorker re-enters this
	// executable via workerHostEntry). Dispatched here instead of through
	// runCli: in single-file compile Bun rewrites cli.ts's dynamic import of
	// the zero-export sync-worker module into a lazy factory invocation that
	// never evaluates the module body, so the dispatched worker keeps the
	// dispatcher's buffering onmessage and never answers — every stats sync
	// hangs on Windows (macOS never spawns parse workers; see
	// defaultWorkerCount). Importing the module from this entry evaluates it
	// correctly; its top-level `self.onmessage` IS the worker.
	// Park early messages the parent may post before the module is live
	// (same replay scheme as cli.ts runWorkerEntrypoint).
	const scope: { onmessage: ((event: MessageEvent) => void) | null } = globalThis;
	const pending: MessageEvent[] = [];
	scope.onmessage = event => pending.push(event);
	await import("@oh-my-pi/omp-stats/sync-worker");
	const handler = scope.onmessage;
	if (handler) for (const event of pending) handler(event);
	// Hold the worker thread's event loop open until the parent terminates it.
	setInterval(() => {}, 2 ** 30);
} else {
	const { runCli } = await import("@oh-my-pi/pi-coding-agent/cli");
	await runCli(argv);
	process.exit(0);
}
