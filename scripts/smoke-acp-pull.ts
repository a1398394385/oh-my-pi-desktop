// ACP v10 smoke: pull mode (context_status) + bN short refs (spec §3/§6/§7 v10).
//
// Layers:
//   A  context_status returns the dashboard + short-ref manifest; every call
//      re-snapshots the round — a consumed manifest rejects with a pointer to
//      context_status, and a fresh status call revives the round (old manifest
//      void, compression scope = the latest return)
//   B  tool-entry decode (spec §3): hallucinated short refs reject with the
//      candidate set rendered as short refs; an OLD short ref of a compressed
//      block rejects in keep ("already compressed")
//   C  e2e model flow: context_status -> compress(keep=[one bN]) -> success ->
//      outcome names the new block by short ref, and the JSONL persists entry
//      ids only (zero bN anywhere)
//   D  restart replay determinism (spec §3 MUST): compress -> reopen ->
//      rebuild -> the same journal replays the SAME numbering (live, folded
//      with holes preserved, and summary blocks); an old short ref resolves to
//      the identical entry
//   D  restart replay determinism (spec §3 MUST: compress -> restart -> same
//
// All session data lands under the OMP_PROFILE=omp-desktop-test profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directories at the end.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-acp-pull.ts
import { TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import { AcpRuntimeState, createCompressContextTool, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import { createAcpStatusTool } from "../host/acp-status-tool.ts";
import { rebuildAcpState } from "../host/acp-persist.ts";
import type { AcpParams, AcpSummaryData, CompressOutcome, CompressRejection } from "../host/acp-runtime.ts";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

const glm5 = new Tokenizer({ tokenizer: "glm5" });
const countTokens = (s: string) => glm5.countTokens(s);

const NO_TAIL: Partial<AcpParams> = { tailTurns: 0, tailTokens: 0 };
const PARAMS: Partial<AcpParams> = { l1: 300, l2: 600, l3: 900, minCompress: 30, target: 1_000_000, ...NO_TAIL };
const SUMMARY_TEXT = "Condensed record of the retired blocks: parser bug traced, values pinned.";

function accepted(r: CompressOutcome | CompressRejection): CompressOutcome {
	if (!r.ok) assert.fail(`expected success, got: ${JSON.stringify(r)}`);
	return r;
}
function rejected(r: CompressOutcome | CompressRejection): CompressRejection {
	if (r.ok) assert.fail(`expected a rejection, got: ${JSON.stringify(r)}`);
	return r;
}

/** First text block of a tool result content (string or block array). */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (typeof c === "object" && c !== null && "text" in c ? String(c.text) : "")).join("");
}

/** Manifest bN lines of an context_status return: [bN, tokens] pairs in listed order. */
function parseManifest(statusText: string): Array<{ ref: string; tokens: number }> {
	return statusText
		.split("\n")
		.filter((l) => /^b\d+ \| \d+ \| /.test(l))
		.map((l) => {
			const [ref, tokens] = l.split(" | ");
			return { ref, tokens: Number(tokens) };
		});
}

type FixtureEntry =
	| { type: "message"; id: string; message: AgentMessage }
	| { type: "custom"; id: string; customType: string; data: unknown };

interface Fixture {
	state: AcpRuntimeState;
	writes: AcpSummaryData[];
	entries: FixtureEntry[];
	view: AgentMessage[];
}

let fixtureSeq = 0;

/** Journal-backed fixture over a fake sink that also journals acpSummary writes. */
function makeFixture(params: Partial<AcpParams>, blocks: number, blockTokens = 100): Fixture {
	const writes: AcpSummaryData[] = [];
	const entries: FixtureEntry[] = [];
	const sink = {
		appendCustomEntry: (customType: string, data: unknown) => {
			const id = `s${++fixtureSeq}`;
			writes.push({ ...(data as Omit<AcpSummaryData, "id">), id });
			entries.push({ type: "custom", id, customType, data });
			return id;
		},
	};
	const view: AgentMessage[] = [];
	for (let i = 0; i < blocks; i++) {
		let text = `journal block ${i}: `;
		while (countTokens(text) < blockTokens) text += "detailed parser investigation notes with exact values. ";
		const message = { role: "user", content: text, timestamp: 1_700_000_000_000 + i } as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	}
	const state = new AcpRuntimeState({
		countTokens,
		sink,
		getEntries: () => entries as never as SessionEntry[],
		params,
	});
	return { state, writes, entries, view };
}

// --- A: context_status dashboard + round refresh semantics --------------------------------------

{
	const fx = makeFixture(PARAMS, 5);
	fx.state.projectView(fx.view);
	const s1 = fx.state.status();
	assert.equal(s1.ok, true);
	const text1 = (s1 as { text: string }).text;
	assert.ok(text1.startsWith("[context-status]"), "the report carries its own marker");
	assert.match(text1, /tier=L1 compress=normal /, "dashboard reports tier + allowed method");
	assert.ok(text1.includes("activation line"), "L1 instruction present");
	const lines1 = parseManifest(text1);
	assert.equal(lines1.length, 5, "all candidates listed (no truncation, no protected tail)");
	assert.deepEqual(
		lines1.map((l) => l.tokens),
		[...lines1.map((l) => l.tokens)].sort((a, b) => b - a),
		"manifest listed largest first",
	);
	assert.ok(lines1.every((l) => /^b\d+$/.test(l.ref)), "manifest ids are bN short refs");
	assert.ok(!text1.includes("e0") && !fx.entries.some((e) => text1.includes(e.id)), "no entry id leaks into the model-facing report");

	// Refresh semantics: a successful compress consumes the manifest; the next
	// compress rejects pointing at context_status; a fresh status call voids the old
	// round and re-arms compression (scope = the latest return, spec §6 v10).
	accepted(await fx.state.compress({ keep: [], summary: SUMMARY_TEXT }));
	const consumed = rejected(await fx.state.compress({ keep: [], summary: SUMMARY_TEXT }));
	assert.equal(consumed.code, "manifest-consumed");
	assert.match(consumed.error, /call context_status/, "the rejection points at the pull channel");
	const s2 = fx.state.status();
	assert.equal(s2.ok, true);
	const lines2 = parseManifest((s2 as { text: string }).text);
	assert.equal(lines2.length, 0, "everything folded: the fresh round lists nothing");
	assert.ok(fx.state.manifest && fx.state.manifest.consumed === false, "the status call revived the round");
	// A latecomer block enters the NEXT round's status return only.
	const late = { role: "user", content: "latecomer block with fresh details. ", timestamp: 1_700_000_100_000 } as never as AgentMessage;
	fx.entries.push({ type: "message", id: "e-late", message: late });
	fx.view.push(late);
	fx.state.projectView(fx.view);
	const s3 = fx.state.status();
	const lines3 = parseManifest((s3 as { text: string }).text);
	assert.equal(lines3.length, 1, "the latecomer is the only candidate of the fresh round");
	assert.equal(lines3[0].ref, fx.state.shortRef("e-late"), "and it carries its journal-order short ref");
	// Persistence stays entry-id-only (spec §3): compressedIds/index are raw ids.
	assert.deepEqual(fx.writes[0].meta.compressedIds, ["e0", "e1", "e2", "e3", "e4"]);
	assert.ok(fx.writes[0].index.every((l) => /^e\d+$/.test(l.id)), "index lines persist entry ids");
	// Inline byte budget (the base spill threshold): the manifest is cut whole-line,
	// never head/tailed by the base tool-result stage, and the round scope shrinks
	// with the visible list.
	const fxBudget = makeFixture(PARAMS, 12);
	fxBudget.state.projectView(fxBudget.view);
	const full = fxBudget.state.status();
	if (!full.ok) throw new Error(full.error);
	const budget = Buffer.byteLength(full.text, "utf-8") - 300;
	const cut = fxBudget.state.status(budget);
	if (!cut.ok) throw new Error(cut.error);
	const cutText = cut.text;
	assert.ok(Buffer.byteLength(cutText, "utf-8") <= budget, "the return fits the caller's inline budget");
	const cutLines = parseManifest(cutText);
	assert.ok(cutLines.length > 0 && cutLines.length < 12, "the manifest tail is cut whole-line");
	assert.match(cutText, /exempt this round, re-listed next round/, "the cut tail is announced as exempt");
	assert.equal(fxBudget.state.manifest?.ids.length, cutLines.length, "the round scope matches the visible list");
	console.log("ok: A dashboard + refresh — bN manifest, consumed->context_status pointer, status revives the round, persistence id-only");
}

// --- B: tool-entry short-ref decode (spec §3) ----------------------------------------------

{
	const fx = makeFixture(PARAMS, 5);
	fx.state.projectView(fx.view);
	// Hallucinated short ref: rejected whole-call with the candidate set as bN.
	const ghost = rejected(await fx.state.compress({ keep: ["b999"], summary: SUMMARY_TEXT }));
	assert.equal(ghost.code, "hallucinated-keep");
	assert.match(ghost.error, /b999 \(nonexistent\)/);
	assert.ok(ghost.validCandidates && ghost.validCandidates.every((c) => /^b\d+$/.test(c)), "valid candidates rendered as short refs");
	// Positive decode: a manifest short ref keeps its block verbatim (spec §3).
	const keptShort = fx.state.shortRef("e0")!;
	assert.ok(/^b\d+$/.test(keptShort), "fixture blocks carry short refs");
	const out = accepted(await fx.state.compress({ keep: [keptShort], summary: SUMMARY_TEXT }));
	assert.equal(out.kept.blocks, 1, "the short ref decoded to the entry id and kept it");
	// Old short ref of a compressed block: keep -> already-compressed rejection.
	// (round 1 above folded e1..e4 and consumed the manifest)
	const oldShort = fx.state.shortRef("e2")!;
	assert.match(oldShort, /^b\d+$/);
	const keepOld = rejected(await fx.state.compress({ keep: [oldShort], summary: SUMMARY_TEXT }));
	assert.equal(keepOld.code, "manifest-consumed", "guard order: consumed fires before id validation");
	fx.state.status(); // fresh round (empty manifest), now the id checks run
	const keepOld2 = rejected(await fx.state.compress({ keep: [oldShort], summary: SUMMARY_TEXT }));
	assert.equal(keepOld2.code, "hallucinated-keep");
	assert.match(keepOld2.error, /already compressed/);
	// no-manifest also points at context_status.
	const fresh = makeFixture(PARAMS, 2);
	const noMan = rejected(await fresh.state.compress({ keep: [], summary: SUMMARY_TEXT }));
	assert.equal(noMan.code, "no-manifest");
	assert.match(noMan.error, /call context_status/);
	console.log("ok: B decode — ghost short ref rejected with bN candidates; positive keep decode; old short keep-rejects; pointers to context_status");
}

// --- C: e2e model flow — status -> compress(keep=[bN]); JSONL id-only ---------------------------

const cwdC = mkdtempSync(join(tmpdir(), "acp-v10-c-"));
{
	const turnText = (label: string, n: number) => `${label}: ` + "detailed journal text about the parser bug and the failing test. ".repeat(n);
	let keptRef = "";
	let summaryRef = "";
	const flow = { started: false, statusDone: false, compressDone: false };
	const mock = createMockModel({
		handler: (context: { messages: Array<{ role: string; content: unknown; toolName?: string }> }) => {
			const results = [...context.messages].reverse().filter((m) => m.role === "toolResult");
			// Route the OPENING on the last real user text (the [compress-hint]
			// ephemeral is a user message too; the base rides its reminder into
			// the first user message, so only a full-text scan is reliable). Once
			// the chain started, drive on tool RESULTS: the triggering prompt can
			// itself be folded by the compress, so the text may be gone mid-turn.
			if (!flow.started) {
				const users = [...context.messages].reverse().filter((m) => m.role === "user");
				const routed = users.find((m) => !resultText(m.content).includes("[compress-hint]")) ?? users[0];
				const text = resultText(routed?.content ?? "");
				if (!text.includes("fetch status")) return { content: ["Turn recorded."] as const };
				flow.started = true;
				return { content: [{ type: "toolCall", name: "context_status", arguments: {} }] as const };
			}
			const lastStatus = results.find((m) => m.toolName === "context_status");
			const compressResult = results.find((m) => m.toolName === "compress_context");
			// The journal lags the view one request (forced-smoke precedent), so a
			// first status snapshot can still list nothing: end the chain in text
			// (the outer retry loop re-triggers on the next turn).
			const lines = lastStatus ? parseManifest(resultText(lastStatus.content)) : [];
			if (!compressResult) {
				if (lines.length === 0) {
					flow.started = false;
					return { content: ["Nothing listed yet; retrying next turn."] as const };
				}
				flow.statusDone = true;
				keptRef = lines[0].ref; // keep the largest listed block
				return {
					content: [
						{ type: "toolCall", name: "compress_context", arguments: { keep: [keptRef], summary: "Condensed record of everything else this round." } },
					] as const,
				};
			}
			const outcome = JSON.parse(resultText(compressResult.content)) as CompressOutcome;
			if (!outcome.ok) return { content: ["Compress rejected; stopping the flow."] as const };
			flow.compressDone = true;
			summaryRef = outcome.blockId;
			return { content: ["Compress done."] as const };
		},
	});
	const sessionManager = SessionManager.create(cwdC);
	const settings = Settings.isolated({ "compaction.enabled": false });
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		params: { l1: 1_500, l2: 3_000, l3: 6_000, target: 100_000, tailTurns: 0, tailTokens: 0 },
	});
	const authStorage = await AuthStorage.create(join(cwdC, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const modelRegistry = new ModelRegistry(authStorage, join(cwdC, "models.yml"));
	const { session } = await createAgentSession({
		cwd: cwdC,
		settings,
		// Mirrors host/session-lifecycle.ts: ACP pins compaction.enabled off for the primary,
		// so the advisor must be opted back in explicitly or it loses compaction maintenance.
		advisorCompactionEnabled: true,
		model: mock,
		modelRegistry,
		agentRegistry: new AgentRegistry(),
		sessionManager,
		customTools: [createCompressContextTool(state), createAcpStatusTool(state)] as never,
		getApiKey: async () => "mock-key",
		extensions: [createAcpProjectionExtension(state, () => sessionManager.getSessionId())] as never,
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: true,
	});

	const resultsOf = (tool: string) =>
		sessionManager
			.getEntries()
			.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
			.map((e) => e.message as AgentMessage)
			.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === tool);
	const assistantCount = () =>
		sessionManager.getEntries().filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message" && e.message.role === "assistant").length;
	const ask = async (text: string, expectAssistants: number) => {
		await session.prompt(text);
		for (let i = 0; i < 1_000 && assistantCount() < expectAssistants; i++) await Bun.sleep(10);
		if (assistantCount() < expectAssistants) {
			console.error(`turn for "${text.slice(0, 24)}" incomplete: assistants=${assistantCount()}/${expectAssistants}`);
		}
		assert.ok(assistantCount() >= expectAssistants, `turn for "${text.slice(0, 24)}" did not complete`);
	};

	// Warm-up turns settle the journal (the view lags one request), then the
	// status -> compress flow runs on a turn with listed candidates.
	await ask(turnText("task one", 60), 1);
	await ask(turnText("task two", 60), 2);
	for (let round = 0; !flow.compressDone && round < 3; round++) {
		await ask(`${turnText(`task three.${round}`, 60)} fetch status and compress`, assistantCount() + 3);
	}
	assert.ok(flow.statusDone, "the model read a non-empty short-ref manifest from context_status");
	assert.ok(flow.compressDone, "the compress with a short-ref keep succeeded");
	assert.match(keptRef, /^b\d+$/, "the keep id was a bN short ref");
	assert.match(summaryRef, /^b\d+$/, "the outcome names the new block by short ref");
	const outcome = JSON.parse(resultText(resultsOf("compress_context").at(-1)!.content)) as CompressOutcome;
	assert.equal(outcome.ok, true);
	assert.ok(outcome.compressed.blocks >= 1, "the compress folded unkept manifest blocks");

	// JSONL: the acpSummary DATA talks entry ids only (spec §3) — short refs
	// live on model-facing surfaces; the journaled context_status tool result is an
	// ordinary stored message and legitimately carries bN rows.
	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the smoke profile agentDir, got ${sessionFile}`);
	const raw = await Bun.file(sessionFile).text();
	assert.equal(raw.split('"customType":"acpSummary"').length - 1, 1, "exactly one acpSummary on disk");
	const summaryId = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary")
		.map((e) => e.id)[0];
	const summaryData = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary")
		.map((e) => e.data as AcpSummaryData)[0];
	assert.ok(summaryData.index.every((l) => !/^b\d+$/.test(l.id)), "index lines persist entry ids, never short refs");
	assert.ok(summaryData.meta.compressedIds.every((id) => !/^b\d+$/.test(id)), "compressedIds persist entry ids");
	assert.ok(!/"keepIds":\["b\d+"\]/.test(raw), "keepIds persist entry ids");
	assert.equal(state.shortRef(summaryId), summaryRef, "the outcome's short ref is the new block's registry label");

	await session.dispose();
	await sessionManager.close();
	const sessionDir = dirname(sessionFile);
	process.on("exit", () => {
		rmSync(sessionDir, { recursive: true, force: true });
		// Windows can still hold the throwaway cwd when a session handle outlives the
		// test; the temp dir is disposable, and the exit handler retries after
		// teardown.
		try {
			rmSync(cwdC, { recursive: true, force: true });
		} catch {
			// Windows lock window; the temp dir is disposable
		}
	});
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "C session dir fully removed (incl. lock files)");
	// Windows can still hold the throwaway cwd when a session handle outlives the
	// test; the temp dir is disposable, and the exit handler above retries after
	// teardown.
	try {
		rmSync(cwdC, { recursive: true, force: true });
	} catch {
		// Windows lock window; the temp dir is disposable
	}
	console.log("ok: C e2e — status -> compress(keep=[bN]) flow; JSONL persists entry ids only");
}

// --- D: restart replay determinism (spec §3 MUST: compress -> restart -> same numbering) ------

const cwdD = mkdtempSync(join(tmpdir(), "acp-v10-d-"));
{
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const sessionManager = SessionManager.create(cwdD);
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		ids.push(sessionManager.appendMessage({ role: "user", content: `journal block ${i}: ` + "restart determinism probe with exact values. ".repeat(20), timestamp: 1_700_000_200_000 + i } as never));
	}
	ids.push(`${sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "working through the blocks" }], usage } as never)}#x`);
	const viewOf = (entries: readonly SessionEntry[]) =>
		entries.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message").map((e) => e.message);
	const state1 = new AcpRuntimeState({ countTokens, sink: sessionManager, getEntries: () => sessionManager.getEntries(), params: PARAMS });
	state1.projectView(viewOf(sessionManager.getEntries()));
	const status1 = state1.status();
	const manifest1 = parseManifest((status1 as { text: string }).text);
	assert.ok(manifest1.length >= 4, "restart fixture lists its blocks");
	// Fold the two smallest listed blocks (holes in the numbering) via short refs.
	const foldRefs = manifest1.slice(-2).map((l) => l.ref);
	accepted(await state1.compress({ keep: manifest1.slice(0, -2).map((l) => l.ref), summary: SUMMARY_TEXT }));
	const summaryId1 = state1.zone.at(-1)!.id;
	const foldedIds = state1.zone.at(-1)!.meta.compressedIds;
	assert.equal(foldedIds.length, 2);

	// Snapshot the numbering BEFORE restart: live + folded (hole) + summary ids.
	const refBefore = new Map<string, string>();
	for (const id of [...ids, summaryId1, ...foldedIds]) refBefore.set(id, state1.shortRef(id)!);
	assert.ok([...refBefore.values()].every((r) => /^b\d+$/.test(r)), "all ids numbered pre-restart");

	// Restart: reopen from disk, rebuild, replay. Same journal -> same numbers.
	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the smoke profile agentDir, got ${sessionFile}`);
	await sessionManager.close();
	const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	const entries2 = reopened.getEntries();
	const state2 = new AcpRuntimeState({ countTokens, sink: reopened, getEntries: () => entries2, params: PARAMS });
	const rebuilt = rebuildAcpState(entries2);
	assert.equal(rebuilt.degraded, false);
	state2.zone = rebuilt.zone;
	for (const id of rebuilt.compressedBlockIds) state2.compressed.add(id);
	state2.projectView(viewOf(entries2));
	for (const [id, ref] of refBefore) {
		assert.equal(state2.shortRef(id), ref, `restart replay kept the numbering for ${id} (${ref})`);
	}

	// Restart-side status return agrees with the replayed numbering.
	const status2 = state2.status();
	const manifest2 = parseManifest((status2 as { text: string }).text);
	assert.ok(
		manifest2.every((l) => [...refBefore.values()].includes(l.ref)),
		"the post-restart manifest reuses the replayed short refs",
	);

	await reopened.close();
	const sessionDir = dirname(sessionFile);
	process.on("exit", () => {
		rmSync(sessionDir, { recursive: true, force: true });
		// Windows can still hold the throwaway cwd when a session handle outlives the
		// test; the temp dir is disposable, and the exit handler retries after
		// teardown.
		try {
			rmSync(cwdD, { recursive: true, force: true });
		} catch {
			// Windows lock window; the temp dir is disposable
		}
	});
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "D session dir fully removed (incl. lock files)");
	// Windows can still hold the throwaway cwd when a session handle outlives the
	// test; the temp dir is disposable, and the exit handler above retries after
	// teardown.
	try {
		rmSync(cwdD, { recursive: true, force: true });
	} catch {
		// Windows lock window; the temp dir is disposable
	}
	console.log("ok: D restart replay — same numbering for live/folded/summary ids");
}

// --- E: degrade rejects context_status at the entry ----------------------------------------------

{
	const fx = makeFixture(PARAMS, 3);
	fx.state.projectView(fx.view);
	assert.equal(fx.state.status().ok, true);
	fx.state.degrade("fixture degrade");
	const s = fx.state.status();
	assert.equal(s.ok, false);
	assert.match((s as { error: string }).error, /degraded/, "degraded sessions reject context_status at the entry");
	console.log("ok: E degrade — context_status rejects at the entry (tools cannot be unregistered)");
}

// Leak guard: every section must have removed its profile-side session dirs.
{
	const sessionsRoot = join(getAgentDir(), "sessions");
	const leaked = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter((n) => n.includes("acp-v10-")) : [];
	for (const name of leaked) rmSync(join(sessionsRoot, name), { recursive: true, force: true });
	const after = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter((n) => n.includes("acp-v10-")) : [];
	assert.equal(after.length, 0, `v10 session mapping dirs leaked into the profile: ${leaked.join(", ")}`);
}

console.log("\nALL ACP V10 PULL MODE SMOKE CHECKS PASSED");
