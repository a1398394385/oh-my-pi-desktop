// ACP T4 smoke: ephemeral status injection + tier decision table + real
// manifest generation (spec §5/§7/§8, acceptance 12/15/18/19). Single-process
// bun run.
//
// Layers:
//   A  acceptance 19 — the §5.2 decision table as one function: boundaries are
//      strictly greater, active == L3 lands in L2 + normal; the ephemeral text
//      carries BOTH the tier and the allowed compress method
//   B  acceptance 15 — manifest: descending by block size, 8K render budget
//      truncates the tail (smaller blocks exempt); exempt blocks re-enter the
//      next round's manifest; many-block convergence over rounds, no deadlock
//   C  acceptance 12 — blocks arriving after the manifest injection never enter
//      the current manifest and cannot be compressed this round
//   D  acceptance 18 — a prune-style shrink (same entry id/timestamp, shorter
//      content) invalidates the token memo: tier judgment uses post-prune
//      values and the pairing invariant still holds
//   E  byte stability — identical state renders a byte-identical ephemeral
//      (spec §7 cache-safety); the tier instruction segment is a constant
//   F  end-to-end mock-model session — the REAL generated manifest drives a
//      full compress round (T3 scenario without the test-supplied manifest):
//      ephemeral appears on the wire only while a tier is active, the model
//      compresses exactly the listed ids, the journal stays [acp-status]-free
//   G  tokenizer rebind (spec §8, T3 leftover) — model switch swaps the
//      counter and clears the memo
//
// All session data lands under the OMP_PROFILE=acp-probe profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directory at the end.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-ephemeral.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, setProfile } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage, UserMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import {
	AcpRuntimeState,
	createAcpProjectionExtension,
	createCompressContextTool,
} from "../host/acp-runtime.ts";
import { computeRoundPlan, type AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData, CompressOutcome, CompressRejection } from "../host/acp-runtime.ts";
import { createAcpStatusTool } from "../host/acp-status-tool.ts";
import { assertToolPairing } from "../host/acp-projection.ts";

assert.equal(process.env.OMP_PROFILE, "acp-probe", "run with OMP_PROFILE=acp-probe (never the default profile)");
// Dynamic import exception: the coding-agent module resolves agentDir at import
// time, so the profile must be active before the module loads (T2/probe precedent).
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

// Real tokenizer (spec §8): native encoding, not the byte-estimate fallback.
const glm5 = new Tokenizer({ tokenizer: "glm5" });
const fallback = new Tokenizer(undefined);
const countTokens = (s: string) => glm5.countTokens(s);

function accepted(r: CompressOutcome | CompressRejection): CompressOutcome {
	if (!r.ok) assert.fail(`expected success, got: ${JSON.stringify(r)}`);
	return r;
}
function rejected(r: CompressOutcome | CompressRejection): CompressRejection {
	if (r.ok) assert.fail(`expected a rejection, got: ${JSON.stringify(r)}`);
	return r;
}

/** First text block of a tool result content (string or block array; T3 helper). */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (typeof c === "object" && c !== null && "text" in c ? String(c.text) : "")).join("");
}

/** Text of a wire/projection user message regardless of content shape (string or blocks). */
function textOf(m: { role: string; content: unknown }): string {
	return typeof m.content === "string" ? m.content : resultText(m.content);
}

interface Fixture {
	state: AcpRuntimeState;
	writes: AcpSummaryData[];
	entries: Array<{ type: "message"; id: string; message: AgentMessage }>;
	view: AgentMessage[];
}

/** Fixture: user blocks of per-index size over a fake sink; view fingerprints match entries by construction. */
function makeFixture(params: Partial<AcpParams>, sizes: number[]): Fixture {
	const writes: AcpSummaryData[] = [];
	const sink = {
		appendCustomEntry: (_customType: string, data: unknown) => {
			const id = `s${writes.length + 1}`;
			writes.push({ ...(data as Omit<AcpSummaryData, "id">), id });
			return id;
		},
	};
	const entries: Fixture["entries"] = [];
	const view: AgentMessage[] = [];
	sizes.forEach((repeat, i) => {
		const message = {
			role: "user",
			content: `journal block ${i}: ` + "detailed parser investigation notes with exact values. ".repeat(repeat),
			timestamp: 1_700_000_000_000 + i,
		} as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	});
	const state = new AcpRuntimeState({ countTokens, sink, getEntries: () => entries as never as SessionEntry[], params });
	return { state, writes, entries, view };
}

const NO_TAIL: Partial<AcpParams> = { tailTurns: 0, tailTokens: 0 };
/** The ephemeral text of the latest projection (asserts its user-role tail position). */
function ephemeralText(fx: Fixture): string {
	const m = fx.state.lastProjected.at(-1)!;
	assert.equal(m.role, "user", "ephemeral rides a user-role message at the end");
	return textOf(m);
}

// --- A: acceptance 19 — decision table boundaries + ephemeral carries tier AND method ---

{
	const p = { l1: 1_000, l2: 2_000, l3: 3_000, ...NO_TAIL } as const;
	// Strictly-greater boundaries on both axes (§5.2 table). The zone axis is
	// absent here (T6 smoke covers it): a two-arg call has no pending-strong.
	assert.deepEqual(computeRoundPlan(1_000, p), { tier: "none", method: "normal", pendingStrong: false });
	assert.deepEqual(computeRoundPlan(1_001, p), { tier: "L1", method: "normal", pendingStrong: false });
	assert.deepEqual(computeRoundPlan(2_000, p), { tier: "L1", method: "normal", pendingStrong: false });
	assert.deepEqual(computeRoundPlan(2_001, p), { tier: "L2", method: "normal", pendingStrong: false });
	// Exactly at L3: L2 tier text + normal compression (no ultimatum, no strong).
	assert.deepEqual(computeRoundPlan(3_000, p), { tier: "L2", method: "normal", pendingStrong: false });
	assert.deepEqual(computeRoundPlan(3_001, p), { tier: "L3", method: "strong", pendingStrong: false });
	// The ephemeral reports tier and method together (acceptance 19).
	const mid = makeFixture({ ...p, target: 10_000 }, [30, 30, 30, 30, 30, 30, 30, 30]);
	mid.state.projectView(mid.view);
	assert.match(ephemeralText(mid), /\[acp-status\] tier=L[12] compress=normal /);
	assert.ok(!/^b\d+ \| \d+ \| /m.test(ephemeralText(mid)), "v10: the ephemeral carries no manifest lines");
	assert.match(ephemeralText(mid), /call the acp_status tool/, "the ephemeral points at acp_status");
	const hot = makeFixture({ ...p, target: 10_000 }, [60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
	hot.state.projectView(hot.view);
	assert.match(ephemeralText(hot), /\[acp-status\] tier=L3 compress=strong /, "past L3 the method flips to strong");
	assert.ok((hot.state.roundStatus?.activeTokens ?? 0) > 3_000);
	// Tier none injects nothing at all (spec §5.1 "none" row).
	const cold = makeFixture({ ...p, target: 10_000 }, [2, 2, 2]);
	cold.state.projectView(cold.view);
	assert.ok(!JSON.stringify(cold.state.lastProjected).includes("[acp-status]"), "no ephemeral below L1");
	assert.equal(cold.state.roundStatus?.tier, "none");
	console.log("ok: A decision table unique — strict >, =L3 is L2+normal; ephemeral shows tier+method, no manifest; none injects nothing");
}

// --- B: acceptance 15 — manifest ordering, 8K truncation, re-entry, convergence ------------

{
	// Varied sizes so the descending order and the tail truncation are visible.
	const sizes = Array.from({ length: 2_400 }, (_, i) => (i % 13) + 2);
	const fx = makeFixture({ l1: 4_000, l2: 8_000, l3: 12_000, target: 1_000_000, ...NO_TAIL }, sizes);
	fx.state.projectView(fx.view);
	const rs = fx.state.roundStatus!;
	assert.ok(rs.manifestIds.length < fx.state.activeBlocks().length, "manifest truncated under the 8K render budget");
	assert.ok(rs.exempted > 0, "tail blocks exempted");
	assert.match(rs.manifestText, /… \d+ more \(exempt this round, re-listed next round\)$/, "exemption trailer present");
	assert.match(rs.manifestText, /^b\d+ \| \d+ \| /, "manifest lines carry bN short refs (v10)");
	// Descending by block size; every dropped candidate is <= every kept one.
	const tokensById = new Map(fx.state.activeBlocks().map((b) => [b.id, b.tokens]));
	const keptTokens = rs.manifestIds.map((id) => tokensById.get(id)!);
	assert.deepEqual([...keptTokens], [...keptTokens].sort((a, b) => b - a), "manifest listed largest first");
	const droppedTokens = fx.state.activeBlocks().filter((b) => !rs.manifestIds.includes(b.id)).map((b) => b.tokens);
	assert.ok(Math.min(...keptTokens) >= Math.max(...droppedTokens), "truncation drops the smallest candidates");
	// Protected-tail and pseudo-id blocks never enter the manifest. The
	// reminder rides mid-view (as base reminders do on the first turn) so the
	// last journaled user block e3 is what the tail walk protects.
	const guarded = makeFixture({ l1: 1_000, l2: 2_000, l3: 3_000, target: 10_000, tailTurns: 1, tailTokens: 0 }, [10, 10, 10, 10]);
	guarded.view.splice(3, 0, { role: "user", content: "view-only reminder never journaled", timestamp: 9 } as never as AgentMessage);
	guarded.state.projectView(guarded.view);
	const gIds = guarded.state.roundStatus!.manifestIds;
	assert.ok(!gIds.includes("e3"), "protected tail (last user turn) excluded");
	assert.ok(gIds.every((id) => !id.startsWith("view:")), "pseudo-id view blocks excluded");

	// Multi-round convergence: compress each round's full manifest until the
	// tier drops; exempted blocks re-enter once the big ones leave (§7).
	const convSizes = Array.from({ length: 1_600 }, (_, i) => (i % 9) + 2);
	const conv = makeFixture({ l1: 4_000, l2: 8_000, l3: 12_000, target: 1_000_000, ...NO_TAIL }, convSizes);
	const firstExempt = new Set<string>();
	let rounds = 0;
	let reentered = false;
	for (;;) {
		conv.state.projectView(conv.view); // next round: fresh manifest from the survivors
		const st = conv.state.roundStatus!;
		if (rounds === 0) {
			for (const b of conv.state.activeBlocks()) if (!st.manifestIds.includes(b.id)) firstExempt.add(b.id);
		} else if (st.manifestIds.some((id) => firstExempt.has(id))) reentered = true;
		if (st.tier === "none") break;
		assert.ok(st.manifestIds.length > 0, "an active tier always comes with a non-empty manifest");
		accepted(await conv.state.compress({ keep: [], summary: "Retired the listed blocks for this round." }));
		rounds++;
		assert.ok(rounds <= 40, "convergence must terminate (no deadlock)");
	}
	assert.ok(rounds >= 3, `expected several convergence rounds, got ${rounds}`);
	assert.ok(reentered, "a first-round-exempted block re-entered a later manifest");
	assert.equal(conv.state.roundStatus!.tier, "none");
	assert.ok(!JSON.stringify(conv.state.lastProjected).includes("[acp-status]"), "ephemeral gone after convergence");
	console.log(`ok: B manifest descending + 8K tail truncation; convergence in ${rounds} rounds; exempt blocks re-enter`);
}

// --- C: acceptance 12 — post-injection arrivals stay out of the current manifest ----------

{
	const fx = makeFixture({ l1: 1_000, l2: 2_000, l3: 3_000, target: 10_000, ...NO_TAIL }, [20, 20, 20, 20]);
	fx.state.projectView(fx.view);
	const manifestIds = fx.state.roundStatus!.manifestIds;
	// A block that settles after the injection (new journal entry mid-round).
	const late = {
		role: "user",
		content: "latecomer block settled after the manifest injection: " + "fresh details. ".repeat(30),
		timestamp: 1_700_000_100_000,
	} as never as AgentMessage;
	fx.entries.push({ type: "message", id: "e-late", message: late });
	// Not in the current manifest → hallucination-class for keep (§6.2), and it
	// can never be folded because the compressed set derives from the manifest.
	assert.ok(!manifestIds.includes("e-late"));
	const r = rejected(await fx.state.compress({ keep: ["e-late"], summary: "x" }));
	assert.equal(r.code, "hallucinated-keep", "latecomer is not a legal keep id this round");
	// Next round's manifest naturally includes it (settled before the request).
	fx.view.push(late);
	fx.state.projectView(fx.view);
	assert.ok(fx.state.roundStatus!.manifestIds.includes("e-late"), "latecomer enters the NEXT round's manifest");
	console.log("ok: C post-injection block outside the current manifest, rejected in keep, listed next round");
}

// --- D: acceptance 18 — prune shrink invalidates the memo; pairing intact -----------------

{
	const fx = makeFixture({ l1: 500, l2: 1_000, l3: 2_000, target: 10_000, ...NO_TAIL }, [10, 10, 10]);
	// A tool pair so the pairing invariant is exercised alongside the shrink.
	const pairAssistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { p: "notes.txt" } }],
		timestamp: 1_700_000_000_500,
	} as never as AgentMessage;
	const pairResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content:
			"stale full file content that a later read of the same file supersedes. " +
			"padding to push the head past the 200-char fingerprint window. ".repeat(200),
		timestamp: 1_700_000_000_600,
	} as never as AgentMessage;
	fx.entries.push({ type: "message", id: "e-pa", message: pairAssistant }, { type: "message", id: "e-pr", message: pairResult });
	fx.view.push(pairAssistant, pairResult);
	fx.state.projectView(fx.view);
	const tokensBefore = fx.state.activeBlocks().find((b) => b.id === "e-pr")!.tokens;
	const before = fx.state.roundStatus!;
	assert.ok(before.tier !== "none", "fixture starts above L1");

	// Prune-style shrink: same entry id + timestamp, content shortened from the
	// tail — the fingerprint (head-only) stays identical, only the length moves.
	const shrunk = structuredClone(pairResult) as typeof pairResult & { content: string };
	shrunk.content = shrunk.content.slice(0, 260);
	fx.entries[fx.entries.length - 1] = { type: "message", id: "e-pr", message: shrunk };
	fx.view[fx.view.length - 1] = shrunk;
	fx.state.projectView(fx.view);
	const after = fx.state.roundStatus!;
	const tokensAfter = fx.state.activeBlocks().find((b) => b.id === "e-pr")!.tokens;
	assert.ok(tokensAfter < tokensBefore, `memo served a fresh count after the shrink (${tokensAfter} < ${tokensBefore})`);
	assert.ok(after.activeTokens < before.activeTokens, "tier judgment uses post-prune values");
	assert.notEqual(after.tier, before.tier, "the shrink crossed a tier boundary");
	assert.doesNotThrow(() => assertToolPairing(fx.state.lastProjected), "prune shrink keeps the pairing invariant");
	console.log(`ok: D prune shrink recounted (memo invalidated by length); tier ${before.tier} -> ${after.tier}; pairing holds`);
}

// --- E: byte stability (spec §7) -----------------------------------------------------------

{
	const fx = makeFixture({ l1: 1_000, l2: 2_000, l3: 3_000, target: 10_000, ...NO_TAIL }, [10, 10, 10, 10]);
	fx.state.projectView(fx.view);
	const first = JSON.stringify(fx.state.lastProjected);
	fx.state.projectView([...fx.view]); // fresh array/deep-copy equivalents, same state
	assert.equal(JSON.stringify(fx.state.lastProjected), first, "unchanged round state renders byte-identical");
	// A second runtime over the same journal (fresh memo) agrees byte-for-byte.
	const fx2 = makeFixture({ l1: 1_000, l2: 2_000, l3: 3_000, target: 10_000, ...NO_TAIL }, [10, 10, 10, 10]);
	fx2.state.projectView(fx2.view);
	assert.equal(JSON.stringify(fx2.state.lastProjected), first, "deterministic across instances");
	// The tier instruction segment is a per-tier constant (no round-varying data).
	const instructionLine = ephemeralText(fx).split("\n")[1];
	fx.state.projectView(fx.view);
	assert.equal(ephemeralText(fx).split("\n")[1], instructionLine);
	console.log("ok: E ephemeral byte-stable for unchanged state, across instances; instruction line constant");
}

// --- F: end-to-end — real manifest drives a full compress round (T3 scenario, no supply) --

const cwdE2E = mkdtempSync(join(tmpdir(), "acp-t4-e2e-"));
{
	const turnText = (label: string, n: number) => `${label}: ` + "detailed journal text about the parser bug and the failing test. ".repeat(n);
	// Real manifest consumption (v10 pull mode): the model first calls
	// acp_status, parses the bN lines out of the tool RESULT, then compresses;
	// the handler records the count for the post-turn assert.
	let parsedManifestCount = 0;
	let parsedIds: string[] = [];
	let compressedOnce = false;
	// Content-directed scripting: route on the last NON-ephemeral user message
	// (the [acp-status] injection is a user-role message too and sits last).
	const mock = createMockModel({
		handler: (context: { messages: Array<{ role: string; content: unknown; toolName?: string }> }) => {
			const users = [...context.messages].reverse().filter((m) => m.role === "user");
			const routed = users.find((m) => !textOf(m).includes("[acp-status]")) ?? users[0];
			const text = textOf(routed ?? { role: "user", content: "" });
			if (text.includes("compress it now") && !compressedOnce) {
				const statusResult = [...context.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "acp_status");
				if (!statusResult) return { content: [{ type: "toolCall", name: "acp_status", arguments: {} }] as const };
				const statusText = resultText(statusResult.content);
				assert.ok(statusText.startsWith("[acp-report]"), "the acp_status result carries the dashboard");
				assert.match(statusText, /tier=L1 compress=normal/, "the tool result reports tier + method");
				const ids = statusText
					.split("\n")
					.filter((l) => /^b\d+ \| \d+ \| /.test(l))
					.map((l) => l.split(" |")[0]);
				assert.ok(ids.length > 0, "manifest lines parsed from the acp_status result");
				parsedManifestCount = ids.length;
				parsedIds = ids;
				compressedOnce = true;
				return {
					content: [
						{ type: "toolCall", name: "compress_context", arguments: { keep: [], summary: "Condensed record of the early investigation turns." } },
					] as const,
				};
			}
			if (text.includes("task two")) return { content: ["Turn two recorded."] as const };
			return { content: ["Turn one recorded."] as const };
		},
	});
	const sessionManager = SessionManager.create(cwdE2E);
	const settings = Settings.isolated({ "compaction.enabled": false });
	// Tiers tuned so: reminder-only first call and the single big turn stay
	// under L1; two big turns cross it; folding turn one drops back below.
	const e2eParams: Partial<AcpParams> = { l1: 3_000, l2: 6_000, l3: 9_000, target: 100_000, tailTurns: 2, tailTokens: 0 };
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		params: e2eParams,
	});
	const authStorage = await AuthStorage.create(join(cwdE2E, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const modelRegistry = new ModelRegistry(authStorage, join(cwdE2E, "models.yml"));
	const { session } = await createAgentSession({
		cwd: cwdE2E,
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

	const assistantCount = () =>
		sessionManager.getEntries().filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message" && e.message.role === "assistant").length;
	const ask = async (text: string, expectAssistants: number) => {
		await session.prompt(text);
		for (let i = 0; i < 1_000 && assistantCount() < expectAssistants; i++) await Bun.sleep(10);
		assert.ok(assistantCount() >= expectAssistants, `turn for "${text.slice(0, 24)}" did not complete`);
	};
	const wireHasStatus = (c: { context: { messages: Array<{ role: string; content: unknown }> } }) =>
		c.context.messages.some((m) => m.role === "user" && textOf(m).includes("[acp-status]"));

	await ask(turnText("task one", 220), 1); // ~2K tokens: still tier none
	assert.ok(!wireHasStatus(mock.calls.at(-1)!), "no ephemeral while the active zone is under L1");
	await ask(turnText("task two", 220), 2); // past L1: ephemeral appears
	assert.ok(wireHasStatus(mock.calls.at(-1)!), "ephemeral on the wire once a tier is active");
	const statusMsg = mock.calls.at(-1)!.context.messages.at(-1)!;
	assert.ok(textOf(statusMsg as { role: string; content: unknown }).startsWith("[acp-status]"), "ephemeral is the LAST request message");
	assert.match(textOf(statusMsg as { role: string; content: unknown }), /tier=L1 compress=normal/);

	await ask("The context is large; compress it now.", 3);
	assert.ok(compressedOnce, "the model consumed the real generated manifest");
	const compressResults = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
		.map((e) => e.message as AgentMessage)
		.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === "compress_context");
	assert.equal(compressResults.length, 1);
	const outcome = JSON.parse(resultText(compressResults[0].content)) as CompressOutcome;
	assert.equal(outcome.ok, true);
	assert.equal(outcome.compressed.blocks, parsedManifestCount, "the model compressed exactly the ids the acp_status manifest listed");
	assert.ok(parsedIds.every((id) => /^b\d+$/.test(id)), "the consumed manifest spoke bN short refs end to end");
	assert.ok(compressResults[0].content !== undefined && JSON.stringify(compressResults[0].content).length > 0, "compress result present");

	await ask("status check after compression", 4);
	const last = mock.calls.at(-1)!;
	assert.ok(JSON.stringify(last.context.messages[0]).includes("[acp-summary id="), "zone renders first after compression");
	// v10 pair retirement (spec §6): the acp_status tool_use/tool_result pair
	// left the projection after the successful compress — even though the
	// compress turn sits well inside the protected tail (tailTurns 2).
	const wire = JSON.stringify(last.context.messages);
	assert.ok(!wire.includes('"name":"acp_status"'), "the acp_status tool_use left the request");
	assert.ok(!wire.includes("acp_status result"), "no acp_status residue");
	const journalHasStatusPair = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
		.map((e) => e.message as AgentMessage)
		.some((m) => m.role === "toolResult" && m.toolName === "acp_status");
	assert.ok(journalHasStatusPair, "storage keeps the pair (projection-only retirement)");
	// Block text legitimately survives inside the zone's index intent lines,
	// and the base concatenates its reminder into the first user message
	// (zone render included) — so zone membership is a substring test (T3
	// precedent), not a startsWith one.
	const nonZoneUsers = last.context.messages.filter((m) => m.role === "user" && !JSON.stringify(m).includes("[acp-summary id="));
	assert.ok(!nonZoneUsers.some((m) => textOf(m as { role: string; content: unknown }).includes("task one:")), "folded turn-one blocks left the request");
	assert.ok(nonZoneUsers.some((m) => textOf(m as { role: string; content: unknown }).includes("status check")), "the post-compress turn stays");
	assert.ok(!wireHasStatus(last), "tier back under L1: ephemeral gone");

	// History stays clean: the ephemeral is a projection-time injection only.
	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the acp-probe agentDir, got ${sessionFile}`);
	const raw = await Bun.file(sessionFile).text();
	assert.ok(!raw.includes("[acp-status]"), "no [acp-status] residue in the session JSONL");
	assert.equal(raw.split('"customType":"acpSummary"').length - 1, 1, "exactly one acpSummary entry on disk");

	await sessionManager.close();
	const sessionDir = dirname(sessionFile);
	// The SDK journals a session_exit line at process exit (after this cleanup
	// runs), recreating the session dir — remove again from an exit handler.
	process.on("exit", () => {
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwdE2E, { recursive: true, force: true });
	});
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "session dir fully removed (incl. lock files)");
	rmSync(cwdE2E, { recursive: true, force: true });
	console.log("ok: F e2e — real manifest drove the compress round; wire/journal behavior correct; profile cleaned");
}

// --- G: tokenizer rebind (spec §8, T3 leftover) --------------------------------------------

{
	const probe = "context compression probe. ".repeat(400);
	// makeFixture sizes are repeat counts; the exact probe text is grafted on after.
	const fx = makeFixture({ l1: 10, l2: 20, l3: 30, target: 10_000, ...NO_TAIL }, [1]);
	const first = fx.entries[0].message as UserMessage; // fixture-built user message, string content
	first.content = probe;
	fx.view[0] = structuredClone(first);
	fx.state.projectView(fx.view);
	const glm5Count = fx.state.lastBlocks[0].tokens;
	assert.equal(glm5Count, glm5.countTokens(probe), "bound counter matches the model tokenizer");
	fx.state.rebindModel(undefined); // unknown encoding: byte-estimate fallback
	assert.equal(fx.state.lastBlocks[0].tokens, glm5Count, "the stale snapshot stays until the next request");
	fx.state.projectView(fx.view);
	assert.equal(fx.state.lastBlocks[0].tokens, fallback.countTokens(probe), "rebind swapped the encoding and cleared the memo");
	assert.notEqual(fx.state.lastBlocks[0].tokens, glm5Count);
	fx.state.rebindModel({ tokenizer: "glm5" });
	fx.state.projectView(fx.view);
	assert.equal(fx.state.lastBlocks[0].tokens, glm5Count, "re-binding back recomputes (memo really was cleared)");
	console.log("ok: G tokenizer rebind — encoding swap + memo invalidation round-trip");
}

console.log("\nALL ACP T4 EPHEMERAL SMOKE CHECKS PASSED");
