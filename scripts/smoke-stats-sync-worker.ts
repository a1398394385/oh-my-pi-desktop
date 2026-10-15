// Regression smoke for the stats sync worker path in the compiled omp-host
// artifact (BUG-040): on Windows every usage-stats sync used to fail with
// `ModuleNotFound resolving "B:\~BUN\root\sync-worker.ts"` because the desktop
// host never declared itself as a worker host (and the runCli dispatch of the
// stats selector never evaluated the worker module in single-file compile).
// This smoke boots the artifact headless on the test profile with a synthetic
// transcript, kicks /api/events, and asserts the live sync settles idle with
// the fixture file counted. Run after `bun run host:build`.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-stats-sync-worker.ts [artifact path]
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

const hostBin = process.argv[2] ?? path.join(import.meta.dir, "..", "host-dist", "omp-host.exe");
if (!fs.existsSync(hostBin)) throw new Error(`artifact not found: ${hostBin} (run bun run host:build first)`);

// A fresh transcript per run so file_offsets can never skip the parse pass.
const FIXTURE_DIR_NAME = "-smoke-stats-sync-worker";
const sessionsDir = getSessionsDir();
const fixtureDir = path.join(sessionsDir, FIXTURE_DIR_NAME);
fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureFile = path.join(fixtureDir, `session-${Date.now()}.jsonl`);
const entry = {
	type: "message",
	id: "m1",
	timestamp: Date.now(),
	message: {
		role: "assistant",
		content: [{ type: "text", text: "fixture reply" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-3-5-haiku-20241022",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.0001 },
	},
};
fs.writeFileSync(fixtureFile, `${JSON.stringify(entry)}\n`, "utf8");

const proc = Bun.spawn([hostBin], {
	stdout: "pipe",
	stderr: "pipe",
	env: { ...process.env, OMP_PROFILE: "omp-desktop-test" },
});

let failures = 0;
const fail = (message: string): void => {
	failures++;
	console.error(`FAIL: ${message}`);
};

try {
	// The host prints `READY ws://127.0.0.1:<port>` once its server listens.
	const stdoutReader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let readyBuf = "";
	let port = "";
	const readyDeadline = Date.now() + 20_000;
	while (!port && Date.now() < readyDeadline) {
		const { value, done } = await stdoutReader.read();
		if (done) break;
		readyBuf += decoder.decode(value);
		const m = readyBuf.match(/READY ws:\/\/127\.0\.0\.1:(\d+)/);
		if (m) port = m[1]!;
	}
	if (!port) {
		fail("host never printed a READY line");
		throw new Error("abort");
	}
	console.log(`host READY on ${port}`);

	// /api/events starts statsLive (a full sync) and streams status snapshots.
	const res = await fetch(`http://127.0.0.1:${port}/api/events`);
	if (res.status !== 200) {
		fail(`/api/events HTTP ${res.status}`);
		throw new Error("abort");
	}
	const bodyReader = res.body!.getReader();
	let sseBuf = "";
	let phase = "";
	let error: string | null = null;
	let total = 0;
	const settleDeadline = Date.now() + 60_000;
	settle: while (Date.now() < settleDeadline) {
		const { value, done } = await bodyReader.read();
		if (done) break;
		sseBuf += decoder.decode(value);
		for (const m of sseBuf.matchAll(/data: (.+)\n/g)) {
			const status = JSON.parse(m[1]!) as { sync: { phase: string; total: number; error: string | null } };
			phase = status.sync.phase;
			total = status.sync.total;
			error = status.sync.error;
			console.log(`phase=${phase} total=${total} err=${error ?? "-"}`);
			if (phase === "idle" || phase === "error") break settle;
		}
	}
	await bodyReader.cancel().catch(() => {});

	if (phase !== "idle") fail(`sync did not settle idle (phase=${phase}, error=${error ?? "none"})`);
	if (total < 1) fail(`fixture transcript not counted (total=${total})`);
} catch (err) {
	if (failures === 0) fail(`unexpected: ${err instanceof Error ? err.message : String(err)}`);
} finally {
	proc.kill();
	fs.rmSync(fixtureDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error("smoke-stats-sync-worker: FAILED");
	process.exit(1);
}
console.log("smoke-stats-sync-worker: all checks passed");
