// ACP compaction-block persistence + restart state rebuild (spec §9).
//
// acpSummary is a pure persistence-layer construct: an SDK custom entry written
// through the official appendCustomEntry channel. buildSessionContext ignores
// custom entries (they never enter the base LLM context or its message counts);
// the runtime view comes from the host projection (T1). The block's own id is
// the custom entry id minted at write time, so the persisted `data` carries no
// id of its own — rebuild re-attaches entry.id and the on-disk payload stays
// exactly the spec §9 field set.
import { getAnthropicCompactionPayload, OPENAI_REMOTE_COMPACTION_PRESERVE_KEY } from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionEntry, CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { type AcpCompactionBlock, type AcpIndexLine, splitBlocks } from "./acp-projection.ts";

/** customType identifying ACP compaction blocks in the session journal (spec §9). */
export const ACP_SUMMARY_CUSTOM_TYPE = "acpSummary";

/** Persisted acpSummary `data`: spec §9 full field set on the T1 projection shape (so a rebuilt block feeds render/projectContext as-is). */
export interface AcpSummaryData extends AcpCompactionBlock {
	shortSummary?: string;
	meta: {
		createdAt: number;
		depth: number;
		/** "base" only on synthesized baseline blocks; persisted acpSummary entries stay normal/strong. */
		method: "normal" | "strong" | "base";
		forced?: boolean;
		keepIds: string[];
		/** Blocks folded into the compaction zone; strong blocks inherit the full set (spec §6). */
		compressedIds: string[];
		supersedes: string[];
		/**
		 * Stable identity of the base boundary this summary swallowed (spec R4):
		 * the compaction entry id, inherited verbatim down the strong chain.
		 * Separate from historyRewriteAt, which tracks the newest surviving rewrite.
		 */
		supersedesBase?: string;
		tokensBefore: number;
		tokensAfter: number;
		/**
		 * Stats-page telemetry (missing in journals written before it existed;
		 * the usage dashboard renders those cells as unknown). Recorded here
		 * rather than recomputed at read time so the values are the runtime's own.
		 */
		/** Rendered size of this block as it enters the projection (spec §8 count of renderCompactionBlock). */
		summaryTokens?: number;
		/** Tokens the context_status return that fed this compression cost. */
		statusTokens?: number;
		/** [compress-hint] ephemeral injections since the previous successful compress or session start. */
		hints?: number;
	};
}

/** What the compress execution produces; `id` is minted by appendCustomEntry at write time. */
export type AcpSummaryDraft = Omit<AcpSummaryData, "id">;

/** Minimal write surface — satisfied by SessionManager (the official channel, spec §9). */
export interface AcpSummarySink {
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** Persist one compaction block; returns it with the journal id (its short-ref target). */
export function appendAcpSummary(session: AcpSummarySink, draft: AcpSummaryDraft): AcpSummaryData {
	const id = session.appendCustomEntry(ACP_SUMMARY_CUSTOM_TYPE, draft);
	return { ...draft, id };
}

/** Rebuilt ACP state for one session (spec R1/R2). */
export interface AcpRebuiltState {
	/** Projection off: a native-replay boundary or an unlocatable boundary leaves no safe base model (spec R5). */
	degraded: boolean;
	/** Compaction zone: base block first (when present), then live acpSummary blocks in journal order (spec R1). */
	zone: AcpSummaryData[];
	/** Block ids inside any live zone block's compressedIds; every other block is active (spec §9.3). */
	compressedBlockIds: Set<string>;
	/** Latest reset_boundary id on the branch; the zone era starts after it. */
	resetId: string | null;
	/** Latest compaction entry id after that reset; the zone root sits there. */
	compactionId: string | null;
	/** Where view alignment starts: the compaction boundary, else the reset id, else undefined (spec R2). */
	alignFrom?: string;
	/** Degrade cause, for the runtime's log line. */
	degradedReason?: string;
	/** Raw summary of the current compaction, retained for indirect strong merges after the base block leaves the zone. */
	baseSummary?: string;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// The journal is a trust boundary (session files are user-editable), so a
// malformed acpSummary fails loudly instead of silently misderiving the LLM
// context projection built on top of it.
function parseSummary(entry: CustomEntry): AcpSummaryData {
	const data = entry.data as Record<string, unknown> | undefined;
	const meta = data?.meta as Record<string, unknown> | undefined;
	const bad = `malformed acpSummary entry ${entry.id}: data does not match spec §9`;
	if (
		typeof data?.summary !== "string" ||
		!Array.isArray(data?.index) ||
		typeof meta?.createdAt !== "number" ||
		typeof meta?.depth !== "number" ||
		(meta?.method !== "normal" && meta?.method !== "strong") ||
		!isStrArr(meta?.keepIds) ||
		!isStrArr(meta?.compressedIds) ||
		!isStrArr(meta?.supersedes) ||
		(meta?.supersedesBase !== undefined && typeof meta.supersedesBase !== "string") ||
		typeof meta?.tokensBefore !== "number" ||
		typeof meta?.tokensAfter !== "number"
	) {
		throw new Error(bad);
	}
	const index: AcpIndexLine[] = (data.index as unknown[]).map((l) => {
		const line = l as Record<string, unknown>;
		if (typeof line?.id !== "string" || typeof line?.tokens !== "number" || typeof line?.intent !== "string") throw new Error(bad);
		return { id: line.id, tokens: line.tokens, intent: line.intent };
	});
	return {
		id: entry.id,
		summary: data.summary,
		shortSummary: typeof data.shortSummary === "string" ? data.shortSummary : undefined,
		index,
		meta: {
			createdAt: meta.createdAt,
			depth: meta.depth,
			method: meta.method,
			forced: meta.forced === true || undefined,
			keepIds: meta.keepIds,
			compressedIds: meta.compressedIds,
			supersedes: meta.supersedes,
			...(typeof meta.supersedesBase === "string" ? { supersedesBase: meta.supersedesBase } : {}),
			tokensBefore: meta.tokensBefore,
			tokensAfter: meta.tokensAfter,
		},
	};
}

/** Every acpSummary in the journal, file order — the full recall id space (live + superseded). */
export function listAcpSummaries(entries: readonly SessionEntry[]): AcpSummaryData[] {
	const summaries: AcpSummaryData[] = [];
	for (const e of entries) {
		if (e.type === "custom" && e.customType === ACP_SUMMARY_CUSTOM_TYPE) summaries.push(parseSummary(e));
	}
	return summaries;
}

/** Baseline synthesis outcome for one branch (spec R1). */
export type BaselineBlockResult =
	| { kind: "none" }
	| { kind: "native" }
	| { kind: "unlocatable" }
	| { kind: "block"; block: AcpSummaryData; boundaryEntryId: string };

/** The branch's current compaction geometry, independent of whether a summary swallowed it. */
interface BranchBoundary {
	resetId: string | null;
	compactionId: string | null;
	compactionIdx: number;
	boundaryEntryId: string | null;
	/** Provider replay folds the boundary entry itself; firstKeptEntryId keeps it. */
	includeBoundary: boolean;
	native: boolean;
}

/**
 * Latest reset and the compaction after it, plus the boundary entry id.
 * Only the passed branch is scanned: getEntries() includes abandoned siblings,
 * whose boundaries would otherwise masquerade as the current base (spec R6).
 */
function branchBoundary(branch: readonly SessionEntry[]): BranchBoundary {
	let resetId: string | null = null;
	let compactionIdx = -1;
	for (let i = 0; i < branch.length; i++) {
		const e = branch[i];
		if (e.type === "reset_boundary") {
			resetId = e.id;
			compactionIdx = -1;
		} else if (e.type === "compaction") compactionIdx = i;
	}
	if (compactionIdx < 0)
		return { resetId, compactionId: null, compactionIdx: -1, boundaryEntryId: null, includeBoundary: false, native: false };
	const entry = branch[compactionIdx] as CompactionEntry;
	const includeBoundary = entry.firstKeptEntryId === "";
	const wanted = includeBoundary ? entry.providerReplayThroughEntryId : entry.firstKeptEntryId;
	const boundaryIdx = wanted ? branch.findIndex((e, i) => i < compactionIdx && e.id === wanted) : -1;
	return {
		resetId,
		compactionId: entry.id,
		compactionIdx,
		boundaryEntryId: boundaryIdx >= 0 ? wanted! : null,
		includeBoundary,
		native: isNativeCompaction(entry),
	};
}

/**
 * Native replay forms whose content lives in preserveData, not in the entry's
 * summary/blocks: re-rendering them would lose history, so the base boundary
 * cannot be modeled (spec R5).
 */
function isNativeCompaction(entry: CompactionEntry): boolean {
	const preserve = entry.preserveData;
	if (getAnthropicCompactionPayload(preserve)) return true;
	if (preserve && OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserve) return true;
	// Preserve key of the snapcompact archive; the host has no weaker dependency to read it from.
	return entry.method === "snapcompact" && preserve?.["snapcompact"] !== undefined;
}

function buildBaseBlock(branch: readonly SessionEntry[], boundary: BranchBoundary): AcpSummaryData {
	const entry = branch[boundary.compactionIdx] as CompactionEntry;
	const cut = branch.findIndex((e) => e.id === boundary.boundaryEntryId);
	const end = cut + (boundary.includeBoundary ? 1 : 0);
	const compressedIds: string[] = [];
	for (const e of branch.slice(0, end)) {
		if (e.type !== "message") continue;
		for (const b of splitBlocks([{ id: e.id, message: e.message }], () => 0, undefined, () => 0)) compressedIds.push(b.id);
	}
	return {
		id: entry.id,
		summary: entry.summary,
		// The header shows only [acp-base]; the index is deliberately empty.
		index: [],
		meta: {
			// Journal timestamps are ISO strings; every ACP-side time is milliseconds.
			createdAt: Date.parse(entry.timestamp),
			depth: 0,
			method: "base",
			keepIds: [],
			compressedIds,
			supersedes: [],
			tokensBefore: entry.tokensBefore,
			tokensAfter: entry.tokensAfter ?? 0,
		},
	};
}

/**
 * The current base boundary as a zone root block (spec R1). Pure derivation:
 * no journal entry is written; a restart recomputes the same block.
 */
export function baselineBlock(branch: readonly SessionEntry[]): BaselineBlockResult {
	const boundary = branchBoundary(branch);
	if (boundary.compactionIdx < 0) return { kind: "none" };
	if (boundary.native) return { kind: "native" };
	if (!boundary.boundaryEntryId) return { kind: "unlocatable" };
	// A surviving strong summary already carries the base content in its body;
	// rendering the base again would duplicate the folded history (spec R4).
	const summaries = listAcpSummaries(branch);
	const superseded = new Set(summaries.flatMap((s) => s.meta.supersedes));
	if (summaries.some((s) => !superseded.has(s.id) && s.meta.supersedesBase === boundary.compactionId))
		return { kind: "none" };
	return { kind: "block", block: buildBaseBlock(branch, boundary), boundaryEntryId: boundary.boundaryEntryId };
}

/** Latest reset/compaction ids of the current branch (spec R6 fingerprint comparison). */
export function branchCompactionFingerprint(entries: readonly SessionEntry[]): {
	resetId: string | null;
	compactionId: string | null;
} {
	const boundary = branchBoundary(entries);
	return { resetId: boundary.resetId, compactionId: boundary.compactionId };
}

/**
 * Rebuild ACP state from the current branch (spec R1/R2/R5): zone era starts
 * after the latest reset, the base boundary (when modeled) is its first block,
 * and compressedBlockIds come only from the final live zone — never from
 * summaries that left the zone or predate the reset. Degraded is likewise a
 * per-branch derivation, so a reset/rewind off a native boundary recovers.
 */
export function rebuildAcpState(branch: readonly SessionEntry[]): AcpRebuiltState {
	const boundary = branchBoundary(branch);
	const eraStart = boundary.resetId ? branch.findIndex((e) => e.id === boundary.resetId) : -1;
	const summaries = listAcpSummaries(branch.slice(eraStart + 1));
	const superseded = new Set(summaries.flatMap((s) => s.meta.supersedes));
	const live = summaries.filter((s) => !superseded.has(s.id));
	const alignFrom = boundary.boundaryEntryId ?? boundary.resetId ?? undefined;

	let degradedReason: string | undefined;
	let base: AcpSummaryData | null = null;
	if (boundary.compactionIdx >= 0) {
		if (boundary.native) degradedReason = "base compaction carries provider-native replay history";
		else if (!boundary.boundaryEntryId) degradedReason = "base compaction boundary entry is not on the branch";
		else if (!live.some((s) => s.meta.supersedesBase === boundary.compactionId)) base = buildBaseBlock(branch, boundary);
	}
	if (degradedReason) {
		return {
			degraded: true,
			zone: [],
			compressedBlockIds: new Set(),
			resetId: boundary.resetId,
			compactionId: boundary.compactionId,
			alignFrom,
			degradedReason,
		};
	}
	// Summaries written before the base compaction are folded into it; only
	// those after the boundary stay in the (live) zone.
	const afterCompaction =
		boundary.compactionIdx >= 0 ? new Set(branch.slice(boundary.compactionIdx + 1).map((e) => e.id)) : undefined;
	const zoneSummaries = afterCompaction ? live.filter((s) => afterCompaction.has(s.id)) : live;
	const zone = base ? [base, ...zoneSummaries] : zoneSummaries;
	return {
		degraded: false,
		zone,
		compressedBlockIds: new Set(zone.flatMap((s) => s.meta.compressedIds)),
		resetId: boundary.resetId,
		compactionId: boundary.compactionId,
		alignFrom,
		baseSummary: boundary.compactionIdx >= 0 ? (branch[boundary.compactionIdx] as CompactionEntry).summary : undefined,
	};
}
