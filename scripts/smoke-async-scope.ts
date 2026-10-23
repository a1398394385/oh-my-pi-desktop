// Async-delivery scope smoke: proves a background job's completion lands in the
// session that OWNS it, not in a sibling top-level session.
//
// Why this exists: base issues can1357/oh-my-pi#14967 / #15229. Before PR #15232
// ("fix(sdk): isolated async jobs for concurrent roots") a single Bun host handed an
// AsyncJobManager to the first top-level session only, so a later root ran with no
// manager at all and a sibling's job delivered its async result into the wrong
// transcript. We embed the SDK the same way (several top-level sessions in one host
// process), so that fix is load-bearing for us — and the reporter could not show a
// positive control: the misdelivery stopped, but nobody proved the owning session
// actually RECEIVED the result. Our Hub / background-command UI renders exactly that
// delivery (host/async-jobs.ts reads session.getAsyncJobSnapshot()), so this smoke
// asserts the receiving side.
//
//   A  isolation   two top-level sessions own distinct managers, both present
//   B  ownership   B's async job lives on B's manager and is invisible to A
//   C  delivery    B's result reaches B's transcript; A's transcript stays clean
//   D  dispose     disposing the sibling mid-flight does not cancel B's job
//
// Background work is driven through `bash` with `async: true` rather than a `task`
// subagent: both go through the same AsyncJobManager + per-agent delivery sink, but a
// child session resolves its model from the model catalog, which does not know the
// mock provider — so a subagent would fail with "No model selected" and never produce
// a payload to deliver.
//
// Mock model only (@oh-my-pi/pi-ai/providers/mock) — deterministic, no credentials,
// no network. All session data lands under OMP_PROFILE=omp-desktop-test.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-async-scope.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { SessionManager as SessionManagerType } from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@oh-my-pi/pi-ai";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { TEST_PROFILE } from "./smoke-profile.ts";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");
// Dynamic import exception: coding-agent resolves agentDir at import time, so the
// profile must already be active (same precedent as every other SDK smoke).
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { getAgentDir } = await import("@oh-my-pi/pi-utils");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

/** The payload only the background job can produce; its arrival proves delivery. */
const RESULT_MARK = "ASYNC-SCOPE-RESULT-3b9d";
/** Long enough that the sibling can be disposed while the job is genuinely running. */
const JOB_COMMAND = `sleep 1; echo ${RESULT_MARK}`;

const roots: string[] = [];
function scratch(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `async-scope-${label}-`));
	roots.push(dir);
	return dir;
}

interface WireMessage {
	role?: string;
	content?: unknown;
}

let parentTurns = 0;
const wireLog: string[] = [];

const mock = createMockModel({
	contextWindow: 200_000,
	handler: (context: Context): MockResponse => {
		const messages = context.messages as WireMessage[];
		if (wireLog.length < 10) wireLog.push(`${messages.length} msgs, last ${messages.at(-1)?.role}`);
		parentTurns++;
		if (parentTurns === 1) {
			return { content: [{ type: "toolCall", name: "bash", arguments: { command: JOB_COMMAND, async: true } }] };
		}
		return { content: [{ type: "text", text: `PARENT-ACK-${parentTurns}` }] };
	},
});

async function build(cwd: string, sessionManager: SessionManagerType) {
	const settings = Settings.isolated({}).overlay({ "compaction.enabled": false, "async.enabled": true });
	const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const { session } = await createAgentSession({
		cwd,
		settings,
		model: mock,
		modelRegistry: new ModelRegistry(authStorage, join(cwd, "models.yml")),
		agentRegistry: new AgentRegistry(),
		sessionManager,
		getApiKey: async () => "mock-key",
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: true,
	});
	return session;
}

const dump = (mgr: SessionManagerType) => JSON.stringify(mgr.getEntries());

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	assert.fail(`timeout waiting for ${label} (parentTurns=${parentTurns})\nwire: ${wireLog.join(" | ")}`);
}

// ---- two top-level sessions in one process ----

const cwdA = scratch("a");
const mgrA = SessionManager.create(cwdA);
assert.ok(mgrA.getSessionFile()!.startsWith(getAgentDir()), "session A must stay inside the smoke profile");
roots.push(join(mgrA.getSessionFile()!, ".."));
const A = await build(cwdA, mgrA);

const cwdB = scratch("b");
const mgrB = SessionManager.create(cwdB);
assert.ok(mgrB.getSessionFile()!.startsWith(getAgentDir()), "session B must stay inside the smoke profile");
roots.push(join(mgrB.getSessionFile()!, ".."));
const B = await build(cwdB, mgrB);

// ---- A: per-root manager isolation (the #15232 fix itself) ----

const mgrAJobs = A.asyncJobManager;
const mgrBJobs = B.asyncJobManager;
assert.ok(mgrAJobs, "session A must own an AsyncJobManager");
assert.ok(mgrBJobs, "session B must own an AsyncJobManager");
assert.notEqual(mgrAJobs, mgrBJobs, "each top-level session must own a DISTINCT AsyncJobManager");
console.log("A: two roots, two managers — distinct");

// ---- B: the job is registered on B and invisible to A ----

void B.prompt("run it in the background").catch((error: unknown) => {
	console.error("B prompt rejected:", error);
});
await waitFor(() => (B.getAsyncJobSnapshot()?.running.length ?? 0) > 0, "B to register a background job");
const jobId = B.getAsyncJobSnapshot()!.running[0]!.id;
console.log("B: background job owned by B:", jobId);
assert.equal(A.getAsyncJobSnapshot()?.running.length ?? 0, 0, "A must not see B's job in its snapshot");
assert.ok(mgrBJobs.getJob(jobId), "B's job must live on B's own manager");
assert.ok(!mgrAJobs.getJob(jobId), "B's job must not be reachable through A's manager");

// ---- D: disposing the sibling mid-flight must not touch B's job ----

await A.dispose();
await mgrA.close();
console.log("D: sibling A disposed while B's job is in flight");

// ---- C: the result is delivered into B ----

await waitFor(() => dump(mgrB).includes(RESULT_MARK), "the background result to reach B's transcript");
await B.settleAsyncWork?.();
await waitFor(() => (B.getAsyncJobSnapshot()?.running.length ?? 0) === 0, "B's job to settle");

assert.ok(dump(mgrB).includes(RESULT_MARK), "C: the owner's transcript carries the job result");
assert.equal(parentTurns >= 2, true, "C: the async delivery re-woke the owner's loop");

// A was disposed mid-flight; its transcript is the on-disk evidence that nothing of
// B's work was ever routed into the sibling session.
assert.ok(!dump(mgrA).includes(RESULT_MARK), "the sibling transcript must never receive the job result");

console.log("C: result delivered to the owner, sibling transcript clean (parent turns:", parentTurns, ")");
console.log("smoke-async-scope: PASS");
console.log("  A two top-level sessions own distinct AsyncJobManagers");
console.log("  B the background job lives on the owner's manager only");
console.log("  C the owner's transcript carries the result; the sibling's stays clean");
console.log("  D disposing the sibling mid-flight does not cancel the owner's job");

await B.dispose();
await mgrB.close();
// Windows keeps a scratch dir busy for a moment after the handles close (the auth
// db is still being flushed); retry briefly, then leave the temp dir behind.
for (const dir of roots) {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			break;
		} catch {
			await Bun.sleep(200);
		}
	}
}
process.exit(0);
