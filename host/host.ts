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

const argv = process.argv.slice(2);
if (argv.length === 0) {
	augmentGuiPath();
	await import("./main.ts");
} else {
	const { declareWorkerHostEntry } = await import("@oh-my-pi/pi-utils/worker-host");
  // Mirror the CLI process entry (the isProcessEntry branch in cli.ts): this
  // process is the dispatch entry, so register as a legitimate worker host,
  // letting worker subprocesses (e.g. stats activity) spawn further worker
  // threads.
	declareWorkerHostEntry();
	const { runCli } = await import("@oh-my-pi/pi-coding-agent/cli");
	await runCli(argv);
	process.exit(0);
}
