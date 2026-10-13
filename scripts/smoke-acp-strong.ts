// ACP T6 smoke: level-2 strong compression + pending-strong state (spec
// §5.2/§6/§7/§9, acceptance 6/11/14-partial). Single-process bun run.
//
// Layers:
//   A  the §5.2 two-axis decision table as one function: zone line strict >,
//      riding only above L1, >L3 strong regardless of the zone axis
//   B  ephemeral annotation: uniform "next compression will be strong" note
//      while the zone is over its line — including tier=none (row 6, where the
//      ephemeral must still be emitted), absent while under the line, and
//      compress=strong only once active > L1 (row 5)
//   C  strong execution (acceptance 6): S1{a}+S2{b} -> M folds c — M inherits
//      the full compressedIds/index union, supersedes both, depth 1, zone
//      collapses to one render; rebuildAcpState agrees without walking chains;
//      multi-layer M -> M2 reaches depth 2; the recall data-layer stand-in is
//      M.index holding the full set after rebuild (tool behavior is T5)
//   D  riding rules on the execution path: pending + active <= L1 stays normal
//      (no riding, zone keeps appending); >L3 goes strong directly with an
//      empty zone (no supersede, depth 1)
//   E  pure reset (§6.6 exception): strong with an empty compressed set
//      submits on the old-summaries budget basis; the normal path rejects the
//      same shape with zero side effects (acceptance 14 first half)
//   F  keep does not inherit (acceptance 11): last round's kept blocks are
//      ordinary candidates again and get folded when not re-kept
//   G  real SessionManager round-trip: JSONL carries supersedes/depth/method,
//      reopen + rebuildAcpState restores the single-block zone
//   H  end-to-end mock-model session: the same compress_context tool and
//      schema drives both compressions (model-agnostic); annotation reaches
//      the wire; post-strong projection shows exactly one zone render
//
// All session data lands under the OMP_PROFILE=acp-probe profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directory at the end.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-strong.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import {
	AcpRuntimeState,
	createAcpProjectionExtension,
	createCompressContextTool,
} from "../host/acp-runtime.ts";
import { computeRoundPlan, type AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData, CompressOutcome, CompressRejection } from "../host/acp-runtime.ts";
import { assertToolPairing, renderCompactionBlock } from "../host/acp-projection.ts";
import { rebuildAcpState } from "../host/acp-persist.ts";

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
// v10: the compress entry speaks bN short refs (spec §3); fixtures pin entry ids.
const R = (st: { shortRef(id: string): string | undefined }, ids: string[]): string[] => ids.map((id) => st.shortRef(id)!);
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

/**
 * Fixture: user blocks of ~`blockTokens` tokens each over a fake sink that
 * ALSO journals the acpSummary custom entries, so rebuildAcpState runs on the
 * same data a real journal would hold. `contextWindow` sets the §5.2 zone line
 * (window × 35%); 0 = no zone axis.
 */
function makeFixture(params: Partial<AcpParams>, blocks: number[], contextWindow = 0, blockTokens = 400): Fixture {
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
	blocks.forEach((_, i) => {
		const message = {
			role: "user",
			content: blockText(i, blockTokens),
			timestamp: 1_700_000_000_000 + i,
		} as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	});
	const state = new AcpRuntimeState({
		countTokens,
		sink,
		getEntries: () => entries as never as SessionEntry[],
		contextWindow,
		params,
	});
	return { state, writes, entries, view };
}

/** Append more journal blocks to a live fixture (entries + view stay aligned). */
function addBlocks(fx: Fixture, count: number, blockTokens = 400): void {
	const base = fx.entries.filter((e) => e.type === "message").length;
	for (let i = 0; i < count; i++) {
		const message = {
			role: "user",
			content: blockText(base + i, blockTokens),
			timestamp: 1_700_000_100_000 + base + i,
		} as never as AgentMessage;
		fx.entries.push({ type: "message", id: `e${base + i}`, message });
		fx.view.push(message);
	}
}

const NO_TAIL: Partial<AcpParams> = { tailTurns: 0, tailTokens: 0 };
const PARAMS = { l1: 1_000, l2: 2_000, l3: 3_000, target: 1_000_000, ...NO_TAIL } as const;

/** The ephemeral text of the latest projection (asserts its user-role tail position). */
function ephemeralText(fx: Fixture): string {
	const m = fx.state.lastProjected.at(-1)!;
	assert.equal(m.role, "user", "ephemeral rides a user-role message at the end");
	return textOf(m);
}

/**
 * Rendered size of one zone block with a `summaryTokens` summary and `lines`
 * index lines — used to place the window limit strictly between one and two
 * such blocks, so the pending-strong flip happens exactly after round 2.
 */
function zoneBlockSize(summaryTokens: number, lines: number): number {
	const block: AcpSummaryData = {
		id: "s?",
		summary: tokenText(summaryTokens),
		index: Array.from({ length: lines }, (_, i) => ({ id: `e${i}`, tokens: 400, intent: "journal block tail for the index render" })),
		meta: { createdAt: 0, depth: 0, method: "normal", keepIds: [], compressedIds: [], supersedes: [], tokensBefore: 0, tokensAfter: 0 },
	};
	return countTokens(renderCompactionBlock(block, countTokens));
}

// --- A: two-axis decision table (§5.2 rows 4-6) --------------------------------------------

{
	const zone = (tokens: number, limitTokens: number) => ({ tokens, limitTokens });
	// Row 5: over the line AND active > L1 -> rides strong.
	assert.deepEqual(computeRoundPlan(1_001, PARAMS, zone(100, 99)), { tier: "L1", method: "strong", pendingStrong: true });
	assert.deepEqual(computeRoundPlan(2_500, PARAMS, zone(9_999, 1)), { tier: "L2", method: "strong", pendingStrong: true });
	// Row 6: over the line at or under L1 -> annotated but NOT riding.
	assert.deepEqual(computeRoundPlan(1_000, PARAMS, zone(9_999, 1)), { tier: "none", method: "normal", pendingStrong: true });
	assert.deepEqual(computeRoundPlan(999, PARAMS, zone(9_999, 1)), { tier: "none", method: "normal", pendingStrong: true });
	// Zone exactly at its line is NOT over (strict >, acceptance-19-style boundary).
	assert.deepEqual(computeRoundPlan(1_500, PARAMS, zone(100, 100)), { tier: "L1", method: "normal", pendingStrong: false });
	// Row 4: past L3 the method is strong regardless of the zone axis.
	assert.deepEqual(computeRoundPlan(3_001, PARAMS, zone(0, 9_999)), { tier: "L3", method: "strong", pendingStrong: false });
	assert.deepEqual(computeRoundPlan(3_001, PARAMS, zone(9_999, 1)), { tier: "L3", method: "strong", pendingStrong: true });
	// limit 0 = unknown window: the zone axis never fires.
	assert.deepEqual(computeRoundPlan(1_500, PARAMS, zone(9_999, 0)), { tier: "L1", method: "normal", pendingStrong: false });
	console.log("ok: A two-axis table — riding only over-L1+over-line; =line is not pending; >L3 strong regardless");
}

// --- B: ephemeral annotation (§5.2/§7) ------------------------------------------------------

{
	// Window sized so the limit sits strictly between one and two seeded zone
	// blocks: after round 1 the zone is under, after round 2 over.
	const one = zoneBlockSize(120, 1);
	const limit = Math.floor(one + one / 3);
	const window = Math.ceil(limit / 0.35);
	const fx = makeFixture({ ...PARAMS }, [0, 0, 0, 0], window);

	fx.state.projectView(fx.view); // active 4x406 > l1, <= l2: tier L1, zone empty
	let text = ephemeralText(fx);
	assert.match(text, /\[acp-status\] tier=L1 compress=normal zone=0 tokens/);
	assert.ok(!text.includes("Pending strong"), "no annotation while the zone is under its line");

	accepted(await fx.state.compress({ keep: R(fx.state, ["e1", "e2", "e3"]), summary: tokenText(120) })); // S1{e0}
	fx.state.projectView(fx.view); // active 3x406 > l1, zone ~one < limit
	text = ephemeralText(fx);
	assert.ok(!text.includes("Pending strong"), "annotation still absent under the line after one zone block");
	assert.ok(fx.state.roundStatus!.zoneTokens > 0 && fx.state.roundStatus!.zoneTokens < limit, "fixture zone really is under the line");

	accepted(await fx.state.compress({ keep: R(fx.state, ["e2", "e3"]), summary: tokenText(120) })); // S2{e1}
	fx.state.projectView(fx.view);
	assert.ok(fx.state.roundStatus!.zoneTokens > limit, "fixture zone really is over the line after two blocks");

	// Row 6: fold the remaining blocks so active drops under L1 while the zone
	// stays over its line — tier=none + pending must still emit the ephemeral.
	accepted(await fx.state.compress({ keep: [], summary: tokenText(120) })); // folds e2,e3 -> active 0
	fx.state.projectView(fx.view);
	text = ephemeralText(fx);
	assert.match(text, /\[acp-status\] tier=none compress=normal zone=\d+ tokens/, "row 6: emitted at tier=none");
	assert.ok(text.includes("Pending strong"), "row 6 carries the annotation");
	assert.ok(!text.includes("activation line"), "row 6 has no tier instruction — the annotation is the message");

	// Row 5: grow active past L1 -> same annotation, method flips to strong.
	addBlocks(fx, 3);
	fx.state.projectView(fx.view);
	text = ephemeralText(fx);
	assert.match(text, /\[acp-status\] tier=L1 compress=strong zone=\d+ tokens/, "row 5: method flips once active > L1");
	assert.ok(text.includes("Pending strong"), "row 5 carries the annotation");
	// The annotation line is byte-stable across requests while state is unchanged.
	fx.state.projectView([...fx.view]);
	assert.equal(ephemeralText(fx), text, "annotation rendering deterministic");
	console.log("ok: B annotation — absent under the line; uniform at tier=none (row 6) and L1 (row 5); stable bytes");
}

// --- C: strong execution + inheritance + rebuild (acceptance 6) ----------------------------

{
	// Zone line between one and two seeded blocks; summaries 120 tokens each,
	// the strong summary 220 (budget at round 3 = (500 + zone)/3 keeps it legal).
	const one = zoneBlockSize(120, 1);
	const limit = Math.floor(one + one / 3);
	const window = Math.ceil(limit / 0.35);
	// l3 4000 sits above the round-1 active total (6 x ~506) so rounds 1-2 stay normal.
	const fx = makeFixture({ ...PARAMS, l3: 4_000 }, [0, 0, 0, 0, 0, 0], window, 500);

	fx.state.projectView(fx.view);
	accepted(await fx.state.compress({ keep: R(fx.state, ["e1", "e2", "e3", "e4", "e5"]), summary: tokenText(120) })); // S1{e0}
	fx.state.projectView(fx.view);
	assert.ok(!fx.state.roundStatus!.pendingStrong, "one zone block: under the line");
	accepted(await fx.state.compress({ keep: R(fx.state, ["e2", "e3", "e4", "e5"]), summary: tokenText(120) })); // S2{e1}
	const [s1, s2] = fx.writes;
	assert.equal(s2.meta.method, "normal");

	fx.state.projectView(fx.view);
	assert.ok(fx.state.roundStatus!.pendingStrong, "two zone blocks: over the line");
	assert.equal(fx.state.roundStatus!.method, "strong", "active 4x500 > l1: round 3 rides strong");
	const out3 = accepted(await fx.state.compress({ keep: R(fx.state, ["e3", "e4", "e5"]), summary: tokenText(220) })); // M{e2}
	const m = fx.writes[2];
	assert.equal(m.meta.method, "strong");
	assert.deepEqual(m.meta.supersedes, [s1.id, s2.id], "M supersedes every unsuperseded zone block");
	assert.equal(m.meta.depth, 1, "depth+1 past the superseded generation");
	assert.deepEqual([...m.meta.compressedIds].sort(), ["e0", "e1", "e2"].sort(), "compressedIds = inherited union + this round's fold");
	assert.deepEqual(m.index.map((l) => l.id).sort(), ["e0", "e1", "e2"].sort(), "index holds the full inherited set (recall data layer)");
	assert.deepEqual(fx.state.zone.map((z) => z.id), [m.id], "runtime zone collapses to the single strong block");
	assert.ok(fx.state.compressed.has("e0") && fx.state.compressed.has("e1") && fx.state.compressed.has("e2"));
	assert.equal(out3.compressed.blocks, 1, "only e2 was newly folded this round");

	// Rebuild from the journal-shaped entries: no supersedes-chain walking.
	let rebuilt = rebuildAcpState(fx.entries as never as SessionEntry[]);
	assert.equal(rebuilt.degraded, false);
	assert.deepEqual(rebuilt.zone.map((z) => z.id), [m.id]);
	assert.equal(rebuilt.zone[0].meta.depth, 1);
	assert.equal(rebuilt.zone[0].meta.method, "strong");
	assert.deepEqual([...rebuilt.compressedBlockIds].sort(), ["e0", "e1", "e2"].sort());
	assert.deepEqual(rebuilt.zone[0].index.map((l) => l.id).sort(), ["e0", "e1", "e2"].sort(), "M.index survives rebuild with the full set");

	// Projection: exactly one zone render, first, replacing S1/S2; prefix semantics
	// preserved (the new block occupies the zone-head position the old ones held).
	fx.state.projectView(fx.view);
	const projected = JSON.stringify(fx.state.lastProjected);
	assert.equal(projected.split("[acp-summary id=").length - 1, 1, "zone renders as a single block");
	assert.match(textOf(fx.state.lastProjected[0]), /^\[acp-summary id=\S+ .*depth=1 blocks=3 method=strong\]/, "the surviving render is M itself");
	assert.doesNotThrow(() => assertToolPairing(fx.state.lastProjected), "pairing invariant holds after the strong reset");

	// Multi-layer: pending again (M's render over the line), fold the rest -> M2.
	assert.ok(fx.state.roundStatus!.pendingStrong, "M render is over the line again");
	const out4 = accepted(await fx.state.compress({ keep: [], summary: tokenText(220) })); // M2{e3,e4,e5}
	const m2 = fx.writes[3];
	assert.equal(out4.compressed.blocks, 3);
	assert.equal(m2.meta.method, "strong");
	assert.deepEqual(m2.meta.supersedes, [m.id]);
	assert.equal(m2.meta.depth, 2, "second strong generation: depth 2");
	assert.deepEqual([...m2.meta.compressedIds].sort(), ["e0", "e1", "e2", "e3", "e4", "e5"].sort(), "M2 inherits M's full set and adds its own");
	assert.equal(m2.index.length, 6, "M2 index = 3 inherited + 3 new lines");

	rebuilt = rebuildAcpState(fx.entries as never as SessionEntry[]);
	assert.deepEqual(rebuilt.zone.map((z) => z.id), [m2.id], "rebuild collapses the chain to M2 alone");
	assert.equal(rebuilt.zone[0].meta.depth, 2);
	assert.deepEqual([...rebuilt.compressedBlockIds].sort(), ["e0", "e1", "e2", "e3", "e4", "e5"].sort(), "all six compressed via M2 — no recursion");
	assert.equal(rebuilt.zone[0].index.length, 6);
	console.log("ok: C strong exec — inheritance/depth/supersede correct at both layers; rebuild chain-free; single render");
}

// --- D: riding rules on the execution path -------------------------------------------------

{
	// No riding at or under L1: pending zone, small active zone -> normal append.
	const one = zoneBlockSize(60, 1);
	const limit = Math.floor(one + one / 3);
	const window = Math.ceil(limit / 0.35);
	const fx = makeFixture({ ...PARAMS }, [0, 0, 0, 0], window, 200); // 4 x 200 = 800 <= l1
	fx.state.projectView(fx.view);
	accepted(await fx.state.compress({ keep: R(fx.state, ["e1", "e2", "e3"]), summary: tokenText(60) })); // S1{e0}, budget 66
	fx.state.projectView(fx.view);
	accepted(await fx.state.compress({ keep: R(fx.state, ["e2", "e3"]), summary: tokenText(60) })); // S2{e1}
	fx.state.projectView(fx.view);
	assert.ok(fx.state.roundStatus!.pendingStrong, "zone over the line");
	assert.ok(fx.state.roundStatus!.activeTokens <= PARAMS.l1, "active at or under L1");
	accepted(await fx.state.compress({ keep: R(fx.state, ["e3"]), summary: tokenText(60) })); // normal despite pending
	assert.deepEqual(fx.writes[2].meta.supersedes, []);
	assert.equal(fx.state.zone.length, 3, "zone keeps appending — no reset");

	// Past L3: strong directly, even with an empty zone and a huge window.
	const hot = makeFixture({ ...PARAMS }, [0, 0, 0, 0, 0, 0, 0, 0], 10_000_000, 500); // 8 x 500 = 4000 > l3
	hot.state.projectView(hot.view);
	assert.equal(hot.state.roundStatus!.method, "strong", "row 4: >L3 forces strong regardless of zone");
	accepted(await hot.state.compress({ keep: [], summary: tokenText(500) }));
	const direct = hot.writes[0];
	assert.equal(direct.meta.method, "strong");
	assert.deepEqual(direct.meta.supersedes, [], "nothing to supersede on an empty zone");
	assert.equal(direct.meta.depth, 1, "first strong generation");
	assert.deepEqual(hot.state.zone.map((z) => z.id), [direct.id]);
	console.log("ok: D riding — <=L1 pending stays normal (no collapse); >L3 direct strong on an empty zone");
}

// --- E: pure reset (§6.6 exception, acceptance 14 first half) ------------------------------

{
	const one = zoneBlockSize(120, 1);
	const limit = Math.floor(one + one / 3);
	const window = Math.ceil(limit / 0.35);
	// 5 x 500: after two rounds the active zone (3 x 500) is still past L1, so
	// the keep-everything round rides strong and hits the §6.6 exception.
	const fx = makeFixture({ ...PARAMS }, [0, 0, 0, 0, 0], window, 500);

	fx.state.projectView(fx.view);
	accepted(await fx.state.compress({ keep: R(fx.state, ["e1", "e2", "e3", "e4"]), summary: tokenText(120) })); // S1{e0}
	fx.state.projectView(fx.view);
	accepted(await fx.state.compress({ keep: R(fx.state, ["e2", "e3", "e4"]), summary: tokenText(120) })); // S2{e1}
	const [s1, s2] = fx.writes;
	fx.state.projectView(fx.view);
	assert.ok(fx.state.roundStatus!.pendingStrong);
	assert.equal(fx.state.roundStatus!.method, "strong", "active 3x500 > l1: the pure reset rides strong");
	const zoneBefore = fx.state.roundStatus!.zoneTokens;

	// keep = the entire manifest: empty compressed set, legal only as a strong
	// pure reset whose budget basis is the merged old summaries.
	const summary = tokenText(Math.max(10, Math.floor(zoneBefore / 3) - 15));
	const out = accepted(await fx.state.compress({ keep: R(fx.state, ["e2", "e3", "e4"]), summary }));
	const pure = fx.writes[2];
	assert.equal(pure.meta.method, "strong");
	assert.deepEqual(pure.meta.supersedes, [s1.id, s2.id]);
	assert.equal(pure.meta.depth, 1);
	assert.deepEqual([...pure.meta.compressedIds].sort(), ["e0", "e1"].sort(), "compressedIds = inherited set only");
	assert.deepEqual(pure.index.map((l) => l.id).sort(), ["e0", "e1"].sort(), "index = inherited lines only");
	assert.deepEqual(fx.state.zone.map((z) => z.id), [pure.id]);
	assert.equal(fx.state.manifest!.consumed, true, "a successful pure reset consumes the manifest");
	const rebuilt = rebuildAcpState(fx.entries as never as SessionEntry[]);
	assert.deepEqual(rebuilt.zone.map((z) => z.id), [pure.id]);
	assert.deepEqual([...rebuilt.compressedBlockIds].sort(), ["e0", "e1"].sort());

	// Contrast — not pending (huge window), keep everything: rejected, zero side effects.
	const calm = makeFixture({ ...PARAMS }, [0, 0, 0, 0], 10_000_000, 500);
	calm.state.projectView(calm.view);
	const r = rejected(await calm.state.compress({ keep: R(calm.state, ["e0", "e1", "e2", "e3"]), summary: tokenText(10) }));
	assert.equal(calm.writes.length, 0, "zero side effects");
	assert.equal(calm.state.manifest!.consumed, false, "manifest not consumed by a rejection");
	console.log("ok: E pure reset — strong submits on the old-summary basis; normal path rejects keep-everything");
}

// --- F: keep does not inherit (acceptance 11) ----------------------------------------------

{
	const fx = makeFixture({ ...PARAMS }, [0, 0, 0, 0], 10_000_000, 500);
	fx.state.projectView(fx.view);
	accepted(await fx.state.compress({ keep: R(fx.state, ["e1", "e2"]), summary: tokenText(60) })); // S1{e0,e3}
	fx.state.projectView(fx.view);
	assert.ok(
		["e1", "e2"].every((id) => fx.state.roundStatus!.manifestIds.includes(id)),
		"last round's keep ids are plain candidates again (keep does not inherit)",
	);
	accepted(await fx.state.compress({ keep: [], summary: tokenText(60) })); // S2 folds e1,e2
	assert.ok(!fx.state.activeBlocks().some((b) => b.id === "e1" || b.id === "e2"), "not re-kept -> folded");
	assert.ok(fx.state.compressed.has("e1") && fx.state.compressed.has("e2"));
	console.log("ok: F keep-no-inherit — prior keep blocks re-listed and folded when not re-kept");
}

// --- G: real SessionManager round-trip (JSONL fields + reopen rebuild) ---------------------

const cwdG = mkdtempSync(join(tmpdir(), "acp-t6-disk-"));
{
	const one = zoneBlockSize(120, 1);
	const limit = Math.floor(one + one / 3);
	const window = Math.ceil(limit / 0.35);
	const sessionManager = SessionManager.create(cwdG);
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		contextWindow: window,
		// l3 4000 sits above the round-1 active total (6 x ~506) so rounds 1-2 stay normal.
		params: { l1: 800, l2: 1_600, l3: 4_000, target: 1_000_000, tailTurns: 0, tailTokens: 0 },
	});

	// Six 500-token user turns journaled through the real channel.
	const view: AgentMessage[] = [];
	const userIds: string[] = [];
	for (let i = 0; i < 6; i++) {
		const message = { role: "user", content: blockText(i, 500), timestamp: 1_700_000_200_000 + i } as never as AgentMessage;
		userIds.push(sessionManager.appendMessage(message));
		view.push(message);
	}
	// An assistant turn materializes the JSONL (user-only journals stay in
	// memory until then — T2 precedent); complete usage keeps it quiet.
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as never);

	state.projectView(view);
	accepted(await state.compress({ keep: R(state, userIds.slice(1)), summary: tokenText(120) })); // S1{u0}
	state.projectView(view);
	accepted(await state.compress({ keep: R(state, userIds.slice(2)), summary: tokenText(120) })); // S2{u1}
	state.projectView(view);
	assert.ok(state.roundStatus!.pendingStrong, "zone over the line before the strong round");
	assert.equal(state.roundStatus!.method, "strong", "active 4x500 > l1 800: riding");
	accepted(await state.compress({ keep: R(state, userIds.slice(3)), summary: tokenText(220) })); // M{u2}
	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the acp-probe agentDir, got ${sessionFile}`);
	// Cleanup registers BEFORE the section asserts: a failed run must not leak
	// probe session dirs (the SDK journals session_exit at process exit).
	const sessionDir = dirname(sessionFile);
	process.on("exit", () => {
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwdG, { recursive: true, force: true });
	});
	const raw = await Bun.file(sessionFile).text();
	assert.equal(raw.split('"customType":"acpSummary"').length - 1, 3, "three acpSummary entries on disk");
	const summaryEntries = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary");
	assert.equal(summaryEntries.length, 3);
	const [dS1, dS2, dM] = summaryEntries.map((e) => (e.data as AcpSummaryData).meta);
	assert.equal(dS1.method, "normal");
	assert.equal(dS2.method, "normal");
	assert.equal(dM.method, "strong", "JSONL meta.method carries the strong marker");
	assert.deepEqual(dM.supersedes, [summaryEntries[0].id, summaryEntries[1].id], "JSONL meta.supersedes lists both replaced blocks");
	assert.equal(dM.depth, 1, "JSONL meta.depth = 1");
	assert.deepEqual([...dM.compressedIds].sort(), [userIds[0], userIds[1], userIds[2]].sort(), "JSONL compressedIds holds the union");

	// Reopen from disk and rebuild: single-block zone, full compressed set.
	const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	const rebuilt = rebuildAcpState(reopened.getEntries());
	assert.equal(rebuilt.degraded, false);
	assert.deepEqual(rebuilt.zone.map((z) => z.id), [summaryEntries[2].id]);
	assert.equal(rebuilt.zone[0].meta.depth, 1);
	assert.deepEqual([...rebuilt.compressedBlockIds].sort(), [userIds[0], userIds[1], userIds[2]].sort());
	assert.equal(rebuilt.zone[0].index.length, 3, "M.index complete after reopen (recall data layer, T5 stands in)");

	await sessionManager.close();
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "session dir fully removed (incl. lock files)");
	console.log("ok: G disk round-trip — JSONL supersedes/depth/method correct; reopen rebuilds the single-block zone");
}
rmSync(cwdG, { recursive: true, force: true });

// --- H: end-to-end mock session — same tool, same schema, strong on the wire ---------------

const cwdH = mkdtempSync(join(tmpdir(), "acp-t6-e2e-"));
{
	const turnText = (label: string, tokens: number) => {
		let text = `${label}: `;
		while (countTokens(text) < tokens) text += "detailed journal text about the parser bug and the failing test. ";
		return text;
	};
	// Window 1000 -> zone line 350 tokens: one normal block (summary 300) puts
	// the zone over the line, so the second compress rides strong.
	let sawAnnotation = false;
	let compressedOnce = false;
	const mock = createMockModel({
		contextWindow: 1_000,
		handler: (context: { messages: Array<{ role: string; content: unknown }> }) => {
			const users = [...context.messages].reverse().filter((m) => m.role === "user");
			const routed = users.find((m) => !textOf(m).includes("[acp-status]")) ?? users[0];
			const text = textOf(routed ?? { role: "user", content: "" });
			if (text.includes("compress it now") && !compressedOnce) {
				compressedOnce = true;
				return {
					content: [{ type: "toolCall", name: "compress_context", arguments: { keep: [], summary: tokenText(300) } }] as const,
				};
			}
			if (text.includes("compress again")) {
				const status = users.find((m) => textOf(m).startsWith("[acp-status]"));
				assert.ok(status, "the second compress request carried the ephemeral");
				sawAnnotation = textOf(status!).includes("Pending strong");
				assert.match(textOf(status!), /compress=strong/, "the ephemeral announced the strong method");
				return {
					content: [{ type: "toolCall", name: "compress_context", arguments: { keep: [], summary: tokenText(300) } }] as const,
				};
			}
			return { content: ["Turn recorded."] as const };
		},
	});
	const sessionManager = SessionManager.create(cwdH);
	const settings = Settings.isolated({ "compaction.enabled": false });
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		contextWindow: mock.contextWindow,
		params: { l1: 2_000, l2: 4_000, l3: 6_000, target: 1_000_000, tailTurns: 0, tailTokens: 0 } as Partial<AcpParams>,
	});
	const authStorage = await AuthStorage.create(join(cwdH, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const modelRegistry = new ModelRegistry(authStorage, join(cwdH, "models.yml"));
	const { session } = await createAgentSession({
		cwd: cwdH,
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

	const assistantCount = () =>
		sessionManager.getEntries().filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message" && e.message.role === "assistant").length;
	const ask = async (text: string, expectAssistants: number) => {
		await session.prompt(text);
		for (let i = 0; i < 1_000 && assistantCount() < expectAssistants; i++) await Bun.sleep(10);
		assert.ok(assistantCount() >= expectAssistants, `turn for "${text.slice(0, 24)}" did not complete`);
	};

	await ask(turnText("task one", 1_200), 1);
	await ask(turnText("task two", 1_200), 2); // active ~2400 > l1 2000: ephemeral tier L1
	const firstStatus = mock.calls.at(-1)!.context.messages.at(-1)!;
	assert.match(textOf(firstStatus as { role: string; content: unknown }), /tier=L1 compress=normal/, "round 1 announced normal");

	await ask("The context is large; compress it now.", 3);
	assert.ok(compressedOnce, "model compressed via the plain tool schema (round 1)");
	const round1 = JSON.parse(
		resultText(
			sessionManager
				.getEntries()
				.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
				.map((e) => e.message as AgentMessage)
				.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === "compress_context")
				.at(-1)!.content,
		),
	) as CompressOutcome;
	assert.equal(round1.ok, true);

	await ask(turnText("task three", 1_200), 4);
	await ask(turnText("task four", 1_200), 5); // active ~2400 > l1, zone over the line
	await ask("compress again", 6);
	assert.ok(sawAnnotation, "the pending-strong annotation reached the wire before the strong round");

	const last = mock.calls.at(-1)!.context;
	const wire = JSON.stringify(last.messages);
	assert.equal(wire.split("[acp-summary id=").length - 1, 1, "post-strong wire carries exactly one zone render");
	assert.match(textOf(last.messages[0] as { role: string; content: unknown }), /method=strong/, "the surviving render is the strong block");
	// Folded-turn text legitimately survives inside the zone's index intent
	// lines (T4 precedent): judge only the non-zone messages.
	const nonZone = JSON.stringify(last.messages.filter((m) => !JSON.stringify(m).includes("[acp-summary id=")));
	assert.ok(!nonZone.includes("task one:") && !nonZone.includes("task three:"), "folded turns left the request");
	assert.ok(nonZone.includes("compress again"), "the triggering turn stays");

	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the acp-probe agentDir, got ${sessionFile}`);
	// Cleanup registers BEFORE the remaining asserts (same leak guard as G).
	const sessionDir = dirname(sessionFile);
	process.on("exit", () => {
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(cwdH, { recursive: true, force: true });
	});
	const raw = await Bun.file(sessionFile).text();
	assert.ok(!raw.includes("[acp-status]"), "no [acp-status] residue in the session JSONL");
	assert.equal(raw.split('"customType":"acpSummary"').length - 1, 2, "two acpSummary entries on disk");
	const metas = sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.customType === "acpSummary")
		.map((e) => (e.data as AcpSummaryData).meta);
	assert.equal(metas[0].method, "normal");
	assert.equal(metas[1].method, "strong");
	assert.deepEqual(metas[1].supersedes.length, 1, "the strong block superseded the round-1 block");
	assert.equal(metas[1].depth, 1);

	await sessionManager.close();
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "session dir fully removed (incl. lock files)");
	rmSync(cwdH, { recursive: true, force: true });
	console.log("ok: H e2e — same tool+schema drove normal then strong; annotation on the wire; single zone render; clean journal");
}

console.log("\nALL ACP T6 STRONG COMPRESSION SMOKE CHECKS PASSED");
