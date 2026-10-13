// ACP T7 smoke: level-3 forced compression + total-volume guard line +
// permanent degrade (spec §5.2/§5.3, acceptance 5/7). Single-process bun run.
//
// Layers:
//   A  ultimatum round attribution (acceptance 5): the delivering round is
//      judged, not the one before; a successful (≥ minCompress) compression in
//      the delivered turn frees; below-min and pure-reset successes do NOT
//      count; an unanswered ultimatum arms the force; idle never wakes it
//   B  forced execution: armed force -> next compress runs strong semantics
//      with meta.forced=true; a forced turn that ends without success degrades
//   C  guard line (acceptance 7): projected total over window − reserve arms
//      the force directly at a non-L3 tier (no ultimatum wait); a successful
//      compression in the same round frees; still over after a forced success
//      => degrade
//   D  end-to-end ultimatum -> force -> obey: the real setForcedToolChoice
//      channel drives the next request's tool_choice (named form), the model
//      compresses under force, the [forced,"none"] sequence advances
//   E  end-to-end degrade: forced turn ignored => degrade — compress rejected
//      at the entry, ephemeral stopped, projection passes the journal view
//      through verbatim (zone renders gone), compaction.enabled restored on
//      the settings child, disk JSONL untouched
//   F  end-to-end API error on the forced request => degrade (error turns emit
//      turn_end with no tool call; the retry may succeed afterwards)
//   G  restart rebuild wiring (acceptance 10 half): journal with a base
//      compaction entry degrades at assembly time (state not adopted, base
//      chain restored); journal without one adopts zone/compressed
//
// Mock-model note (D/E/F): the mock's api is "mock", for which
// buildNamedToolChoice returns nothing — setForcedToolChoice would throw. The
// push consults only model.api/compat, so the force hook borrows a
// named-capable api string for the call and restores "mock" before the request
// streams (probe-verified: the queue stores the resolved ToolChoice, and the
// mock records it in options.toolChoice). Production faces never need this.
//
// All session data lands under the OMP_PROFILE=acp-probe profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directories at the end.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-forced.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import { AcpRuntimeState, createCompressContextTool, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import type { AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData, CompressOutcome, CompressRejection } from "../host/acp-runtime.ts";
import { rebuildAcpState } from "../host/acp-persist.ts";

assert.equal(process.env.OMP_PROFILE, "acp-probe", "run with OMP_PROFILE=acp-probe (never the default profile)");
// Dynamic import exception: the coding-agent module resolves agentDir at import
// time, so the profile must be active before the module loads (T2/probe precedent).
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { cfgCompactionEnabled } = await import("@oh-my-pi/pi-coding-agent/session/context-settings");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

// Real tokenizer (spec §8): native encoding, not the byte-estimate fallback.
const glm5 = new Tokenizer({ tokenizer: "glm5" });
const countTokens = (s: string) => glm5.countTokens(s);

function accepted(r: CompressOutcome | CompressRejection): CompressOutcome {
	if (!r.ok) assert.fail(`expected success, got: ${JSON.stringify(r)}`);
	return r;
}
function rejected(r: CompressOutcome | CompressRejection): CompressRejection {
	if (r.ok) assert.fail(`expected a rejection, got: ${JSON.stringify(r)}`);
	return r;
}

/** Text of a message regardless of content shape (string or block array). */
function textOf(m: { content: unknown }): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content.map((c: unknown) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: string }).text) : "")).join("");
}

/** Text padded to at least `target` tokens (deterministic for the glm5 encoding). */
function tokenText(target: number, seed = "retired investigation record with exact values. "): string {
	let text = "";
	while (countTokens(text) < target) text += seed;
	return text;
}

/** Journal block text of roughly `target` tokens. */
function blockText(i: number, target: number): string {
	let text = `journal block ${i}: `;
	while (countTokens(text) < target) text += "detailed parser investigation notes with exact values. ";
	return text;
}

type FixtureEntry =
	| { type: "message"; id: string; message: AgentMessage }
	| { type: "custom"; id: string; customType: string; data: unknown };

interface ForcedFixture {
	state: AcpRuntimeState;
	writes: AcpSummaryData[];
	entries: FixtureEntry[];
	view: AgentMessage[];
	forceCalls: string[];
}

let fixtureSeq = 0;

/**
 * Failure-exit fixture: journal-backed view over a fake sink that journals
 * acpSummary writes (rebuild parity), with a spying force channel and a
 * degrade hook writing to an isolated settings overlay like the assembly.
 */
function makeForcedFixture(params: Partial<AcpParams>, blocks: number, contextWindow: number, blockTokens = 100): ForcedFixture {
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
		const message = {
			role: "user",
			content: blockText(i, blockTokens),
			timestamp: 1_700_000_000_000 + i,
		} as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	}
	const forceCalls: string[] = [];
	const settings = Settings.isolated({}).overlay({ "compaction.enabled": false });
	const state = new AcpRuntimeState({
		countTokens,
		sink,
		getEntries: () => entries as never as SessionEntry[],
		contextWindow,
		params,
		forceCompressTool: () => {
			forceCalls.push(`arm@${entries.length}`);
		},
		onDegrade: () => cfgCompactionEnabled.override(settings, true),
	});
	return { state, writes, entries, view, forceCalls };
}

/** A standalone zone block of roughly `summaryTokens` rendered tokens. */
function zoneBlock(summaryTokens: number, folded: string[]): AcpSummaryData {
	return {
		id: `z${++fixtureSeq}`,
		summary: tokenText(summaryTokens),
		index: folded.map((id, i) => ({ id, tokens: 100, intent: `folded block ${i}` })),
		meta: { createdAt: 0, depth: 0, method: "normal", keepIds: [], compressedIds: [...folded], supersedes: [], tokensBefore: 0, tokensAfter: 0 },
	};
}

const NO_TAIL: Partial<AcpParams> = { tailTurns: 0, tailTokens: 0 };
// Fixture tiers: 300/600/900 with ~100-token blocks; minCompress 30.
const FIXTURE_PARAMS: Partial<AcpParams> = { l1: 300, l2: 600, l3: 900, minCompress: 30, target: 1_000_000, ...NO_TAIL };

// --- A: ultimatum round attribution (acceptance 5) -----------------------------------------

{
	// The delivering round is judged: request 1 carries the ultimatum, its turn
	// ends without compression -> the force arms (exactly once).
	const fx = makeForcedFixture(FIXTURE_PARAMS, 10);
	fx.state.projectView(fx.view);
	assert.equal(fx.state.roundStatus!.tier, "L3", "active ~1000 > l3 900: the ultimatum rides request 1");
	assert.equal(fx.forceCalls.length, 0, "no force before the delivered round ends");
	fx.state.onTurnEnd();
	assert.equal(fx.forceCalls.length, 1, "unanswered ultimatum arms the level-3 force");
	assert.equal(fx.state.degraded, false);

	// Idle: nothing further happens — no timers, no queues; the armed force
	// just sits (the next request, whenever it comes, consumes it).
	fx.state.onTurnEnd(); // a stray late turn_end with no new request changes nothing
	assert.equal(fx.forceCalls.length, 1, "idle never re-arms");
	assert.equal(fx.state.degraded, false, "idle never degrades");
	console.log("ok: A1 delivering round judged; unanswered ultimatum arms the force once; idle stays put");
}

{
	// A successful (≥ minCompress) compression inside the delivered turn frees.
	const fx = makeForcedFixture(FIXTURE_PARAMS, 10);
	fx.state.projectView(fx.view);
	const out = accepted(await fx.state.compress({ keep: [], summary: tokenText(50) }));
	assert.equal(out.countedAsSuccess, true, "folding ~1000 tokens >= minCompress 30 counts");
	fx.state.onTurnEnd();
	assert.equal(fx.forceCalls.length, 0, "successful compression in the delivered turn frees the round");
	console.log("ok: A2 in-turn success (>= minCompress) frees the ultimatum");
}

{
	// Below-minCompress and pure-reset successes execute but do NOT count
	// (spec §5.2 success = folded set >= minCompress; pure reset folds 0).
	const small = makeForcedFixture({ ...FIXTURE_PARAMS, minCompress: 2_000 }, 10); // foldable total < minCompress
	small.state.projectView(small.view);
	const out = accepted(await small.state.compress({ keep: [], summary: tokenText(10) }));
	assert.equal(out.countedAsSuccess, false, "folded ~1000 < minCompress 2000");
	small.state.onTurnEnd();
	assert.equal(small.forceCalls.length, 1, "below-min success still counts as no successful compression");
	console.log("ok: A3 below-minCompress success does not free the ultimatum");
}

// --- B: forced execution + forced-turn terminal state (acceptance 5) ----------------------

{
	// Armed force -> the next compress runs strong semantics, meta.forced=true,
	// and the forced turn resolves without degrade.
	const fx = makeForcedFixture(FIXTURE_PARAMS, 10, 100_000);
	fx.state.projectView(fx.view);
	fx.state.onTurnEnd(); // arm
	assert.equal(fx.forceCalls.length, 1);
	fx.state.projectView(fx.view); // the forced request
	const out = accepted(await fx.state.compress({ keep: [], summary: tokenText(50) }));
	assert.equal(out.countedAsSuccess, true);
	fx.state.onTurnEnd(); // forced-turn resolution
	assert.equal(fx.state.degraded, false, "a successful forced turn does not degrade");
	const meta = fx.writes.at(-1)!.meta;
	assert.equal(meta.forced, true, "meta.forced marks the level-3 execution (spec §9)");
	assert.equal(meta.method, "strong", "forced compression runs strong semantics (spec §5.2)");
	console.log("ok: B1 forced compress = strong + meta.forced; success resolves without degrade");
}

{
	// Forced turn that ends without any compression -> degrade, and every §5.3
	// effect is observable: entry rejection + verbatim projection pass-through.
	const fx = makeForcedFixture(FIXTURE_PARAMS, 10, 100_000);
	fx.state.projectView(fx.view);
	fx.state.onTurnEnd(); // arm
	fx.state.projectView(fx.view); // the forced request — model never compresses
	fx.state.onTurnEnd(); // forced-turn resolution: no success
	assert.equal(fx.state.degraded, true, "forced turn without successful compression degrades");
	assert.match(fx.state.degradeReason, /forced compression turn/);
	const r = rejected(await fx.state.compress({ keep: [], summary: tokenText(10) }));
	assert.equal(r.code, "degraded", "compress_context rejects at the entry after degrade");
	const passthrough = fx.state.projectView(fx.view);
	assert.equal(passthrough.length, fx.view.length, "degraded projection passes the view through verbatim");
	assert.equal(JSON.stringify(passthrough), JSON.stringify(fx.view), "no zone render, no ephemeral, no filtering");
	assert.ok(!JSON.stringify(passthrough).includes("[acp-status]"), "ephemeral stopped");
	console.log("ok: B2 forced turn without success degrades; entry rejects; projection verbatim");
}

// --- C: total-volume guard line (acceptance 7) --------------------------------------------

// Window 20_000: reserve = max(15% = 3000, default 16384) = 16384 -> guard 3616.
// Zone render ~3200 + active 8x~100 -> projected ~4000 > 3616 at tier L2.
const GUARD_WINDOW = 20_000;

{
	const fx = makeForcedFixture(FIXTURE_PARAMS, 8, GUARD_WINDOW);
	fx.state.zone = [zoneBlock(3200, ["e0", "e1"])];
	fx.state.projectView(fx.view);
	assert.notEqual(fx.state.roundStatus!.tier, "L3", "the guard breach must fire below L3 (no ultimatum wait)");
	assert.ok(fx.state.roundStatus!.projectedTokens > 3616, `projected ${fx.state.roundStatus!.projectedTokens} over the guard line`);
	fx.state.onTurnEnd(); // no compression this round
	assert.equal(fx.forceCalls.length, 1, "guard-line breach arms the force directly (spec §5.3)");
	console.log("ok: C1 projected total over the guard line arms the force without an ultimatum round");
}

{
	const fx = makeForcedFixture(FIXTURE_PARAMS, 8, GUARD_WINDOW);
	fx.state.zone = [zoneBlock(3200, ["e0", "e1"])];
	fx.state.projectView(fx.view);
	const out = accepted(await fx.state.compress({ keep: [], summary: tokenText(50) }));
	assert.equal(out.countedAsSuccess, true);
	fx.state.onTurnEnd();
	assert.equal(fx.forceCalls.length, 0, "a successful compression in the breaching round frees (convergence continues)");
	console.log("ok: C2 successful compression in the breaching round does not force");
}

{
	// Forced success but the next projection is still over the line -> degrade.
	// A forced compress folds the WHOLE zone into a fresh summary (strong
	// semantics), so the only way to stay over is an active zone the keep list
	// refuses to shrink: 40 x ~100 kept blocks alone sit above the 3616 line.
	const fx = makeForcedFixture(FIXTURE_PARAMS, 40, GUARD_WINDOW);
	fx.state.projectView(fx.view);
	assert.ok(fx.state.roundStatus!.projectedTokens > 3616, `active ~4000 already over the guard line (${fx.state.roundStatus!.projectedTokens})`);
	fx.state.onTurnEnd(); // breach arms the force
	assert.equal(fx.forceCalls.length, 1);
	fx.state.projectView(fx.view); // the forced request
	const folded = fx.state.roundStatus!.manifestIds[0];
	const keep = fx.state.roundStatus!.manifestIds.filter((id) => id !== folded).map((id) => fx.state.shortRef(id)!);
	const out = accepted(await fx.state.compress({ keep, summary: tokenText(10) }));
	assert.equal(out.countedAsSuccess, true, "folded ~100 >= minCompress 30");
	fx.state.onTurnEnd(); // forced resolution: success, relief expected
	assert.equal(fx.state.degraded, false, "relief is judged at the next projection, not at turn end");
	fx.state.projectView(fx.view);
	assert.equal(fx.state.degraded, true, "still over the guard line after the forced compression -> degrade");
	assert.match(fx.state.degradeReason, /still over the guard line/);
	console.log("ok: C3 forced success without relief degrades at the next projection");
}

// --- e2e harness (D/E/F) -------------------------------------------------------------------

interface MockCall {
	context: { messages: Array<{ role: string; content?: unknown }> };
	options?: { toolChoice?: unknown };
}

/** Bounded wait for a journal/state condition (10ms poll, 10s ceiling). */
async function waitFor(what: string, predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 1_000 && !predicate(); i++) await Bun.sleep(10);
	assert.ok(predicate(), `timed out waiting for: ${what}`);
}

interface E2EOpts {
	params: Partial<AcpParams>;
	contextWindow: number;
	handler: (call: MockCall) => { content: ReadonlyArray<unknown> } & { throw?: never };
}

/** Mock-model session assembled exactly like the host (tool + projection + hooks). */
async function makeE2ESession(cwd: string, opts: E2EOpts) {
	const mock = createMockModel({
		contextWindow: opts.contextWindow,
		handler: (context: never, options?: { toolChoice?: unknown }) =>
			opts.handler({ context: context as unknown as MockCall["context"], options }),
	});
	const sessionManager = SessionManager.create(cwd);
	// Assembly-mirroring settings: parent -> live child with compaction off;
	// the degrade hook writes compaction.enabled back on the child (§5.3).
	const settings = Settings.isolated({}).overlay({ "compaction.enabled": false });
	assert.equal(cfgCompactionEnabled.get(settings), false, "base compaction pinned off for the ACP session");
	const forceCalls: string[] = [];
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		contextWindow: opts.contextWindow,
		params: opts.params,
		forceCompressTool: () => {
			forceCalls.push("arm");
			const patched = mock as unknown as { api: string };
			const saved = patched.api;
			patched.api = "anthropic-messages";
			try {
				acpSession.session!.setForcedToolChoice("compress_context");
			} finally {
				patched.api = saved;
			}
		},
		onDegrade: () => cfgCompactionEnabled.override(settings, true),
	});
	const acpSession: { session?: { setForcedToolChoice(toolName: string): void } } = {};
	// The force channel mirrors the assembly hook; the mock's "mock" api is
	// not named-capable (see header), so borrow one for the push only.
	const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"));
	const { session } = await createAgentSession({
		cwd,
		settings,
		model: mock,
		modelRegistry,
		agentRegistry: new AgentRegistry(),
		sessionManager,
		customTools: [createCompressContextTool(state)] as never,
		getApiKey: async () => "mock-key",
		extensions: [createAcpProjectionExtension(state)] as never,
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: true,
	});
	acpSession.session = session;
	session.subscribe((ev: { type: string }) => {
		if (ev.type === "turn_end") state.onTurnEnd();
	});
	const calls = mock.calls as unknown as MockCall[];
	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the acp-probe agentDir, got ${sessionFile}`);
	const sessionDir = dirname(sessionFile);
	return { session, sessionManager, state, settings, calls, forceCalls, sessionDir };
}

/** One ~500-token user turn (tier L3 at e2e params). */
function bulkTurn(label: string): string {
	let text = `${label}: `;
	while (countTokens(text) < 500) text += "deep investigation of the parser bug with exact failing values. ";
	return text;
}

const E2E_PARAMS: Partial<AcpParams> = { l1: 150, l2: 300, l3: 450, minCompress: 20, target: 1_000_000, ...NO_TAIL };
const E2E_WINDOW = 100_000; // guard 83616, zone line 35000: both far away — only the L3 axis drives D/E/F

function isForcedChoice(toolChoice: unknown): boolean {
	return (
		typeof toolChoice === "object" &&
		toolChoice !== null &&
		(toolChoice as { name?: unknown }).name === "compress_context"
	);
}

// --- D: e2e ultimatum -> force -> obey (acceptance 5) --------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "acp-t7-d-"));
	const compressCalls: string[] = [];
	const e2e = await makeE2ESession(cwd, {
		params: E2E_PARAMS,
		contextWindow: E2E_WINDOW,
		handler: (call) => {
			const toolChoice = call.options?.toolChoice;
			if (isForcedChoice(toolChoice)) {
				compressCalls.push("forced");
				return { content: [{ type: "toolCall", name: "compress_context", arguments: { keep: [], summary: tokenText(100) } }] };
			}
			if (toolChoice === "none") return { content: ["turn recorded."] };
			const lastUser = [...call.context.messages].reverse().find((m) => m.role === "user" && !textOf(m as { content: unknown }).startsWith("[acp-status]"));
			const text = lastUser ? textOf(lastUser as { content: unknown }) : "";
			if (text.includes("[acp-status]")) return { content: ["not compressing yet."] }; // ignore the ultimatum
			return { content: ["turn recorded."] };
		},
	});

	await e2e.session.prompt(bulkTurn("task one"));
	await waitFor("ultimatum on the wire", () => e2e.calls.length >= 1 && JSON.stringify(e2e.calls[0].context.messages).includes("Final notice"));
	assert.equal(e2e.forceCalls.length, 1, "the ignored ultimatum armed the force at turn end");

	await e2e.session.prompt("continue");
	await waitFor("forced compress round-trip", () =>
		e2e.sessionManager.getEntries().some((e) => e.type === "message" && (e as { message?: { role?: string; toolName?: string } }).message?.role === "toolResult" && (e as { message?: { toolName?: string } }).message?.toolName === "compress_context"),
	);
	assert.equal(compressCalls.length, 1, "the model called compress_context exactly once, under force");
	const forcedCall = e2e.calls.find((c) => isForcedChoice(c.options?.toolChoice));
	assert.ok(forcedCall, "the forced request carried the named tool_choice on the wire-shaped options");
	const afterForce = e2e.calls.slice(e2e.calls.indexOf(forcedCall!) + 1);
	assert.ok(
		afterForce.length > 0 && afterForce[0].options?.toolChoice === "none",
		"the [forced, \"none\"] sequence advanced: the turn after the force cannot call tools",
	);
	// Let the post-force turn ("none" choice) settle before reading the journal.
	await Bun.sleep(100);
	const metas = e2e.sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary")
		.map((e) => (e.data as AcpSummaryData).meta);
	assert.equal(metas.length, 1, "one compaction block on disk");
	assert.equal(metas[0].forced, true, "the forced execution is persisted with meta.forced");
	assert.equal(metas[0].method, "strong", "forced execution ran strong semantics");
	assert.equal(e2e.state.degraded, false, "a successful forced turn leaves ACP active");
	assert.equal(cfgCompactionEnabled.get(e2e.settings), false, "no degrade: base compaction stays pinned off");
	// dispose() records the exit diagnostic now and detaches the process-exit
	// hook — otherwise the exit marker re-creates the session file (and its
	// mapping dir under the profile) after the rmSync below.
	await e2e.session.dispose();
	await e2e.sessionManager.close();
	rmSync(e2e.sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(e2e.sessionDir), "session dir fully removed (incl. lock files)");
	rmSync(cwd, { recursive: true, force: true });
	console.log("ok: D e2e — ultimatum ignored -> named tool_choice on the next request -> forced strong compress persisted; sequence advanced");
}

// --- E: e2e degrade after an ignored force (acceptance 5 degrade half) ---------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "acp-t7-e-"));
	let compressedVoluntarily = false;
	const e2e = await makeE2ESession(cwd, {
		params: { ...E2E_PARAMS, l3: 700 }, // the voluntary round stays below L3; only rounds 3+ breach it
		contextWindow: E2E_WINDOW,
		handler: (call) => {
			const toolChoice = call.options?.toolChoice;
			if (isForcedChoice(toolChoice)) return { content: ["still not compressing."] }; // ignore the force
			const lastUser = [...call.context.messages].reverse().find((m) => m.role === "user" && !textOf(m as { content: unknown }).startsWith("[acp-status]"));
			const text = lastUser ? textOf(lastUser as { content: unknown }) : "";
			if (text.includes("compress it now") && !compressedVoluntarily) {
				compressedVoluntarily = true;
				return { content: [{ type: "toolCall", name: "compress_context", arguments: { keep: [], summary: tokenText(30) } }] };
			}
			return { content: ["noted."] };
		},
	});

	// Round 1 warms the journal: a session's first user turn is still
	// fingerprint-pseudo at its own request (the journal lags the view by one
	// request), so the compressible manifest only exists from round 2 on.
	await e2e.session.prompt(`warmup ${tokenText(130)}`);
	assert.equal(e2e.forceCalls.length, 0);

	// Round 2: bulk + voluntary compress while past L3 (strong by the tier
	// table, but NOT forced — meta.forced absent); the turn ends with success.
	await e2e.session.prompt(`${bulkTurn("round one")} compress it now`);
	await waitFor("voluntary compress lands", () =>
		e2e.sessionManager.getEntries().some((e) => e.type === "custom" && (e as { customType?: string }).customType === "acpSummary"),
	);
	assert.ok(compressedVoluntarily, "the voluntary round routed through the model");
	assert.equal(e2e.forceCalls.length, 0, "an in-turn successful compression answers the L3 round");
	const summaryEntries = () =>
		e2e.sessionManager.getEntries().filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary");
	assert.equal(summaryEntries().length, 1);
	assert.equal(summaryEntries()[0].data.meta.forced, undefined, "the voluntary compress is not marked forced");

	// Snapshot the raw journal before the degrade path runs: the §5.3 assertion
	// is that degrade never rewrites any stored message (the base chain's
	// summaries read the original full text).
	const fileBefore = await Bun.file(e2e.sessionManager.getSessionFile()!).text();

	// Round 3: past L3 again, ultimatum ignored -> force armed.
	await e2e.session.prompt(bulkTurn("round two"));
	assert.equal(e2e.forceCalls.length, 1, "ultimatum ignored -> force armed");

	// Round 4: the forced request is ignored too -> permanent degrade.
	await e2e.session.prompt("continue");

	assert.equal(e2e.state.degraded, true, "forced turn ignored -> degrade (spec §5.2 terminal state)");
	assert.match(e2e.state.degradeReason, /forced compression turn/);
	assert.equal(cfgCompactionEnabled.get(e2e.settings), true, "degrade restored compaction.enabled on the live settings child");
	const r = rejected(await e2e.state.compress({ keep: [], summary: tokenText(10) }));
	assert.equal(r.code, "degraded", "compress_context rejects at the entry (tools cannot be unregistered)");

	// Post-degrade request: projection off — verbatim view, no ephemeral.
	await e2e.session.prompt(bulkTurn("round four")); // post-degrade request: projection off
	const wire = JSON.stringify(e2e.calls.at(-1)!.context.messages);
	assert.ok(!wire.includes("[acp-status]"), "ephemeral stopped after degrade");
	assert.ok(!wire.includes("[acp-summary"), "zone renders gone after degrade (projection off)");
	assert.ok(wire.includes("round four"), "the new turn passes through verbatim");

	// Disk: the journal still carries every original message and the compaction
	// block byte-for-byte (degrade rewrites nothing; the base chain's
	// summaries read the original full text).
	const fileAfter = await Bun.file(e2e.sessionManager.getSessionFile()!).text();
	assert.ok(fileAfter.startsWith(fileBefore), "the pre-degrade journal is a byte-identical prefix of the post-degrade one");
	assert.ok(fileAfter.includes('"customType":"acpSummary"'), "the compaction block stays on disk");
	await e2e.session.dispose(); // same as D: no post-exit session-file resurrection
	await e2e.sessionManager.close();
	rmSync(e2e.sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(e2e.sessionDir), "session dir fully removed (incl. lock files)");
	rmSync(cwd, { recursive: true, force: true });
	console.log("ok: E e2e — ignored force degrades; entry rejects; ephemeral/projection off; compaction restored; journal untouched");
}

// --- F: e2e API error on the forced request -> degrade (acceptance 5) ----------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "acp-t7-f-"));
	let threwOnce = false;
	const e2e = await makeE2ESession(cwd, {
		params: E2E_PARAMS,
		contextWindow: E2E_WINDOW,
		handler: (call) => {
			const toolChoice = call.options?.toolChoice;
			if (isForcedChoice(toolChoice)) {
				if (!threwOnce) {
					threwOnce = true;
					return { content: [], throw: new Error("simulated API 500 on the forced request") } as never;
				}
				return { content: [{ type: "toolCall", name: "compress_context", arguments: { keep: [], summary: tokenText(100) } }] };
			}
			const lastUser = [...call.context.messages].reverse().find((m) => m.role === "user" && !textOf(m as { content: unknown }).startsWith("[acp-status]"));
			const text = lastUser ? textOf(lastUser as { content: unknown }) : "";
			if (text.includes("[acp-status]")) return { content: ["not compressing."] };
			return { content: ["turn recorded."] };
		},
	});

	await e2e.session.prompt(bulkTurn("task one")); // ultimatum ignored -> force armed
	assert.equal(e2e.forceCalls.length, 1);
	await e2e.session.prompt("continue"); // forced request; first attempt API-errors
	assert.equal(e2e.state.degraded, true, "an API-error forced turn degrades (turn_end fires with no tool call)");
	assert.match(e2e.state.degradeReason, /forced compression turn/);
	assert.equal(cfgCompactionEnabled.get(e2e.settings), true, "base compaction restored");
	// The degraded session keeps serving requests through the verbatim view even
	// while the base retry machinery finishes its attempt.
	await e2e.session.prompt("final turn");
	assert.ok(!JSON.stringify(e2e.calls.at(-1)!.context.messages).includes("[acp-status]"), "no ephemeral after degrade");
	await e2e.session.dispose(); // same as D: no post-exit session-file resurrection
	await e2e.sessionManager.close();
	rmSync(e2e.sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(e2e.sessionDir), "session dir fully removed (incl. lock files)");
	rmSync(cwd, { recursive: true, force: true });
	console.log("ok: F e2e — API error on the forced request degrades; degraded session keeps serving verbatim");
}

// --- G: restart rebuild wiring (acceptance 10 half, spec §9.1/§5.3) ------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "acp-t7-g-"));
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

	// Journal with ACP state but no base compaction: adopted, not degraded.
	const healthy = SessionManager.create(join(cwd, "a"));
	const u0 = healthy.appendMessage({ role: "user", content: blockText(0, 300) } as never);
	healthy.appendMessage({ role: "assistant", content: [{ type: "text", text: "working" }], usage } as never);
	healthy.appendCustomEntry("acpSummary", {
		summary: tokenText(50),
		index: [{ id: u0, tokens: 300, intent: "block 0" }],
		meta: { createdAt: 0, depth: 0, method: "normal", keepIds: [], compressedIds: [u0], supersedes: [], tokensBefore: 300, tokensAfter: 0 },
	});
	const settingsA = Settings.isolated({}).overlay({ "compaction.enabled": false });
	const stateA = new AcpRuntimeState({
		countTokens,
		sink: healthy,
		getEntries: () => healthy.getEntries(),
		contextWindow: 100_000,
		params: FIXTURE_PARAMS,
		onDegrade: () => cfgCompactionEnabled.override(settingsA, true),
	});
	// The exact assembly lines from host/session-lifecycle.ts.
	{
		const rebuilt = rebuildAcpState(healthy.getEntries());
		if (rebuilt.degraded) stateA.degrade("restart rebuild found a base compaction entry (spec §5.3/§9.1)");
		else {
			stateA.zone = rebuilt.zone;
			for (const id of rebuilt.compressedBlockIds) stateA.compressed.add(id);
		}
	}
	assert.equal(stateA.degraded, false);
	assert.equal(stateA.zone.length, 1, "zone adopted from the journal");
	assert.ok(stateA.compressed.has(u0), "compressed set adopted");
	assert.equal(cfgCompactionEnabled.get(settingsA), false, "no degrade: compaction stays pinned off");
	await healthy.close();

	// Journal with a base compaction entry: degraded at assembly, nothing
	// adopted, and the base chain restored on the settings child.
	const degraded = SessionManager.create(join(cwd, "b"));
	const d0 = degraded.appendMessage({ role: "user", content: blockText(0, 300) } as never);
	degraded.appendMessage({ role: "assistant", content: [{ type: "text", text: "working" }], usage } as never);
	degraded.appendCompaction("omp default chain took over", undefined, d0, 4096);
	const settingsB = Settings.isolated({}).overlay({ "compaction.enabled": false });
	const stateB = new AcpRuntimeState({
		countTokens,
		sink: degraded,
		getEntries: () => degraded.getEntries(),
		contextWindow: 100_000,
		params: FIXTURE_PARAMS,
		onDegrade: () => cfgCompactionEnabled.override(settingsB, true),
	});
	{
		const rebuilt = rebuildAcpState(degraded.getEntries());
		if (rebuilt.degraded) stateB.degrade("restart rebuild found a base compaction entry (spec §5.3/§9.1)");
		else {
			stateB.zone = rebuilt.zone;
			for (const id of rebuilt.compressedBlockIds) stateB.compressed.add(id);
		}
	}
	assert.equal(stateB.degraded, true, "a journal containing a base compaction entry degrades at restart");
	assert.equal(stateB.zone.length, 0, "ACP state does not advance");
	assert.equal(cfgCompactionEnabled.get(settingsB), true, "base compaction chain restored for the degraded session");
	const passthrough = stateB.projectView([{ role: "user", content: "plain", timestamp: 0 } as never as AgentMessage]);
	assert.equal(passthrough.length, 1, "degraded-from-restart sessions project verbatim");
	assert.ok(!stateB.roundStatus, "no round status after restart degrade");
	await degraded.close();
	// SessionManager.create(cwd) materializes the cwd-derived mapping dir under
	// the profile's agent/sessions root even for throwaway /tmp cwds — remove
	// the real session dirs, not just the /tmp side (the old cleanup only
	// unlinked `${cwd}/a.jsonl`, which never existed: files live in the profile).
	for (const manager of [healthy, degraded]) {
		const dir = dirname(manager.getSessionFile()!);
		rmSync(dir, { recursive: true, force: true });
		assert.ok(!existsSync(dir), "profile-side session dir fully removed");
	}
	rmSync(cwd, { recursive: true, force: true });
	console.log("ok: G rebuild wiring — compaction entry degrades at assembly (state frozen, base chain restored); healthy journal adopted");
}

// Leak guard: every section above must have removed its profile-side session
// dirs. SessionManager.create(<tmp cwd>) materializes the cwd-derived mapping
// dir under <agentDir>/sessions even for throwaway /tmp cwds, so a missed
// cleanup leaks there (the 40-dir residue this guard now prevents).
{
	const sessionsRoot = join(getAgentDir(), "sessions");
	const leaked = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter((n) => n.includes("acp-t7-")) : [];
	for (const name of leaked) rmSync(join(sessionsRoot, name), { recursive: true, force: true });
	const after = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter((n) => n.includes("acp-t7-")) : [];
	assert.equal(after.length, 0, `T7 session mapping dirs leaked into the profile: ${leaked.join(", ")}`);
}

console.log("\nALL ACP T7 FORCED COMPRESSION + GUARD LINE + DEGRADE SMOKE CHECKS PASSED");
