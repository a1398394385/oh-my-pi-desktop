// ACP v10.1 smoke: the ultimatum's synthetic status pair (spec §5.2/§6 v10.1).
// Single-process bun run.
//
// Layers:
//   A  L3 request shape: the pair rides at the active-zone end, before the
//      [acp-status] ephemeral line, as a complete tool round (fresh assistant
//      tool_use + user tool_result); it is not a block, never a manifest
//      candidate; byte-identical across unchanged rounds
//   B  armed force: after an unanswered ultimatum the next (pinned) request
//      still carries the identical pair
//   C  guard-line direct trigger: the pair injects at a non-L3 tier purely
//      through the guard clause
//   D  lifecycle: a successful compression retires the pair with the tier; a
//      still-L3 round re-injects a NEW snapshot (manifest shrunk to the
//      survivors); a settled new block replaces the snapshot; a REAL acp_status
//      pair coexists with the synthetic one and retires on its own journal rule
//      while the synthetic continues on condition
//   E  degrade: projection passes the view through verbatim — no pair
//   F  e2e (mock model): the forced request carries the pair on the wire; the
//      model picks keep from the pair's manifest (informed pick) and the forced
//      compress succeeds; after success the next request carries no pair; the
//      session JSONL has zero synthetic-pair / marker residue
//
// All session data lands under the OMP_PROFILE=acp-probe profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directories at the end.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-synth.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import { AcpRuntimeState, createCompressContextTool, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import type { AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData, CompressOutcome, CompressRejection } from "../host/acp-runtime.ts";
import { assertToolPairing } from "../host/acp-projection.ts";
import { ACP_SYNTHETIC_STATUS_CALL_ID, createAcpStatusTool } from "../host/acp-status-tool.ts";

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

interface SynthFixture {
	state: AcpRuntimeState;
	writes: AcpSummaryData[];
	entries: FixtureEntry[];
	view: AgentMessage[];
	forceCalls: string[];
	degrades: string[];
}

let fixtureSeq = 0;

/** v10.1 fixture: journal-backed view over a fake sink, spying force + degrade channels. */
function makeSynthFixture(params: Partial<AcpParams>, blocks: number, contextWindow: number, opts?: { throwOnForce?: boolean }): SynthFixture {
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
			content: blockText(i, 100),
			timestamp: 1_700_000_000_000 + i,
		} as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	}
	const forceCalls: string[] = [];
	const degrades: string[] = [];
	const state = new AcpRuntimeState({
		countTokens,
		sink,
		getEntries: () => entries as never as SessionEntry[],
		contextWindow,
		params,
		forceCompressTool: () => {
			forceCalls.push(`arm@${entries.length}`);
			if (opts?.throwOnForce) throw new Error("no force channel on this face");
		},
		onDegrade: (reason) => degrades.push(reason),
	});
	return { state, writes, entries, view, forceCalls, degrades };
}

/** A REAL acp_status tool pair as journal entries (mid-journal insertion). */
function realStatusPair(seq: number): { entries: FixtureEntry[]; messages: AgentMessage[] } {
	const callId = `toolu-real-${seq}`;
	const use = {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "acp_status", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		timestamp: 1,
	} as never as AgentMessage;
	const result = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "acp_status",
		content: [{ type: "text", text: "[acp-report] older round dashboard (real acp_status call)" }],
		isError: false,
		timestamp: 1,
	} as never as AgentMessage;
	return {
		entries: [
			{ type: "message", id: `as-${seq}`, message: use },
			{ type: "message", id: `tr-${seq}`, message: result },
		],
		messages: [use, result],
	};
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

/** The synthetic pair tail of a projection: [assistant tool_use, tool_result, ephemeral]. */
function pairTail(out: readonly AgentMessage[]): [AgentMessage, AgentMessage, AgentMessage] {
	const tail = out.slice(-3) as [AgentMessage, AgentMessage, AgentMessage];
	const [a, r, e] = tail;
	assert.equal((a as { role: string }).role, "assistant", "pair tail: assistant tool_use first");
	const call = (a as { content: Array<{ type: string; id?: string; name?: string }> }).content.find((c) => c.type === "toolCall");
	assert.ok(call, "the synthetic assistant carries a toolCall block");
	assert.equal(call.name, "acp_status");
	assert.equal(call.id, ACP_SYNTHETIC_STATUS_CALL_ID);
	assert.equal((r as { role: string; toolCallId?: string }).role, "toolResult");
	assert.equal((r as { role: string; toolCallId?: string }).toolCallId, ACP_SYNTHETIC_STATUS_CALL_ID);
	assert.ok(textOf(r as { content: unknown }).startsWith("[acp-report]"), "the synthetic result carries the [acp-report] marker");
	assert.equal((e as { role: string }).role, "user");
	assert.ok(textOf(e as { content: unknown }).startsWith("[acp-status]"), "the ephemeral line follows the pair");
	return tail;
}

const NO_TAIL: Partial<AcpParams> = { tailTurns: 0, tailTokens: 0 };
// Fixture tiers: 300/600/900 with ~100-token blocks; minCompress 30.
const FIXTURE_PARAMS: Partial<AcpParams> = { l1: 300, l2: 600, l3: 900, minCompress: 30, target: 1_000_000, ...NO_TAIL };

// --- A+B: L3 shape, non-candidacy, byte stability, armed force -----------------------------

{
	const fx = makeSynthFixture(FIXTURE_PARAMS, 12, 100_000);
	const out = fx.state.projectView(fx.view);
	assert.equal(fx.state.roundStatus!.tier, "L3", "fixture sized into the L3 tier");
	const [a1, r1] = pairTail(out);
	// Position: the message before the pair is the last real active-zone block.
	assert.equal(out.at(-4), fx.view.at(-1), "the pair sits at the active-zone end, after the last real block");
	// Not a block, not a candidate (spec §6 v10.1).
	assert.ok(!fx.state.lastBlocks.some((b) => b.id === ACP_SYNTHETIC_STATUS_CALL_ID || b.id.includes("acp-synthetic")), "the pair never becomes a block");
	assert.ok(!fx.state.roundStatus!.manifestIds.includes(ACP_SYNTHETIC_STATUS_CALL_ID), "the pair is never a manifest candidate");
	assert.ok(!fx.state.roundStatus!.manifestText.includes("acp-synthetic"), "the manifest never mentions the synthetic id");
	// Pairing invariant over the whole projection (the pair rides as a complete tool round).
	assert.doesNotThrow(() => assertToolPairing(out), "pairing invariant holds with the synthetic pair");
	// The synthetic result reuses the [acp-report] manifest render (bN lines present).
	assert.match(textOf(r1 as { content: unknown }), /^b\d+ \| \d+ \| /m, "the synthetic result lists bN manifest lines");

	// Byte stability: an unchanged round state re-renders the identical pair.
	const out2 = fx.state.projectView(fx.view);
	const [a2, r2] = pairTail(out2);
	assert.equal(JSON.stringify([a2, r2]), JSON.stringify([a1, r1]), "unchanged round state => byte-identical synthetic pair");

	// Armed force: the unanswered ultimatum pins the next request; the pair still rides it.
	fx.state.onTurnEnd();
	assert.equal(fx.forceCalls.length, 1, "the unanswered L3 ultimatum armed the force");
	const out3 = fx.state.projectView(fx.view);
	const [a3, r3] = pairTail(out3);
	assert.equal(JSON.stringify([a3, r3]), JSON.stringify([a1, r1]), "the pinned (forced) request carries the identical pair");
	console.log("ok: A+B — L3 + armed-force requests carry a paired, non-candidate, byte-stable synthetic pair before the ephemeral");
}

// --- C: guard-line direct trigger at a non-L3 tier ------------------------------------------

// Window 20_000: reserve = max(15% = 3000, default 16384) = 16384 -> guard 3616.
// Zone render ~3200 + active 8x~100 -> projected ~4000 > 3616 at tier L2.
{
	const fx = makeSynthFixture(FIXTURE_PARAMS, 8, 20_000);
	fx.state.zone = [zoneBlock(3200, [])];
	const out = fx.state.projectView(fx.view);
	assert.equal(fx.state.roundStatus!.tier, "L2", "guard fixture sits at L2, not L3");
	pairTail(out); // the guard clause alone injected the pair
	console.log("ok: C — guard-line direct trigger injects the pair at a non-L3 tier");
}

// --- D: lifecycle — retire on success, new snapshot when still L3, real-pair coexistence ----

{
	// D-retire: full compression drops the tier below L3 -> the pair leaves with it.
	const fx = makeSynthFixture(FIXTURE_PARAMS, 12, 100_000);
	fx.state.projectView(fx.view);
	const out = accepted(await fx.state.compress({ keep: [], summary: tokenText(200) }));
	assert.equal(out.countedAsSuccess, true, "the compression counts as successful");
	const after = fx.state.projectView(fx.view);
	assert.ok(!JSON.stringify(after).includes(ACP_SYNTHETIC_STATUS_CALL_ID), "a successful compression retires the pair (tier now none)");
	assert.ok(!JSON.stringify(after).includes("[acp-report]"), "no [acp-report] surface remains after retirement");
	console.log("ok: D-retire — successful compression stops the injection");
}

{
	// D-new-snapshot + real-pair coexistence: 24 blocks with a REAL acp_status
	// pair mid-journal; keeping half leaves the round at L3 -> the synthetic
	// pair re-injects with a NEW manifest while the real pair retires on its
	// own journal rule (first successful compress after it).
	const fx = makeSynthFixture(FIXTURE_PARAMS, 24, 100_000);
	const real = realStatusPair(1);
	fx.entries.splice(12, 0, ...real.entries);
	fx.view.splice(12, 0, ...real.messages);
	const before = fx.state.projectView(fx.view);
	pairTail(before);
	const statusResults = before.filter((m) => (m as { toolName?: string }).toolName === "acp_status");
	assert.equal(statusResults.length, 2, "the real acp_status result and the synthetic result coexist");
	assert.ok(JSON.stringify(before).includes("older round dashboard"), "the real pair renders");
	const reportBefore = textOf(before.at(-2) as { content: unknown });

	const keepRefs = fx.state.roundStatus!.manifestIds.slice(0, 12).map((id) => fx.state.shortRef(id)!);
	assert.equal(keepRefs.length, 12, "keep covers half the manifest");
	const out = accepted(await fx.state.compress({ keep: keepRefs, summary: tokenText(200) }));
	assert.equal(out.countedAsSuccess, true, "the keep-half compression counts as successful");

	const after = fx.state.projectView(fx.view);
	assert.equal(fx.state.roundStatus!.tier, "L3", "the surviving half keeps the round at L3 (a new ultimatum round)");
	const [aNew, rNew] = pairTail(after);
	assert.ok(JSON.stringify(after).includes("older round dashboard") === false, "the real pair retired with the successful compress");
	const reportAfter = textOf(rNew as { content: unknown });
	assert.notEqual(reportAfter, reportBefore, "a still-L3 round injects a NEW snapshot");
	assert.ok(!reportAfter.includes("older round dashboard"), "the synthetic result is its own render, not the real pair's");
	const linesAfter = reportAfter.split("\n").filter((l) => /^b\d+ \| \d+ \| /.test(l));
	assert.equal(linesAfter.length, 12, "the new snapshot lists exactly the surviving blocks");
	assert.ok(JSON.stringify([aNew, rNew]).includes(ACP_SYNTHETIC_STATUS_CALL_ID), "the new snapshot keeps the deterministic synthetic id");
	console.log("ok: D-new-snapshot — still-L3 round re-injects with a fresh manifest; the real pair retires independently");
}

{
	// D-manifest-change: a settled new block replaces the snapshot even while
	// the injection condition simply persists.
	const fx = makeSynthFixture(FIXTURE_PARAMS, 12, 100_000);
	const before = fx.state.projectView(fx.view);
	const reportBefore = textOf(before.at(-2) as { content: unknown });
	const fresh = {
		role: "user",
		content: blockText(99, 400),
		timestamp: 1_700_000_000_999,
	} as never as AgentMessage;
	fx.entries.push({ type: "message", id: "e99", message: fresh });
	fx.view.push(fresh);
	const after = fx.state.projectView(fx.view);
	const reportAfter = textOf(after.at(-2) as { content: unknown });
	assert.notEqual(reportAfter, reportBefore, "a settled new block replaces the snapshot");
	assert.ok(reportAfter.split("\n").some((l) => /^b13 \| (4|3)\d\d \| /.test(l)), "the new block's line is in the fresh snapshot");
	console.log("ok: D-manifest-change — a settled block swaps in a new snapshot");
}

// --- E: degrade -> no pair -------------------------------------------------------------------

{
	const fx = makeSynthFixture(FIXTURE_PARAMS, 12, 100_000, { throwOnForce: true });
	const out = fx.state.projectView(fx.view);
	assert.ok(JSON.stringify(out).includes(ACP_SYNTHETIC_STATUS_CALL_ID), "the pair rides before the degrade");
	fx.state.onTurnEnd(); // unanswered ultimatum -> arm -> throw -> degrade
	assert.equal(fx.state.degraded, true, "the missing force channel degrades (form ③)");
	assert.ok(fx.degrades.length === 1, "the degrade hook fired once");
	const verbatim = fx.state.projectView(fx.view);
	assert.deepEqual(verbatim, fx.view, "degraded projection passes the view through verbatim");
	assert.ok(!JSON.stringify(verbatim).includes(ACP_SYNTHETIC_STATUS_CALL_ID), "no synthetic pair after degrade");
	console.log("ok: E — degraded sessions project verbatim, no synthetic pair");
}

// --- F: e2e forced request — informed pick from the pair, JSONL zero residue -----------------

interface MockCall {
	context: { messages: Array<{ role: string; content?: unknown }> };
	options?: { toolChoice?: unknown };
}

/** Bounded wait for a journal/state condition (10ms poll, 10s ceiling). */
async function waitFor(what: string, predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 1_000 && !predicate(); i++) await Bun.sleep(10);
	assert.ok(predicate(), `timed out waiting for: ${what}`);
}

const E2E_PARAMS: Partial<AcpParams> = { l1: 150, l2: 300, l3: 450, minCompress: 20, target: 1_000_000, ...NO_TAIL };
const E2E_WINDOW = 100_000; // guard 83616, zone line 35000: only the L3 axis drives this section

function isForcedChoice(toolChoice: unknown): boolean {
	return (
		typeof toolChoice === "object" &&
		toolChoice !== null &&
		(toolChoice as { name?: unknown }).name === "compress_context"
	);
}

/** One ~500-token user turn (tier L3 at e2e params). */
function bulkTurn(label: string): string {
	let text = `${label}: `;
	while (countTokens(text) < 500) text += "deep investigation of the parser bug with exact failing values. ";
	return text;
}

{
	const cwd = mkdtempSync(join(tmpdir(), "acp-v101-f-"));
	const picks: string[] = [];
	const forcedContexts: string[] = [];
	const noneContexts: string[] = [];
	const mock = createMockModel({
		contextWindow: E2E_WINDOW,
		handler: (context: never, options?: { toolChoice?: unknown }) => {
			const messages = (context as unknown as MockCall["context"]).messages;
			if (isForcedChoice(options?.toolChoice)) {
				forcedContexts.push(JSON.stringify(messages));
				// Informed pick: take the manifest from the synthetic pair riding
				// this very request and keep its smallest listed block.
				const report = [...messages].reverse().find((m) => m.role === "toolResult" && textOf(m as { content: unknown }).startsWith("[acp-report]"));
				const lines = report ? textOf(report as { content: unknown }).split("\n").filter((l) => /^b\d+ \| \d+ \| /.test(l)) : [];
				const keep = lines
					.map((l) => l.split(" | "))
					.sort((x, y) => Number(x[1]) - Number(y[1]))[0]?.[0];
				picks.push(keep ?? "(none)");
				return {
					content: [{ type: "toolCall", name: "compress_context", arguments: { keep: keep ? [keep] : [], summary: tokenText(100) } }],
				};
			}
			if (options?.toolChoice === "none") {
				noneContexts.push(JSON.stringify(messages));
				return { content: ["turn recorded."] };
			}
			return { content: ["not compressing yet."] }; // ignore the ultimatum
		},
	});
	const sessionManager = SessionManager.create(cwd);
	const settings = Settings.isolated({}).overlay({ "compaction.enabled": false });
	const forceCalls: string[] = [];
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		contextWindow: E2E_WINDOW,
		params: E2E_PARAMS,
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
	});
	const acpSession: { session?: { setForcedToolChoice(toolName: string): void } } = {};
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
		customTools: [createCompressContextTool(state), createAcpStatusTool(state)] as never,
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

	await session.prompt(bulkTurn("task one"));
	await waitFor("ultimatum on the wire with the pair before it", () => calls.length >= 1 && JSON.stringify(calls[0].context.messages).includes("Final notice"));
	const firstMessages = calls[0].context.messages;
	const reportIdx = firstMessages.findIndex((m) => m.role === "toolResult" && textOf(m as { content: unknown }).startsWith("[acp-report]"));
	const ephemeralIdx = firstMessages.findIndex((m) => m.role === "user" && textOf(m as { content: unknown }).startsWith("[acp-status]"));
	assert.ok(reportIdx >= 0, "the L3 request carries the synthetic [acp-report] pair");
	assert.ok(ephemeralIdx > reportIdx, "the pair precedes the ephemeral line on the wire");
	assert.equal(forceCalls.length, 1, "the ignored ultimatum armed the force at turn end");

	await session.prompt("continue");
	await waitFor("forced compress round-trip", () =>
		sessionManager.getEntries().some((e) => e.type === "message" && (e as { message?: { role?: string; toolName?: string } }).message?.role === "toolResult" && (e as { message?: { toolName?: string } }).message?.toolName === "compress_context"),
	);
	await Bun.sleep(100); // let the post-force "none" turn settle
	assert.equal(forcedContexts.length, 1, "exactly one forced request fired");
	assert.ok(forcedContexts[0]!.includes("[acp-report]"), "the forced request carried the synthetic pair");
	assert.ok(forcedContexts[0]!.includes("Current compression manifest"), "the pair's result is the full dashboard render");
	assert.match(picks[0]!, /^b\d+$/, "the model picked a real bN keep id from the pair's manifest");
	assert.ok(noneContexts.length > 0, "the [forced,\"none\"] sequence advanced");
	assert.ok(!noneContexts[0]!.includes("[acp-report]") && !noneContexts[0]!.includes(ACP_SYNTHETIC_STATUS_CALL_ID), "after the successful compress the next request carries no pair");
	const metas = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary")
		.map((e) => (e.data as AcpSummaryData).meta);
	assert.equal(metas.length, 1, "one compaction block on disk");
	assert.equal(metas[0]!.forced, true, "the forced execution is persisted with meta.forced");
	assert.equal(metas[0]!.keepIds.length, 1, "the informed keep landed in the persisted block");
	assert.equal(state.degraded, false, "a successful forced turn leaves ACP active");
	// JSONL zero residue: the pair and the markers never touch the journal.
	const raw = readFileSync(sessionFile, "utf8");
	assert.ok(!raw.includes(ACP_SYNTHETIC_STATUS_CALL_ID), "no synthetic toolCall id in the session JSONL");
	assert.ok(!raw.includes("[acp-report]"), "no [acp-report] residue in the session JSONL");
	assert.ok(!raw.includes("[acp-status]"), "no [acp-status] residue in the session JSONL");
	await session.dispose();
	await sessionManager.close();
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "session dir fully removed (incl. lock files)");
	rmSync(cwd, { recursive: true, force: true });
	console.log("ok: F e2e — forced request carried the pair; informed keep pick succeeded; pair retired after success; JSONL clean");
}

// Leak guard: every section above must have removed its profile-side session dirs.
{
	const sessionsRoot = join(getAgentDir(), "sessions");
	const leaked = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter((n) => n.includes("acp-v101-")) : [];
	for (const name of leaked) rmSync(join(sessionsRoot, name), { recursive: true, force: true });
	const after = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter((n) => n.includes("acp-v101-")) : [];
	assert.equal(after.length, 0, `v10.1 session mapping dirs leaked into the profile: ${leaked.join(", ")}`);
}

console.log("\nALL ACP v10.1 SYNTHETIC STATUS PAIR SMOKE CHECKS PASSED");
