// ACP compaction-block persistence + restart state rebuild (spec §9).
//
// acpSummary is a pure persistence-layer construct: an SDK custom entry written
// through the official appendCustomEntry channel. buildSessionContext ignores
// custom entries (they never enter the base LLM context or its message counts);
// the runtime view comes from the host projection (T1). The block's own id is
// the custom entry id minted at write time, so the persisted `data` carries no
// id of its own — rebuild re-attaches entry.id and the on-disk payload stays
// exactly the spec §9 field set.
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AcpCompactionBlock, AcpIndexLine } from "./acp-projection.ts";

/** customType identifying ACP compaction blocks in the session journal (spec §9). */
export const ACP_SUMMARY_CUSTOM_TYPE = "acpSummary";

/** Persisted acpSummary `data`: spec §9 full field set on the T1 projection shape (so a rebuilt block feeds render/projectContext as-is). */
export interface AcpSummaryData extends AcpCompactionBlock {
	shortSummary?: string;
	meta: {
		createdAt: number;
		depth: number;
		method: "normal" | "strong";
		forced?: boolean;
		keepIds: string[];
		/** Blocks folded into the compaction zone; strong blocks inherit the full set (spec §6). */
		compressedIds: string[];
		supersedes: string[];
		tokensBefore: number;
		tokensAfter: number;
	};
}

/** What the compress execution produces; `id` is minted by appendCustomEntry at write time. */
export type AcpSummaryDraft = Omit<AcpSummaryData, "id">;

/** Minimal write surface — satisfied by SessionManager (the official channel, spec §9). */
export interface AcpSummarySink {
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** Persist one compaction block; returns it with the journal id (its recall target). */
export function appendAcpSummary(session: AcpSummarySink, draft: AcpSummaryDraft): AcpSummaryData {
	const id = session.appendCustomEntry(ACP_SUMMARY_CUSTOM_TYPE, draft);
	return { ...draft, id };
}

/** Rebuilt ACP state for one session (spec §9). */
export interface AcpRebuiltState {
	/** A base compaction entry exists on the path: ACP permanently degraded, state must not advance (spec §5.3/§9.1). */
	degraded: boolean;
	/** Compaction zone: acpSummary blocks not superseded by any other, journal order (spec §9.2). */
	zone: AcpSummaryData[];
	/** Block ids inside any live zone block's compressedIds; every other block is active (spec §9.3). */
	compressedBlockIds: Set<string>;
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

/**
 * Rebuild ACP state by scanning journal entries (host session start, spec §9).
 * Strong blocks carry the full inherited compressedIds set, so no supersedes
 * chain is ever walked recursively (spec §9.3).
 */
export function rebuildAcpState(entries: readonly SessionEntry[]): AcpRebuiltState {
	if (entries.some((e) => e.type === "compaction")) {
		return { degraded: true, zone: [], compressedBlockIds: new Set() };
	}
	const summaries = listAcpSummaries(entries);
	const superseded = new Set(summaries.flatMap((s) => s.meta.supersedes));
	const zone = summaries.filter((s) => !superseded.has(s.id));
	const compressedBlockIds = new Set(zone.flatMap((s) => s.meta.compressedIds));
	return { degraded: false, zone, compressedBlockIds };
}
