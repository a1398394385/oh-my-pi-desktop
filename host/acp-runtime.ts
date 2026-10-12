// ACP dual-zone runtime: per-session state machine + compress_context tool +
// request projection wiring (spec §5/§6, ticket T3).
//
// One AcpRuntimeState per session owns everything the tool and the projection
// need to agree on: the compaction zone (journal order), the compressed-id set
// (runtime mirror of rebuildAcpState), the current-round manifest, and the
// per-session compress mutex. The manifest is supplied by the assembly or
// tests in T3 (model-visible ephemeral generation is T4).
//
// Block-id alignment: the SDK context event hands over deep-copied view
// messages with no entry ids, while the manifest talks in entry-id block ids
// (spec §3). Ids are re-attached per request by fingerprint-matching the view
// against the journal (messageFingerprint, the mechanism proven by the
// prototype adapter); unmatched view messages (base-synthetic reminders) get
// pseudo ids that can never enter a manifest and pass through untouched.
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { messageFingerprint } from "./acp-state.ts";
import { projectContext, splitBlocks, type AcpBlockInfo, type AcpSourceMessage } from "./acp-projection.ts";
import { appendAcpSummary, type AcpSummaryData, type AcpSummarySink } from "./acp-persist.ts";
import { safeStderr } from "./stderr.ts";

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

// ---- view -> block-id annotation -----------------------------------------------

/** Pseudo-id prefix for view messages absent from the journal (never a legal manifest id). */
const ACP_VIEW_PSEUDO_PREFIX = "view:";

/** Fingerprint window for aligning a view message against the journal. */
const ACP_ALIGN_WINDOW = 64;

function annotateView(view: readonly AgentMessage[], entries: readonly SessionEntry[]): AcpSourceMessage[] {
	const journal = entries.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message");
	const fps = journal.map((e) => messageFingerprint(e.message));
	let ptr = 0;
	const ids = view.map((m) => {
		const fp = messageFingerprint(m);
		// In-order greedy match: view messages derive from journal entries in
		// order, with base-synthetic messages interleaved (they consume no
		// journal slot). The window only guards pathological drift.
		for (let k = ptr; k < fps.length && k - ptr < ACP_ALIGN_WINDOW; k++) {
			if (fps[k] === fp) {
				ptr = k + 1;
				return journal[k].id;
			}
		}
		return null;
	});
	return view.map((m, j) => ({ id: ids[j] ?? `${ACP_VIEW_PSEUDO_PREFIX}${j}`, message: m }));
}

// ---- runtime state --------------------------------------------------------------

export interface AcpRuntimeDeps {
	/** Token counter bound to the session model's Tokenizer (spec §8; byte-estimate fallback is built in). */
	countTokens: (text: string) => number;
	/** Journal write channel for compaction blocks (SessionManager, spec §9). */
	sink: AcpSummarySink;
	/** Journal read for entry-id alignment (SessionManager.getEntries). */
	getEntries: () => readonly SessionEntry[];
	/** Parameter overrides over the §11 defaults. */
	params?: Partial<AcpParams>;
}

/** The current-round compression manifest (injected by the assembly/tests; T4 wires model-visible generation). */
export interface AcpManifest {
	ids: string[];
	consumed: boolean;
}

/** compress_context success payload (mirrored into the tool_result JSON, spec §6 execution). */
export interface CompressOutcome {
	ok: true;
	blockId: string;
	compressed: { blocks: number; tokens: number };
	kept: { blocks: number; tokens: number };
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

export class AcpRuntimeState {
	readonly params: AcpParams;
	readonly compressed = new Set<string>();
	zone: AcpSummaryData[] = [];
	manifest: AcpManifest | null = null;
	/** Latest request view annotated with block ids (captured by projectView). */
	lastSource: AcpSourceMessage[] = [];
	lastBlocks: AcpBlockInfo[] = [];
	/** Latest projected request (test/assembly observability). */
	lastProjected: AgentMessage[] = [];
	#deps: AcpRuntimeDeps;
	/** Per-session compress mutex: a promise chain (the exclusive tool channel is unavailable, spec §6). */
	#lock: Promise<unknown> = Promise.resolve();

	constructor(deps: AcpRuntimeDeps) {
		this.#deps = deps;
		this.params = { ...ACP_DEFAULT_PARAMS, ...deps.params };
	}

	/** Serialize executions; validation failures inside the lock do not break the chain. */
	runLocked<T>(fn: () => T | Promise<T>): Promise<T> {
		const run = this.#lock.then(fn, fn);
		this.#lock = run.catch(() => {});
		return run;
	}

	setManifest(ids: string[]): void {
		this.manifest = { ids, consumed: false };
	}

	/** Active-zone blocks of the latest captured view (compressed blocks excluded). */
	activeBlocks(): AcpBlockInfo[] {
		return this.lastBlocks.filter((b) => !this.compressed.has(b.id));
	}

	/** Protected tail: max(last tailTurns turns, tailTokens) of the active zone (spec §11). */
	protectedZone(active: readonly AcpBlockInfo[] = this.activeBlocks()): Set<string> {
		const p = this.params;
		const ids = new Set<string>();
		if (p.tailTurns <= 0 && p.tailTokens <= 0) return ids;
		let tokens = 0;
		let turns = 0;
		for (let i = active.length - 1; i >= 0; i--) {
			const b = active[i];
			ids.add(b.id);
			tokens += b.tokens;
			if (b.kind === "user") turns++;
			if (turns >= p.tailTurns && tokens >= p.tailTokens) break;
		}
		return ids;
	}

	/**
	 * Project a request view (spec §4): compression zone first, then the active
	 * zone filtered to non-compressed blocks. Also refreshes the snapshot the
	 * compress validation runs against (same coordinate system as the manifest).
	 */
	projectView(view: readonly AgentMessage[]): AgentMessage[] {
		const source = annotateView(view, this.#deps.getEntries());
		this.lastSource = source;
		this.lastBlocks = splitBlocks(source, this.#deps.countTokens);
		const kept = new Set(this.lastBlocks.filter((b) => !this.compressed.has(b.id)).map((b) => b.id));
		const out = projectContext(source, kept, this.zone, this.#deps.countTokens);
		this.lastProjected = out;
		return out;
	}

	/** compress_context entry: mutex + full §6 validation sequence + execution. */
	compress(input: { keep?: string[]; summary?: string }): Promise<CompressOutcome | CompressRejection> {
		return this.runLocked(() => this.#validateAndExecute(input));
	}

	#validateAndExecute(input: { keep?: string[]; summary?: string }): CompressOutcome | CompressRejection {
		const p = this.params;
		const countTokens = this.#deps.countTokens;
		// §6.1 — a consumed (or missing) manifest rejects before anything else.
		if (!this.manifest) {
			return { ok: false, code: "no-manifest", error: "No compression manifest for this round." };
		}
		if (this.manifest.consumed) {
			return { ok: false, code: "manifest-consumed", error: "This round's manifest is already consumed; wait for the next round's manifest." };
		}
		const keep = [...new Set(input.keep ?? [])];
		const keepSet = new Set(keep);
		const active = this.activeBlocks();
		const byId = new Map(active.map((b) => [b.id, b]));
		const protectedIds = this.protectedZone(active);
		const manifestSet = new Set(this.manifest.ids);
		const candidates = this.manifest.ids.filter((id) => byId.has(id) && !protectedIds.has(id));

		// §6.2 — hallucinated keep ids reject the whole call, with the full valid candidate set.
		const bad = keep.filter((id) => !byId.has(id) || protectedIds.has(id));
		if (bad.length > 0) {
			const reasons = bad.map((id) => {
				if (protectedIds.has(id)) return `${id} (protected tail)`;
				if (this.compressed.has(id)) return `${id} (already compressed)`;
				if (manifestSet.has(id) && !byId.has(id)) return `${id} (no longer active)`;
				return `${id} (nonexistent)`;
			});
			return {
				ok: false,
				code: "hallucinated-keep",
				error: `keep contains invalid block ids: ${reasons.join(", ")}. Valid candidates: ${candidates.length ? candidates.join(", ") : "(none)"}.`,
				validCandidates: candidates,
			};
		}

		// §6.3 — keep + protected tail must fit the target line.
		const keepTokens = keep.reduce((n, id) => n + (byId.get(id)?.tokens ?? 0), 0);
		const protectedTokens = active.reduce((n, b) => n + (protectedIds.has(b.id) ? b.tokens : 0), 0);
		if (keepTokens + protectedTokens > p.target) {
			const over = keepTokens + protectedTokens - p.target;
			return {
				ok: false,
				code: "over-target",
				error: `keep (${keepTokens} tokens) + protected tail (${protectedTokens} tokens) = ${keepTokens + protectedTokens} > target ${p.target}; reduce keep by ${over} more tokens.`,
			};
		}

		// §6.4 — empty summary.
		const summary = input.summary ?? "";
		if (!summary.trim()) {
			return { ok: false, code: "empty-summary", error: "summary must not be empty." };
		}

		// §6.5 — summary budget; basis = this round's compressed set (+ summaries
		// merged by a strong reset, which T6 wires in; normal compression merges none).
		const compressedIds = this.manifest.ids.filter((id) => byId.has(id) && !keepSet.has(id));
		const compressedTokens = compressedIds.reduce((n, id) => n + (byId.get(id)?.tokens ?? 0), 0);
		const mergedOldSummaryTokens = 0;
		const budget = computeSummaryBudget(compressedTokens, mergedOldSummaryTokens, p);
		const summaryTokens = countTokens(summary);
		if (summaryTokens > budget) {
			return {
				ok: false,
				code: "summary-over-budget",
				error:
					compressedIds.length === 0
						? `keep covers the entire manifest — nothing would be compressed, so the summary budget is 0 (${summaryTokens} > ${budget}); unkeep some candidate blocks.`
						: `summary is ${summaryTokens} tokens, over the budget ${budget} = min((compressed ${compressedTokens} + merged old summaries ${mergedOldSummaryTokens}) / ${p.summaryDivisor}, ${p.summaryBudgetMax}); shorten it.`,
			};
		}

		// §6.6 — an empty compressed set rejects. Exception (strong pure reset,
		// where the basis is the merged old summaries) is T6 and not enabled here.
		if (compressedIds.length === 0) {
			return { ok: false, code: "nothing-to-compress", error: "Nothing to compress: the manifest minus keep intersects no active block." };
		}

		// Execution (normal compression: append to the zone end, no supersede).
		const activeTokensBefore = active.reduce((n, b) => n + b.tokens, 0);
		const activeTokensAfter = activeTokensBefore - compressedTokens;
		const written = appendAcpSummary(this.#deps.sink, {
			summary,
			index: compressedIds.map((id) => {
				const b = byId.get(id)!;
				return { id, tokens: b.tokens, intent: b.intent };
			}),
			meta: {
				createdAt: Date.now(),
				depth: 0,
				method: "normal",
				keepIds: keep,
				compressedIds,
				supersedes: [],
				tokensBefore: activeTokensBefore,
				tokensAfter: activeTokensAfter,
			},
		});
		this.zone.push(written);
		for (const id of compressedIds) this.compressed.add(id);
		this.manifest.consumed = true;

		// minCompress never gates validation (spec §5.2): below it the call still
		// succeeds — L2 adds a warning, L3 does not count as a successful
		// compression (the three-strike counter is a later ticket).
		const tierBefore = computeTier(activeTokensBefore, p);
		const countedAsSuccess = compressedTokens >= p.minCompress;
		const warning =
			tierBefore === "L2" && !countedAsSuccess
				? `compressed ${compressedTokens} tokens is under minCompress ${p.minCompress}; allowed with warning at ${tierBefore} tier.`
				: undefined;
		return {
			ok: true,
			blockId: written.id,
			compressed: { blocks: compressedIds.length, tokens: compressedTokens },
			kept: { blocks: keep.length, tokens: keepTokens },
			activeTokensAfter,
			tier: computeTier(activeTokensAfter, p),
			countedAsSuccess,
			...(warning ? { warning } : {}),
		};
	}
}

/** Build a runtime bound to the session model's Tokenizer (spec §8). */
export function createAcpRuntime(opts: {
	model: unknown;
	sink: AcpSummarySink;
	getEntries: () => readonly SessionEntry[];
	params?: Partial<AcpParams>;
}): AcpRuntimeState {
	const tokenizer = new Tokenizer(opts.model as never);
	return new AcpRuntimeState({
		countTokens: (s) => tokenizer.countTokens(s),
		sink: opts.sink,
		getEntries: opts.getEntries,
		params: opts.params,
	});
}

// ---- tool + extension -----------------------------------------------------------

const COMPRESS_CONTEXT_DESCRIPTION = `Compress old conversation blocks into a summary (context management).

The current round's manifest lists the block ids eligible for compression. Call with:
- keep: block ids from the manifest that must stay in the context verbatim (recent/important ones).
- summary: a complete technical summary of every block NOT kept (conclusions, file paths, decisions, exact values).

Compressed blocks leave the context and are represented by a persistent summary with a per-block index; recall_block can fetch any of them back later. The protected tail and blocks outside the manifest are never compressed — do not list them in keep.`;

/** compress_context ToolDefinition (registered via createAgentSession({ customTools })). */
export function createCompressContextTool(state: AcpRuntimeState) {
	return {
		name: "compress_context",
		label: "Compress Context",
		description: COMPRESS_CONTEXT_DESCRIPTION,
		parameters: type({
			keep: type.array(type("string")).describe("Block ids from the current manifest to keep verbatim."),
			summary: type("string").describe("Summary covering every compressed block (not the kept ones)."),
		}),
		loadMode: "essential" as const,
		approval: "write" as const,
		execute: async (_id: string, params: { keep?: string[]; summary?: string }) => {
			const out = await state.compress({ keep: params?.keep, summary: params?.summary });
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		},
	};
}

/**
 * Request projection extension: hooks the context event and replaces the view
 * with the dual-zone projection. A projection failure must never blow up the
 * request — the original view passes through (same stance as the prototype
 * transform in acp-context.ts).
 */
export function createAcpProjectionExtension(state: AcpRuntimeState) {
	return (pi: {
		on: (
			event: "context",
			handler: (ev: { messages: AgentMessage[] }) => { messages: AgentMessage[] },
		) => void;
	}): void => {
		pi.on("context", (ev) => {
			try {
				return { messages: state.projectView(ev.messages) };
			} catch (err) {
				safeStderr(`[ACP] projection failed, passing the original view through:`, err);
				return { messages: ev.messages };
			}
		});
	};
}
