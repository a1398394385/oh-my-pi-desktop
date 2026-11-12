// compress_context rejection contract (spec §6): the declared code set and the
// codes planCompression actually emits must be the same set — no dead members,
// no undeclared emissions. Every case here drives a snapshot through
// planCompression, so the assertion is on behaviour, not on source text.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/acp-compress-rejection.test.ts
import { describe, expect, test } from "bun:test";
import { COMPRESS_REJECTION_CODES, type CompressSnapshot, planCompression } from "../host/acp-compress.ts";
import { type AcpParams, ACP_DEFAULT_PARAMS } from "../host/acp-plan.ts";
import type { AcpBlockInfo } from "../host/acp-projection.ts";

const PARAMS: AcpParams = {
	...ACP_DEFAULT_PARAMS,
	l1: 1_000,
	l2: 2_000,
	l3: 3_000,
	target: 500,
	minCompress: 10,
	summaryBudgetMax: 100,
};

function block(id: string, tokens: number): AcpBlockInfo {
	return { id, kind: "text", sourceId: `src-${id}`, tokens, intent: id };
}

/** A snapshot that plans successfully; each case mutates one axis into a rejection. */
function snapshot(overrides: Partial<CompressSnapshot> = {}): CompressSnapshot {
	return {
		degraded: false,
		manifest: { ids: ["a1"], consumed: false },
		active: [block("a1", 2_000)],
		protectedIds: new Set(),
		compressed: new Set(),
		zone: [],
		zoneTokens: 0,
		zoneLimitTokens: 0,
		forcedExecution: false,
		ratio: 1,
		params: PARAMS,
		countTokens: (text) => text.length,
		resolve: (ref) => ref,
		label: (id) => id,
		...overrides,
	};
}

type Case = { name: string; snap: CompressSnapshot; input: { keep?: string[]; summary?: string } };

const CASES: Case[] = [
	{ name: "degraded session (§5.3)", snap: snapshot({ degraded: true }), input: { summary: "s" } },
	// Exactly at L1 rejects: the entry gate is strict-greater (§5.2 v13).
	{ name: "active zone at L1", snap: snapshot({ active: [block("a1", 1_000)] }), input: { summary: "s" } },
	{ name: "no manifest (§6.1)", snap: snapshot({ manifest: null }), input: { summary: "s" } },
	{ name: "consumed manifest (§6.1)", snap: snapshot({ manifest: { ids: ["a1"], consumed: true } }), input: { summary: "s" } },
	{ name: "unknown keep id (§6.2)", snap: snapshot(), input: { keep: ["ghost"], summary: "s" } },
	{ name: "keep + protected over target (§6.3)", snap: snapshot(), input: { keep: ["a1"], summary: "s" } },
	{ name: "empty summary (§6.4)", snap: snapshot(), input: { summary: "   " } },
	{ name: "summary over budget (§6.5)", snap: snapshot(), input: { summary: "x".repeat(200) } },
	// countTokens 0 keeps the budget at 0 without triggering §6.5, exposing §6.6;
	// the target is raised so the full-keep set does not trip §6.3 first.
	{
		name: "nothing to compress (§6.6)",
		snap: snapshot({ params: { ...PARAMS, target: 5_000 }, countTokens: () => 0 }),
		input: { keep: ["a1"], summary: "s" },
	},
];

describe("compress_context rejection codes", () => {
	const observed = new Set<string>();
	for (const c of CASES) {
		test(`${c.name} rejects with a declared code`, () => {
			const result = planCompression(c.snap, c.input);
			if (!("reject" in result)) throw new Error(`expected a rejection, got a plan for ${c.name}`);
			observed.add(result.reject.code);
			expect(COMPRESS_REJECTION_CODES as readonly string[]).toContain(result.reject.code);
		});
	}

	test("every declared code is emitted by some path (no dead members)", () => {
		expect([...observed].sort()).toEqual([...COMPRESS_REJECTION_CODES].sort());
	});

	test("one token past L1 plans instead of rejecting", () => {
		const result = planCompression(snapshot({ active: [block("a1", 1_001)] }), { summary: "s" });
		expect("plan" in result).toBe(true);
	});
});
