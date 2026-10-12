// ACP T3 smoke: compress_context tool + level-1 normal compression + assembly
// (spec §5/§6, acceptance 3/4/9/13/14/16). Single-process bun run.
//
// Layers:
//   A  §6 validation sequence — each rejection leaves zero side effects and
//      does not consume the manifest (direct state.compress calls, fake sink)
//   B  acceptance 13 — same-batch double compress: host mutex serializes;
//      success consumes the manifest (second rejected even with keep=[]);
//      a failed validation leaves the manifest retryable
//   C  acceptance 16 — compressed set under minCompress: L2 tier passes with a
//      warning, L3 tier passes but does not count as a successful compression
//   D  acceptance 9 (projection half) — the rendered compaction-zone prefix is
//      byte-identical across compressions (T1 projection output compared)
//   E  end-to-end mock-model session — real createAgentSession assembly
//      (compress_context via customTools, projection behind the context event,
//      base compaction pinned off per session), acpSummary on disk through
//      appendCustomEntry, projection live on the next request, tool_result
//      stats, rebuild parity (T2), and the §5.3 degrade write-back demo.
//
// All session data lands under the OMP_PROFILE=acp-probe profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directory at the end.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-tool.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, setProfile } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import {
	AcpRuntimeState,
	computeSummaryBudget,
	computeTier,
	createAcpProjectionExtension,
	createAcpRuntime,
	createCompressContextTool,
} from "../host/acp-runtime.ts";
import type { AcpParams, AcpSummaryData, CompressOutcome, CompressRejection } from "../host/acp-runtime.ts";
import { splitBlocks } from "../host/acp-projection.ts";
import { rebuildAcpState } from "../host/acp-persist.ts";

assert.equal(process.env.OMP_PROFILE, "acp-probe", "run with OMP_PROFILE=acp-probe (never the default profile)");
// Static imports cannot work for the coding-agent module: it resolves agentDir
// at import time, so the profile must be active first (T2/probe precedent).
setProfile("acp-probe");
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
const { cfgCompactionEnabled } = await import("@oh-my-pi/pi-coding-agent/session/context-settings");
registerMockApi();

// Real tokenizer (spec §8): native encoding, not the byte-estimate fallback.
const tokenizer = new Tokenizer({ tokenizer: "glm5" });
const countTokens = (s: string) => tokenizer.countTokens(s);

// Narrowing helpers: assert the discriminant, then keep the typed payload.
function rejected(r: CompressOutcome | CompressRejection): CompressRejection {
	if (r.ok) assert.fail(`expected a rejection, got: ${JSON.stringify(r)}`);
	return r;
}
function accepted(r: CompressOutcome | CompressRejection): CompressOutcome {
	if (!r.ok) assert.fail(`expected success, got: ${JSON.stringify(r)}`);
	return r;
}

/** First text block of a tool result content (string or block array). */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (typeof c === "object" && c !== null && "text" in c ? String(c.text) : "")).join("");
}

interface Fixture {
	state: AcpRuntimeState;
	writes: AcpSummaryData[];
	entries: Array<{ type: "message"; id: string; message: AgentMessage }>;
	view: AgentMessage[];
	ids: string[];
	tokensById: Map<string, number>;
}

/** Fixture: n user blocks of controlled size over a fake sink; view fingerprints match entries by construction. */
function makeFixture(params: Partial<AcpParams>, n: number, repeat: number): Fixture {
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
	for (let i = 0; i < n; i++) {
		const message = {
			role: "user",
			content: `journal block ${i}: ` + "detailed parser investigation notes with exact values. ".repeat(repeat),
			timestamp: 1_700_000_000_000 + i,
		} as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	}
	const state = new AcpRuntimeState({ countTokens, sink, getEntries: () => entries as never as SessionEntry[], params });
	state.projectView(view);
	const tokensById = new Map(state.lastBlocks.map((b) => [b.id, b.tokens]));
	return { state, writes, entries, view, ids: entries.map((e) => e.id), tokensById };
}

function assertPristine(fx: Fixture, writesBefore: number) {
	assert.equal(fx.writes.length, writesBefore, "rejection must not journal a compaction block");
	assert.equal(fx.state.manifest?.consumed, false, "rejection must not consume the manifest");
	assert.equal(fx.state.zone.length, writesBefore, "rejection must not grow the zone");
}

// Tuned params: l-tiers small so fixtures land in the wanted tiers; the §11
// values themselves are the ACP_DEFAULT_PARAMS defaults covered by tier math.
const PARAMS_A: Partial<AcpParams> = { l1: 1_000, l2: 2_000, l3: 3_000, target: 10_000, tailTurns: 1, tailTokens: 0 };
const SUMMARY = "Condensed record of the retired blocks: parser bug traced, values pinned.";
const activeTokens = (fx: Fixture) => fx.state.activeBlocks().reduce((n, b) => n + b.tokens, 0);

// --- A: §6 validation sequence -----------------------------------------------------

const fx = makeFixture(PARAMS_A, 8, 8);
fx.state.setManifest(fx.ids.slice(0, 7)); // e7 = protected tail (tailTurns 1)

// §6.2 — hallucinated keep id rejects the whole call with the full valid candidate set (acceptance 3)
{
	const r = rejected(await fx.state.compress({ keep: [fx.ids[0], "ghost-123"], summary: SUMMARY }));
	assert.equal(r.code, "hallucinated-keep");
	assert.deepEqual(r.validCandidates, fx.ids.slice(0, 7));
	assert.match(r.error, /ghost-123/);
	assertPristine(fx, 0);
	console.log("ok: A2 ghost keep id rejected with the full valid candidate set, zero side effects");
}

// §6.2 — protected-tail ids are hallucination-class too
{
	const r = rejected(await fx.state.compress({ keep: [fx.ids[7]], summary: SUMMARY }));
	assert.equal(r.code, "hallucinated-keep");
	assert.match(r.error, /protected tail/);
	assertPristine(fx, 0);
	console.log("ok: A2 protected-tail keep id rejected");
}

// §6.3 — keep + protected > target rejects with the exact shortfall (acceptance 4)
{
	const small = makeFixture({ ...PARAMS_A, target: 100 }, 8, 8);
	small.state.setManifest(small.ids.slice(0, 7));
	const keepTokens = small.tokensById.get("e0")!;
	const protTokens = small.tokensById.get("e7")!;
	const r = rejected(await small.state.compress({ keep: ["e0"], summary: SUMMARY }));
	assert.equal(r.code, "over-target");
	const diff = Number(r.error.match(/reduce keep by (\d+) more tokens/)![1]);
	assert.equal(diff, keepTokens + protTokens - 100, "reported shortfall = (keep + protected) - target");
	assertPristine(small, 0);
	console.log(`ok: A3 over-target rejected, shortfall ${diff} reported`);
}

// §6.4 — empty summary
{
	const r = rejected(await fx.state.compress({ keep: [fx.ids[0]], summary: "   " }));
	assert.equal(r.code, "empty-summary");
	assertPristine(fx, 0);
	console.log("ok: A4 empty summary rejected");
}

// §6.5 — summary over budget (acceptance 14, normal basis); the formula's
// merged-old-summaries basis is exercised directly below (live only in T6)
{
	const compressedTokens = fx.ids.slice(1, 7).reduce((n, id) => n + fx.tokensById.get(id)!, 0);
	const expectedBudget = computeSummaryBudget(compressedTokens, 0, fx.state.params);
	const r = rejected(await fx.state.compress({ keep: [fx.ids[0]], summary: "word ".repeat(4_000) }));
	assert.equal(r.code, "summary-over-budget");
	assert.match(r.error, new RegExp(`budget ${expectedBudget}`));
	assertPristine(fx, 0);
	assert.equal(computeSummaryBudget(3_000, 0), 1_000, "normal basis: compressed/3");
	assert.equal(computeSummaryBudget(3_000, 30_000), 8_000, "merged old summaries lift the basis, capped at 8K");
	console.log("ok: A5 over-budget summary rejected; budget formula covers the merged-summaries basis");
}

// §6.6-equivalent — keep covering the whole manifest: with an all-normal basis
// the budget is 0, so §6.5 fires first and names the empty compressed set (the
// literal §6.6 branch is only reachable in strong/pure-reset mode, T6)
{
	const r = rejected(await fx.state.compress({ keep: fx.ids.slice(0, 7), summary: SUMMARY }));
	assert.match(r.error, /nothing would be compressed/);
	assertPristine(fx, 0);
	console.log("ok: A6 keep-all-manifest rejected (spec-order note: zero basis fires at §6.5)");
}

{
	const activeBefore = activeTokens(fx);
	const compressedTokens = fx.ids.slice(1, 7).reduce((n, id) => n + fx.tokensById.get(id)!, 0);
	const out = accepted(await fx.state.compress({ keep: [fx.ids[0]], summary: SUMMARY }));
	assert.equal(out.blockId, "s1");
	assert.equal(out.compressed.blocks, 6);
	assert.equal(out.compressed.tokens, compressedTokens);
	assert.equal(out.kept.blocks, 1);
	assert.equal(out.activeTokensAfter, activeBefore - compressedTokens, "active zone shrank by exactly the folded tokens");
	assert.equal(out.tier, computeTier(out.activeTokensAfter, fx.state.params));
	assert.equal(out.countedAsSuccess, false, "under minCompress 20K");
	assert.equal(out.warning, undefined, "no L2 warning outside L2 tier");
	assert.equal(fx.state.manifest?.consumed, true, "success consumes the manifest");
	assert.equal(fx.writes.length, 1);
	assert.deepEqual(fx.writes[0].meta.compressedIds, fx.ids.slice(1, 7));
	assert.equal(fx.writes[0].meta.method, "normal");
	assert.equal(fx.writes[0].meta.supersedes.length, 0, "level-1 never supersedes");
	assert.equal(fx.state.compressed.size, 6);
	console.log("ok: A happy path — normal compression executed, manifest consumed");
}

// §6.1 — consumed manifest rejects anything further (even keep=[])
{
	const r = rejected(await fx.state.compress({ keep: [], summary: SUMMARY }));
	assert.equal(r.code, "manifest-consumed");
	assert.equal(fx.writes.length, 1);
	console.log("ok: A1 consumed manifest rejected (keep=[] included)");
}

// §6.2 — a block compressed by the previous round is hallucination-class
{
	fx.state.setManifest(fx.ids.slice(0, 7));
	const r = rejected(await fx.state.compress({ keep: [fx.ids[1]], summary: SUMMARY }));
	assert.equal(r.code, "hallucinated-keep");
	assert.match(r.error, /already compressed/);
	console.log("ok: A2 already-compressed keep id rejected");
}

// --- B: acceptance 13 — same-batch double compress under the host mutex ---------------

const fxB = makeFixture(PARAMS_A, 8, 8);
fxB.state.setManifest(fxB.ids.slice(0, 7));
{
	const [r1, r2] = await Promise.all([
		fxB.state.compress({ keep: [fxB.ids[1]], summary: SUMMARY }),
		fxB.state.compress({ keep: [], summary: SUMMARY }),
	]);
	accepted(r1);
	assert.equal(rejected(r2).code, "manifest-consumed", "second revalidates inside the lock and loses");
	assert.equal(fxB.writes.length, 1);
	console.log("ok: B mutex — concurrent pair serialized; second rejected with consumed manifest (keep=[])");
}
{
	fxB.state.setManifest(fxB.ids.filter((id) => !fxB.state.compressed.has(id) && id !== "e7"));
	const [bad, good] = await Promise.all([
		fxB.state.compress({ keep: ["ghost-9"], summary: SUMMARY }),
		fxB.state.compress({ keep: [], summary: SUMMARY }),
	]);
	assert.equal(rejected(bad).code, "hallucinated-keep");
	accepted(good);
	assert.equal(fxB.writes.length, 2, "failed validation left the manifest consumable — corrected retry succeeds");
	console.log("ok: B retry — validation failure does not consume the manifest");
}

// --- C: acceptance 16 — minCompress tiers (validation outcome unaffected) -------------

{
	const l2fx = makeFixture({ l1: 200, l2: 400, l3: 1_000, target: 10_000, tailTurns: 1, tailTokens: 0 }, 8, 8);
	l2fx.state.setManifest(l2fx.ids.slice(0, 7));
	assert.equal(computeTier(activeTokens(l2fx), l2fx.state.params), "L2", "fixture sized into the L2 tier");
	const out = accepted(await l2fx.state.compress({ keep: [l2fx.ids[0]], summary: SUMMARY }));
	assert.equal(out.countedAsSuccess, false);
	assert.match(out.warning!, /under minCompress/, "L2 tier passes with a warning");
	console.log("ok: C L2 tier — under minCompress allowed with warning");
}
{
	const l3fx = makeFixture({ l1: 200, l2: 400, l3: 600, target: 10_000, tailTurns: 1, tailTokens: 0 }, 8, 12);
	l3fx.state.setManifest(l3fx.ids.slice(0, 7));
	assert.equal(computeTier(activeTokens(l3fx), l3fx.state.params), "L3", "fixture sized into the L3 tier");
	const out = accepted(await l3fx.state.compress({ keep: [l3fx.ids[0]], summary: SUMMARY }));
	assert.equal(out.countedAsSuccess, false, "L3 tier does not count as a successful compression");
	assert.equal(out.warning, undefined, "the L2-only warning stays silent at L3");
	console.log("ok: C L3 tier — allowed but not counted as success");
}

// --- D: acceptance 9 (projection half) — byte-stable zone prefix ------------------------

{
	// fxB zone holds s1 (round 1). Add two fresh blocks, compress one more
	// round, then compare the rendered zone prefix byte for byte.
	for (let i = 8; i < 10; i++) {
		const message = {
			role: "user",
			content: `journal block ${i}: fresh follow-up work after the first compression round. ` + "more detailed notes with exact values. ".repeat(8),
			timestamp: 1_700_000_000_100 + i,
		} as never as AgentMessage;
		fxB.entries.push({ type: "message", id: `e${i}`, message });
		fxB.view.push(message);
	}
	const p1 = fxB.state.projectView(fxB.view);
	assert.match(JSON.stringify(p1[0]), /\[acp-summary id=s1 /, "zone renders first");
	const prefixBefore = JSON.stringify(p1[0]);

	// Round 2: e9 is the protected tail (tailTurns 1); the manifest is e8
	// (fresh). e1 — kept in round 1 — was folded by the B retry: keep grants no
	// privilege (spec §6 "keep grants no exemption"), already demonstrated there.
	fxB.state.setManifest(["e8"]);
	accepted(await fxB.state.compress({ keep: [], summary: "Retired the fresh block." }));

	const p2 = fxB.state.projectView(fxB.view);
	assert.equal(JSON.stringify(p2[0]), prefixBefore, "unsuperseded zone render is byte-identical across rounds");
	assert.match(JSON.stringify(p2[1]), /\[acp-summary id=s2 /, "the new block appends to the zone");
	// Block text legitimately survives inside the zone's index intent lines;
	// what must vanish is the active-zone message itself.
	const activeUserTexts = (msgs: AgentMessage[]) =>
		msgs
			.filter((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[acp-summary"))
			.map((m) => m.content as string);
	assert.deepEqual(activeUserTexts(p1).map((t) => t.slice(0, 15)), ["journal block 7", "journal block 8", "journal block 9"], "p1 active = protected + fresh");
	assert.deepEqual(activeUserTexts(p2).map((t) => t.slice(0, 15)), ["journal block 7", "journal block 9"], "p2 active = never-manifested blocks only; rounds 1+2 folded");
	assert.ok(p2.map((m) => JSON.stringify(m)).join("").includes("Retired the fresh block."), "round-2 summary rendered");
	assert.notEqual(JSON.stringify(p2.slice(1)), JSON.stringify(p1.slice(1)), "active zone re-rendered (cache miss expected)");
	console.log("ok: D zone prefix byte-identical across compressions; active zone filtered");
}

// --- E: end-to-end mock-model session ---------------------------------------------------

const cwdE2E = mkdtempSync(join(tmpdir(), "acp-t3-e2e-"));
const turnText = (label: string, n: number) => `${label}: ` + "detailed journal text about the parser bug and the failing test. ".repeat(n);
const e2eKeep = { id: "", summary: "Condensed record of the parser investigation and test setup turns." };
// Content-directed scripting (a positional response list desynchronizes: the
// first request of a session fires with only the base reminder user message,
// before the prompt's own text lands). Routing keys off the LAST user message,
// which stays stable across one turn's tool loop.
const e2eStage = { compressed: false, retried: false };
const mock = createMockModel({
	handler: (context) => {
		const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
		const lastText = JSON.stringify(lastUser?.content ?? "");
		const reply = (text: string) => ({ content: [text] as const });
		const toolCall = (keep: string[], summary: string) => ({
			content: [{ type: "toolCall", name: "compress_context", arguments: { keep, summary } }] as const,
		});
		if (lastText.includes("compress it now")) {
			if (!e2eStage.compressed) {
				e2eStage.compressed = true;
				return toolCall([e2eKeep.id], e2eKeep.summary);
			}
			return reply("Compression done, continuing work.");
		}
		if (lastText.includes("Compress again")) {
			if (!e2eStage.retried) {
				e2eStage.retried = true;
				return toolCall([], "everything else");
			}
			return reply("Second attempt rejected as expected.");
		}
		if (lastText.includes("task two")) return reply("Turn two recorded.");
		// First request (reminder-only) and the task-one turn.
		return reply("Turn one recorded.");
	},
});
const sessionManager = SessionManager.create(cwdE2E);
// Spec §10 assembly: per-session base auto-compaction OFF via a live isolated
// settings object — the §5.3 degrade path writes compaction.enabled back on it.
const settings = Settings.isolated({ "compaction.enabled": false });
assert.equal(cfgCompactionEnabled.get(settings), false, "base compaction pinned off for the ACP session");
const e2eParams: Partial<AcpParams> = { l1: 50, l2: 120, l3: 200, target: 10_000, tailTurns: 0, tailTokens: 0 };
const state = createAcpRuntime({
	model: mock,
	sink: sessionManager,
	getEntries: () => sessionManager.getEntries(),
	params: e2eParams,
});
// The prompt path resolves keys through modelRegistry.authStorage (agent-session
// #promptWithMessage). A real AuthStorage with an in-memory runtime key for the
// "mock" provider satisfies the gate without touching any credential store
// (same shape as the base repo's agent-session tests).
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
	customTools: [createCompressContextTool(state)] as never,
	getApiKey: async () => "mock-key",
	extensions: [createAcpProjectionExtension(state)] as never,
	disableExtensionDiscovery: true,
	enableMCP: false,
	hasUI: true,
});

// On this dispatch path session.prompt resolves before the turn runs and the
// queue serializes turns FIFO (user messages journal at dispatch, assistants
// only at turn completion) — so each ask polls for its turn's assistant count.
const assistantCount = () =>
	sessionManager.getEntries().filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message" && e.message.role === "assistant").length;
const ask = async (text: string, expectAssistants: number) => {
	await session.prompt(text);
	for (let i = 0; i < 1_000 && assistantCount() < expectAssistants; i++) await Bun.sleep(10);
	assert.ok(assistantCount() >= expectAssistants, `turn for "${text.slice(0, 24)}" did not complete (${assistantCount()}/${expectAssistants} assistants)`);
};

await ask(turnText("task one", 24), 1);
await ask(turnText("task two", 24), 2);

// Manifest supply (T3: test-injected; T4 wires the ephemeral generation):
// candidates = every block of the two settled turns (no protected tail in params).
const manifestSource = sessionManager
	.getEntries()
	.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
	.map((e) => ({ id: e.id, message: e.message as AgentMessage }));
const manifestBlocks = splitBlocks(manifestSource, countTokens);
assert.equal(manifestBlocks.length, 4, "two user + two assistant-text blocks");
state.setManifest(manifestBlocks.map((b) => b.id));
e2eKeep.id = manifestBlocks[manifestBlocks.length - 1].id; // keep the latest assistant text block

await ask("The context is large; compress it now.", 4);
await ask("Compress again right away.", 6);
await ask("One more normal round.", 7);
// Tool results: first call succeeded with exact stats, second rejected on the consumed manifest.
const compressResults = sessionManager
	.getEntries()
	.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
	.map((e) => e.message as AgentMessage)
	.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult")
	.filter((m) => m.toolName === "compress_context");
assert.equal(compressResults.length, 2, "both model-issued compress_context calls executed");
const firstOutcome = JSON.parse(resultText(compressResults[0].content));
const secondOutcome = JSON.parse(resultText(compressResults[1].content));
assert.equal(firstOutcome.ok, true);
assert.equal(firstOutcome.compressed.blocks, 3, "manifest of 4 minus the kept block");
assert.equal(firstOutcome.kept.blocks, 1);
assert.equal(firstOutcome.tier, computeTier(firstOutcome.activeTokensAfter, state.params));
assert.equal(secondOutcome.ok, false);
assert.equal(secondOutcome.code, "manifest-consumed");
console.log("ok: E tool_result stats correct; same-batch second call rejected (consumed manifest)");

// Journal: the compaction block went to disk through the official channel; a
// rejected call added nothing (zero side effects end to end).
const sessionFile = sessionManager.getSessionFile()!;
assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the acp-probe agentDir, got ${sessionFile}`);
const raw = await Bun.file(sessionFile).text();
assert.equal(raw.split('"customType":"acpSummary"').length - 1, 1, "exactly one acpSummary entry, from the successful call only");
console.log("ok: E acpSummary persisted via appendCustomEntry; rejection wrote nothing");

// Projection on the wire: the post-tool follow-up (call 3) and the next round
// (call 6) must carry the rendered zone first and drop the compressed blocks;
// tools and system prompt byte-stable across every call (acceptance 9).
assert.ok(mock.calls.length >= 7, `expected at least 7 mock calls, got ${mock.calls.length}`);
const call3 = mock.calls[3];
const call6 = mock.calls[6];
const flat6 = call6.context.messages.map((m) => JSON.stringify(m)).join("");
// The base's date/cwd reminder rides ON the first user turn, so the zone
// render arrives reminder-prefixed — match on the zone marker, not the head.
const wire0 = JSON.stringify(call6.context.messages[0]);
assert.ok(call6.context.messages[0].role === "user" && wire0.includes("[acp-summary id="), "zone renders first on the wire");
assert.ok(wire0.includes(e2eKeep.summary), "the summary text reaches the model");
const nonZoneUsers = call6.context.messages.filter((m) => m.role === "user" && !JSON.stringify(m).includes("[acp-summary id="));
assert.ok(!nonZoneUsers.some((m) => JSON.stringify(m).includes("task one") || JSON.stringify(m).includes("task two")), "compressed turns left the request");
assert.ok(nonZoneUsers.some((m) => JSON.stringify(m).includes("compress it now")), "the compress turn stays");
assert.equal(
	JSON.stringify(call3.context.messages[0]),
	JSON.stringify(call6.context.messages[0]),
	"rendered zone segment byte-identical across requests",
);
const toolNamesOf = (c: (typeof mock.calls)[number]) =>
	(c.context.tools ?? []).map((t) => t.name).sort().join(",");
for (const c of mock.calls) {
	assert.equal(toolNamesOf(c), toolNamesOf(mock.calls[0]), "tool surface stable across compressions (acceptance 9)");
	assert.ok(toolNamesOf(c).includes("compress_context"), "compress_context is in the active tool set");
	assert.equal(JSON.stringify(c.context.systemPrompt), JSON.stringify(mock.calls[0].context.systemPrompt), "system prompt stable");
}
console.log("ok: E projection live on subsequent requests; tools/system byte-stable");

// Rebuild parity (T2): restart state matches the runtime zone/compressed set.
const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
const rebuilt = rebuildAcpState(reopened.getEntries());
assert.equal(rebuilt.degraded, false);
assert.deepEqual(rebuilt.zone.map((z) => z.id), state.zone.map((z) => z.id));
assert.deepEqual([...rebuilt.compressedBlockIds].sort(), [...state.compressed].sort());
console.log("ok: E rebuild parity — runtime zone/compressed set matches the journal");

// §5.3 degrade demo: write compaction.enabled back on the live session settings
// object — the session's compaction policy getter resolves settings every turn
// (session-maintenance #compactionSettings), so the base chain resumes immediately.
cfgCompactionEnabled.override(settings, true);
assert.equal(cfgCompactionEnabled.get(settings), true);
const sessionSettings = session.settings; // the same live object handed to createAgentSession
assert.ok(sessionSettings === settings || cfgCompactionEnabled.get(sessionSettings) === true);
console.log("ok: E degrade demo — compaction.enabled write-back takes effect on the session settings");

await reopened.close(); // release the OS lock sidecar so the dir cleanup sticks
// The SDK journals a session_exit line at process exit (after this cleanup
// runs), recreating the session dir — remove again from an exit handler.
const sessionDir = dirname(sessionFile);
process.on("exit", () => {
	rmSync(sessionDir, { recursive: true, force: true });
	rmSync(cwdE2E, { recursive: true, force: true });
});
rmSync(sessionDir, { recursive: true, force: true });
assert.ok(!existsSync(sessionDir), "session dir fully removed (incl. lock files)");
rmSync(cwdE2E, { recursive: true, force: true });
console.log("\nALL ACP T3 TOOL SMOKE CHECKS PASSED");
