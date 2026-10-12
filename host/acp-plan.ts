// ACP pure planning layer: the spec §11 parameter set, the §5.1 tier ladder,
// and the §5.2 two-dimensional decision table as one pure function (extracted
// from acp-runtime.ts so the runtime keeps only stateful machinery). Pure leaf
// module — no imports; every consumer (runtime, assembly, smokes) shares this
// single decision source.
//
// Since T6 the §5.2 table runs on both axes: the zone-size axis (rendered zone
// tokens vs window × 35%) drives the pending-strong state — strong execution
// semantics for the next compress once the active zone is past L1 (riding) or
// past L3 (always). T7 reuses the same table for the failure exits: the L3 tier
// anchors the ultimatum round and the guard line is judged against the window
// lines derived from the same contextWindow (in acp-runtime).

// ---- parameters (spec §11; defaults are the SSOT table values) -----------------

export interface AcpParams {
	/** Prompt tiers by active-zone tokens; boundaries are strict-greater (spec §5.1). */
	l1: number;
	l2: number;
	l3: number;
	/** Compressed active-zone ceiling: keep + protected <= target (spec §6.3). */
	target: number;
	/** A successful compression must fold at least this many tokens (spec §5.2). */
	minCompress: number;
	/** Hard cap of the summary budget term (spec §11 "8K"). */
	summaryBudgetMax: number;
	/** Divisor of the summary budget basis (spec §11 "÷ 3"). */
	summaryDivisor: number;
	/** Protected tail: at least this many recent turns stay uncompressed (0 = off). */
	tailTurns: number;
	/** Protected tail: at least this many recent tokens stay uncompressed (0 = off). */
	tailTokens: number;
}

export const ACP_DEFAULT_PARAMS: AcpParams = {
	l1: 100_000,
	l2: 200_000,
	l3: 300_000,
	target: 100_000,
	minCompress: 20_000,
	summaryBudgetMax: 8_000,
	summaryDivisor: 3,
	tailTurns: 2,
	tailTokens: 20_000,
};

/** Prompt tier for an active-zone size (spec §5.1 decision table, strict >). */
export function computeTier(activeTokens: number, p: AcpParams = ACP_DEFAULT_PARAMS): "none" | "L1" | "L2" | "L3" {
	if (activeTokens > p.l3) return "L3";
	if (activeTokens > p.l2) return "L2";
	if (activeTokens > p.l1) return "L1";
	return "none";
}

/** The §5.2 two-dimensional decision table as the single implementation. */
export interface AcpRoundPlan {
	tier: "none" | "L1" | "L2" | "L3";
	/** Compress method allowed this round: past L3, or pending-strong riding (§5.2). */
	method: "normal" | "strong";
	/** Zone over its line (window × ACP_ZONE_LIMIT_RATIO): the pending-strong state (§5.2 rows 5/6). */
	pendingStrong: boolean;
}

/**
 * State -> ephemeral tier + allowed compress method (spec §5.2 decision table).
 * Boundaries are strictly greater on both axes, so active == L3 lands in the
 * L2 tier with normal compression (acceptance 19), and a zone exactly at its
 * line is not pending. The optional `zone` axis enables the pending-strong
 * rows: over the line AND active > L1 the next compress rides strong; at or
 * under L1 it stays normal (no riding); past L3 the method is strong anyway.
 */
export function computeRoundPlan(
	activeTokens: number,
	p: AcpParams = ACP_DEFAULT_PARAMS,
	zone?: { tokens: number; limitTokens: number },
): AcpRoundPlan {
	const pendingStrong = zone !== undefined && zone.limitTokens > 0 && zone.tokens > zone.limitTokens;
	const strong = activeTokens > p.l3 || (pendingStrong && activeTokens > p.l1);
	return { tier: computeTier(activeTokens, p), method: strong ? "strong" : "normal", pendingStrong };
}

/** Zone budget line = window × this ratio (spec §11 zone-limit row). */
export const ACP_ZONE_LIMIT_RATIO = 0.35;

/** Rendered manifest section stays under this many tokens; overflow drops the tail (spec §11). */
export const ACP_MANIFEST_RENDER_BUDGET = 8_000;

/** Summary budget = min((compressed + merged old summaries) ÷ divisor, cap) (spec §6.5/§11). */
export function computeSummaryBudget(
	compressedTokens: number,
	mergedOldSummaryTokens: number,
	p: AcpParams = ACP_DEFAULT_PARAMS,
): number {
	return Math.min(Math.floor((compressedTokens + mergedOldSummaryTokens) / p.summaryDivisor), p.summaryBudgetMax);
}

/**
 * Read the `acp` section of omp-desktop.json into params. Unknown or invalid
 * entries fall back to the §11 defaults (same lenient contract as the other
 * acp.* readers in profile.ts).
 */
export function acpParamsFromConfig(section: unknown): AcpParams {
	const p = { ...ACP_DEFAULT_PARAMS };
	if (!section || typeof section !== "object") return p;
	const s = section as Record<string, unknown>;
	for (const key of ["l1", "l2", "l3", "target", "minCompress", "summaryBudgetMax", "summaryDivisor", "tailTurns", "tailTokens"] as const) {
		const v = s[key];
		if (typeof v === "number" && v >= 0) p[key] = v;
	}
	return p;
}
