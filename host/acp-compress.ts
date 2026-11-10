// compress_context validation + execution planning (spec §6, split out of
// acp-runtime.ts for the host file-size gate; pure refactor, T11).
//
// planCompression runs the full six-step §6 validation sequence and derives
// everything execution needs — keep decode/hallucination check, target math,
// summary budget basis (incl. the strong-reset old-summary merge), the
// compressed set, and the normal/strong method re-derivation from the same
// settled snapshot the round status uses (§5.2) with the level-3 armed-force
// override. It is pure: the runtime takes the snapshot inside the compress
// mutex, plans here, then applies the side effects (journal write, zone
// update, manifest consumption) in lock — the mutex and validation-order
// semantics are unchanged (spec §6).
import { type AcpBlockInfo, type AcpIndexLine } from "./acp-projection.ts";
import type { AcpSummaryData } from "./acp-persist.ts";
import { type AcpParams, computeRoundPlan, computeSummaryBudget, computeTier } from "./acp-plan.ts";

/** compress_context success payload (mirrored into the tool_result JSON, spec §6 execution). */
export interface CompressOutcome {
	ok: true;
	blockId: string;
	/** Execution method the plan re-derived (§5.2): a strong reset supersedes the whole zone. */
	method: "normal" | "strong";
	compressed: { blocks: number; tokens: number };
	kept: { blocks: number; tokens: number };
	/**
	 * Real change of the projected context (active zone + compaction zone, spec §4): negative
	 * = the request got smaller. A strong reset replaces the whole old zone, so its blocks and
	 * rendered tokens count here exactly like the freshly folded ones — `compressed` alone
	 * under-reports what a strong compression took out of the request.
	 */
	delta: { blocks: number; tokens: number };
	/** Old compression-zone blocks merged into the new summary: 0 for a normal append, the whole
	 * pre-compression zone for a strong reset. */
	zoneBlocksFolded: number;
	activeTokensAfter: number;
	/** New tier from the post-compression active zone (spec §5.1, immediate). */
	tier: "none" | "L1" | "L2" | "L3";
	/** False when the folded set stayed under minCompress (spec §5.2). */
	countedAsSuccess: boolean;
	warning?: string;
}

/** compress_context rejection; any rejection leaves zero side effects and does not consume the manifest. */
export interface CompressRejection {
	ok: false;
	code:
		| "degraded"
		| "below-min-compress"
		| "no-manifest"
		| "manifest-consumed"
		| "hallucinated-keep"
		| "over-target"
		| "empty-summary"
		| "summary-over-budget"
		| "nothing-to-compress";
	error: string;
	validCandidates?: string[];
}

/**
 * The settled snapshot compress validates against (spec §4): captured by
 * AcpRuntimeState inside the mutex, judged here. `resolve`/`label` come from
 * the session's AcpRefBook (synced before the snapshot is taken).
 */
export interface CompressSnapshot {
	degraded: boolean;
	manifest: { ids: readonly string[]; consumed: boolean } | null;
	active: readonly AcpBlockInfo[];
	protectedIds: ReadonlySet<string>;
	/** Runtime mirror of rebuildAcpState (spec §9). */
	compressed: ReadonlySet<string>;
	/** Live compaction zone (the strong-reset merge source). */
	zone: readonly AcpSummaryData[];
	/** Current base summary even after a prior strong removed its block from the zone. */
	baseSummary?: string;
	/** Rendered token total of the live zone (memoized by the runtime). */
	zoneTokens: number;
	/** Zone budget line (§11): window × 35%, 0 = no limit. */
	zoneLimitTokens: number;
	/** Armed level-3 force: the next compress executes forced-strong (§5.2). */
	forcedExecution: boolean;
	/**
	 * Learned provider/local scale over the active zone (§5.2 drift); the gate
	 * below must read the same total `status()` reports.
	 */
	ratio: number;
	params: AcpParams;
	countTokens: (text: string) => number;
	/** bN short-ref decode (spec §3 v10); unknown refs pass through for §6.2 to judge. */
	resolve: (ref: string) => string;
	/** bN short-ref render for candidate/keep ids in error messages. */
	label: (id: string) => string;
}

/** The execution plan: the journal payload plus every outcome field except blockId (assigned after the write). */
export interface CompressPlan {
	method: "normal" | "strong";
	forced: boolean;
	keep: string[];
	keepTokens: number;
	compressedIds: string[];
	compressedTokens: number;
	activeTokensBefore: number;
	activeTokensAfter: number;
	/** appendAcpSummary payload verbatim (summary + index + meta, spec §6/§9). */
	payload: {
		summary: string;
		index: AcpIndexLine[];
		meta: AcpSummaryData["meta"];
	};
	countedAsSuccess: boolean;
	warning?: string;
	tierAfter: "none" | "L1" | "L2" | "L3";
}

/** Six-check §6 validation + planning; a rejection leaves zero side effects. */
export function planCompression(
	snapshot: CompressSnapshot,
	input: { keep?: string[]; summary?: string },
): { reject: CompressRejection } | { plan: CompressPlan } {
	const p = snapshot.params;
	const countTokens = snapshot.countTokens;
	// §5.3 degrade — customTools cannot be unregistered after session
	// creation, so the tool surface stays and the entry rejects instead.
	if (snapshot.degraded) {
		return {
			reject: {
				ok: false,
				code: "degraded",
				error: "ACP is degraded for this session; the base compaction chain owns context management (spec §5.3).",
			},
		};
	}
	const activeBlocks = snapshot.active.reduce((n, b) => n + b.tokens, 0);
	const activeTokens = Math.round(activeBlocks * snapshot.ratio);
	if (activeTokens < p.minCompress) {
		return {
			reject: {
				ok: false,
				code: "below-min-compress",
				error: `Active zone is ${activeTokens} tokens, below minCompress ${p.minCompress}; compress_context is unavailable until more context accumulates.`,
			},
		};
	}
	// §6.1 — a consumed (or missing) manifest rejects before anything else,
	// pointing at the pull channel for a fresh round (spec §6 v10).
	if (!snapshot.manifest) {
		return { reject: { ok: false, code: "no-manifest", error: "No compression manifest for this round — call context_status to get one." } };
	}
	if (snapshot.manifest.consumed) {
		return {
			reject: {
				ok: false,
				code: "manifest-consumed",
				error: "This round's manifest is already consumed; call context_status for the next round's manifest.",
			},
		};
	}
	// Tool-entry decode inside the lock (spec §3 v10): keep speaks bN short
	// refs; unknown refs pass through and the §6.2 validation judges them.
	const keep = [...new Set((input.keep ?? []).map((ref) => snapshot.resolve(ref)))];
	const keepSet = new Set(keep);
	const active = snapshot.active;
	const byId = new Map(active.map((b) => [b.id, b]));
	const protectedIds = snapshot.protectedIds;
	const manifestSet = new Set(snapshot.manifest.ids);
	const candidates = snapshot.manifest.ids.filter((id) => byId.has(id) && !protectedIds.has(id));

	// §6.2 — hallucinated keep ids reject the whole call, with the full valid
	// candidate set (short refs, spec §3 v10).
	const bad = keep.filter((id) => !byId.has(id) || protectedIds.has(id));
	if (bad.length > 0) {
		const reasons = bad.map((id) => {
			if (protectedIds.has(id)) return `${snapshot.label(id)} (protected tail)`;
			if (snapshot.compressed.has(id)) return `${snapshot.label(id)} (already compressed)`;
			if (manifestSet.has(id) && !byId.has(id)) return `${snapshot.label(id)} (no longer active)`;
			return `${id} (nonexistent)`;
		});
		const valid = candidates.map((id) => snapshot.label(id));
		return {
			reject: {
				ok: false,
				code: "hallucinated-keep",
				error: `keep contains invalid block ids: ${reasons.join(", ")}. Valid candidates: ${valid.length ? valid.join(", ") : "(none)"}.`,
				validCandidates: valid,
			},
		};
	}

	// §6.3 — keep + protected tail must fit the target line.
	const keepTokens = keep.reduce((n, id) => n + (byId.get(id)?.tokens ?? 0), 0);
	const protectedTokens = active.reduce((n, b) => n + (protectedIds.has(b.id) ? b.tokens : 0), 0);
	if (keepTokens + protectedTokens > p.target) {
		const over = keepTokens + protectedTokens - p.target;
		return {
			reject: {
				ok: false,
				code: "over-target",
				error: `keep (${keepTokens} tokens) + protected tail (${protectedTokens} tokens) = ${keepTokens + protectedTokens} > target ${p.target}; reduce keep by ${over} more tokens.`,
			},
		};
	}

	// §6.4 — empty summary.
	const summary = input.summary ?? "";
	if (!summary.trim()) {
		return { reject: { ok: false, code: "empty-summary", error: "summary must not be empty." } };
	}

	// §6.5 — summary budget; basis = this round's compressed set plus, for a
	// strong reset, every old summary the zone merges in (§5.2/§11). The
	// method is re-derived here from the same settled snapshot the round
	// status uses (request-anchored judgment, §5.2): past L3, or riding a
	// zone over its line with active > L1 — a pure zone reset at or under L1
	// does not ride and stays normal. A level-3 armed force overrides to
	// strong unconditionally (§5.2: forced compression runs strong
	// semantics with meta.forced=true).
	const compressedIds = snapshot.manifest.ids.filter((id) => byId.has(id) && !keepSet.has(id));
	const compressedTokens = compressedIds.reduce((n, id) => n + (byId.get(id)?.tokens ?? 0), 0);
	const activeTokensBefore = activeTokens;
	const zoneTokens = snapshot.zoneTokens;
	const forced = snapshot.forcedExecution;
	const method: "normal" | "strong" = forced
		? "strong"
		: computeRoundPlan(activeTokensBefore, p, { tokens: zoneTokens, limitTokens: snapshot.zoneLimitTokens }).method;
	// A strong reset may swallow the synthesized base boundary: its summary body
	// is concatenated (content must not be lost), and the part it adds to the
	// request is charged to the budget unstretched — otherwise the boundary
	// alone could exceed summaryBudgetMax and permanently block L3 (spec R4).
	const baseBlocks = method === "strong" ? snapshot.zone.filter((z) => z.meta.method === "base") : [];
	const directBaseSummary = baseBlocks.length > 0 ? baseBlocks.map((z) => z.summary).join("\n\n") : undefined;
	const baseSummary =
		directBaseSummary ??
		(method === "strong" && snapshot.zone.some((z) => z.meta.supersedesBase !== undefined) ? snapshot.baseSummary : undefined);
	const baseRenderTokens = baseSummary === undefined ? 0 : countTokens(`[acp-base]\n${baseSummary}`);
	const mergedOldSummaryTokens = method === "strong" ? Math.max(0, zoneTokens - baseRenderTokens) : 0;
	const mergedSummary = baseSummary === undefined ? summary : `${baseSummary}\n\n${summary}`;
	const budget = baseRenderTokens + computeSummaryBudget(compressedTokens, mergedOldSummaryTokens, p);
	const summaryTokens = countTokens(mergedSummary);
	if (summaryTokens > budget) {
		return {
			reject: {
				ok: false,
				code: "summary-over-budget",
				error:
					compressedIds.length === 0 && method !== "strong"
						? `keep covers the entire manifest — nothing would be compressed, so the summary budget is 0 (${summaryTokens} > ${budget}); unkeep some candidate blocks.`
						: `summary is ${summaryTokens} tokens, over the budget ${budget} = ` +
							`${baseRenderTokens > 0 ? `${baseRenderTokens} (base render) + ` : ""}` +
							`min((compressed ${compressedTokens} + merged old summaries ${mergedOldSummaryTokens}) / ${p.summaryDivisor}, ${p.summaryBudgetMax}); shorten it.`,
			},
		};
	}

	// §6.6 — an empty compressed set rejects, EXCEPT a strong pure reset:
	// folding only the old zone summaries is a legal submission whose budget
	// basis is those summaries (§5.2/§6 exception; acceptance 14).
	if (compressedIds.length === 0 && method !== "strong") {
		return {
			reject: {
				ok: false,
				code: "nothing-to-compress",
				error: "Nothing to compress: the manifest minus keep intersects no active block.",
			},
		};
	}

	// Execution plan (§6): normal appends to the zone end; strong supersedes
	// the whole live zone and inherits its full compressedIds/index union, so
	// the zone renders as a single block and rebuild never walks supersedes
	// chains (§9). depth counts strong generations (normal blocks sit at 0).
	const activeTokensAfter = Math.max(0, Math.round((activeBlocks - compressedTokens) * snapshot.ratio));
	// supersedes stays an acpSummary-only list: the base boundary is not an
	// acpSummary and is identified by its own stable field (spec R4).
	const supersedes = method === "strong" ? snapshot.zone.filter((z) => z.meta.method !== "base").map((z) => z.id) : [];
	// Direct swallow sets the boundary's entry id; a later strong inherits it
	// from the summary it replaces (the field travels down the whole chain).
	const supersedesBase =
		method === "strong"
			? (baseBlocks[0]?.id ?? snapshot.zone.find((z) => z.meta.supersedesBase !== undefined)?.meta.supersedesBase)
			: undefined;
	const inheritedIds = new Set<string>();
	const index: AcpIndexLine[] = [];
	if (method === "strong") {
		for (const z of snapshot.zone) {
			for (const line of z.index) {
				if (!inheritedIds.has(line.id)) {
					inheritedIds.add(line.id);
					index.push(line);
				}
			}
			for (const id of z.meta.compressedIds) inheritedIds.add(id);
		}
	}
	for (const id of compressedIds) {
		const b = byId.get(id)!;
		index.push({ id, tokens: b.tokens, intent: b.intent });
	}
	const payload = {
		summary: mergedSummary,
		index,
		meta: {
			createdAt: Date.now(),
			depth: method === "strong" ? snapshot.zone.reduce((m, z) => Math.max(m, z.meta.depth), 0) + 1 : 0,
			method,
			...(forced ? { forced: true } : {}),
			keepIds: keep,
			compressedIds: [...inheritedIds, ...compressedIds],
			supersedes,
			...(supersedesBase ? { supersedesBase } : {}),
			tokensBefore: activeTokensBefore,
			tokensAfter: activeTokensAfter,
		} as AcpSummaryData["meta"],
	};
	// The active-zone floor gates entry above; once admitted, minCompress only
	// judges the folded set — L2 adds a warning, while L3 and forced turns do
	// not count an undersized fold as success. A pure reset folds 0 and never counts.
	const tierBefore = computeTier(activeTokensBefore, p);
	const countedAsSuccess = compressedTokens >= p.minCompress;
	const warning =
		tierBefore === "L2" && !countedAsSuccess
			? `compressed ${compressedTokens} tokens is under minCompress ${p.minCompress}; allowed with warning at ${tierBefore} tier.`
			: undefined;
	return {
		plan: {
			method,
			forced,
			keep,
			keepTokens,
			compressedIds,
			compressedTokens,
			activeTokensBefore,
			activeTokensAfter,
			payload,
			countedAsSuccess,
			...(warning ? { warning } : {}),
			tierAfter: computeTier(activeTokensAfter, p),
		},
	};
}
