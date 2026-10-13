// ACP dual-zone runtime: per-session state machine + compress_context tool +
// request projection wiring with ephemeral status (spec §5/§6/§7, tickets T3+T4+T6+T7).
//
// Since T6 the §5.2 table runs on both axes: the zone-size axis (rendered zone
// tokens vs window × 35%) drives the pending-strong state — the ephemeral
// annotation on every tier, and strong execution semantics for the next
// compress once the active zone is past L1 (riding) or past L3 (always).
//
// T7 adds the failure-exit set (spec §5.2/§5.3): ultimatum round counting
// (anchored per request, judged at the request's turn_end), the level-3 forced
// compression (armed for the next request via AgentSession.setForcedToolChoice
// — named where the face supports it; the openai-completions transport turns
// that same push into required+single-tool where it does not, so both spec
// forms ride one channel; a throw = neither form = degrade), the total-volume
// guard line (projected total vs window − effectiveReserveTokens), and the
// permanent degrade (projection off, ephemeral stopped, compress rejected at
// the entry — customTools cannot be unregistered after session creation — and
// the base compaction chain restored through the assembly hook).
//
// v10 (pull mode + short refs): the manifest leaves the ephemeral for the
// acp_status tool — the no-tier range injects nothing at all and active tiers
// inject a one-line status row pointing at the tool (§7). Every model-facing
// id surface renders bN short refs from the journal-replayed AcpRefBook
// (host/acp-refs.ts; the persisted layer keeps entry ids, spec §3), the tool
// entries decode bN back to entry ids, and acp_status tool pairs are neither
// compressible nor rendered once a later successful compress retires them
// (spec §6). The dashboard render lives in host/acp-status-tool.ts.
//
// v10.1: ultimatum-carrying requests (L3 tier / armed force / guard-line
// trigger) also ride a synthetic acp_status pair at the active-zone end,
// before the ephemeral line (spec §5.2/§6 v10.1; renderer in acp-status-tool.ts).
//
// One AcpRuntimeState per session owns everything the tool and the projection
// need to agree on: the compaction zone (journal order), the compressed-id set
// (runtime mirror of rebuildAcpState), the current-round manifest, and the
// per-session compress mutex. The round status (tier + candidate manifest) is
// re-derived from the fresh post-prune view on every request AND on every
// acp_status call (each return voids the previous round's manifest; spec §6
// v10). Tests may still pin a manifest directly via setManifest
// (auto-generation suspended while an override is pinned).
//
// Block-id alignment: the SDK context event hands over deep-copied view
// messages with no entry ids, while the manifest talks in entry-id block ids
// (spec §3). Ids are re-attached per request by fingerprint-matching the view
// against the journal (annotateView in acp-refs.ts); unmatched view messages
// (base-synthetic reminders) get pseudo ids that can never enter a manifest
// and pass through untouched.
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Tokenizer, effectiveReserveTokens } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	assertToolPairing,
	projectContext,
	renderCompactionBlock,
	splitBlocks,
	type AcpBlockInfo,
	type AcpIndexLine,
	type AcpSourceMessage,
} from "./acp-projection.ts";
import { appendAcpSummary, type AcpSummaryData, type AcpSummarySink } from "./acp-persist.ts";
import { dispatchRecall, type RecallOutcome } from "./acp-recall-tool.ts";
import { ACP_VIEW_PSEUDO_PREFIX, AcpRefBook, annotateView } from "./acp-refs.ts";
import { renderEphemeralMessage, renderStatusText, renderSyntheticStatusPair } from "./acp-status-tool.ts";
import { safeStderr } from "./stderr.ts";

// Parameters, the tier ladder, and the §5.2 decision table live in the pure
// leaf acp-plan.ts (single decision source, spec §5.1/§5.2/§11).
import {
	ACP_DEFAULT_PARAMS,
	ACP_MANIFEST_RENDER_BUDGET,
	ACP_ZONE_LIMIT_RATIO,
	type AcpParams,
	computeRoundPlan,
	computeSummaryBudget,
	computeTier,
} from "./acp-plan.ts";

// ---- runtime state --------------------------------------------------------------

export interface AcpRuntimeDeps {
	/** Token counter bound to the session model's Tokenizer (spec §8; byte-estimate fallback is built in). */
	countTokens: (text: string) => number;
	/** Journal write channel for compaction blocks (SessionManager, spec §9). */
	sink: AcpSummarySink;
	/** Journal read for entry-id alignment (SessionManager.getEntries). */
	getEntries: () => readonly SessionEntry[];
	/** Session model context window (spec §11 zone line = window × 35%; §5.3 guard line = window − reserve); 0/unknown = neither line. */
	contextWindow?: number;
	params?: Partial<AcpParams>;
	/**
	 * Level-3 force channel (spec §5.2/§10): must call
	 * AgentSession.setForcedToolChoice("compress_context") — the named form on
	 * faces that support it, and form ② for free on openai-completions faces
	 * (the transport narrows tools to the forced one + "required" when the face
	 * lacks named support). A throw means neither form exists: the runtime
	 * degrades (form ③).
	 */
	forceCompressTool?: () => void;
	/** Degrade side effect (spec §5.3/§10): restore the base compaction chain on the session's settings overlay. */
	onDegrade?: (reason: string) => void;
}

/** The current-round compression manifest (runtime-generated each request since T4; tests may pin one via setManifest). */
export interface AcpManifest {
	ids: string[];
	consumed: boolean;
}

/**
 * Round status behind the ephemeral (spec §5.2/§7): tier judgment, the
 * allowed compress method, zone sizes, and the rendered manifest. Refreshed
 * on every request from the fresh post-prune view — which is exactly the
 * settled round-end state, the new round's user turns included only as
 * protected-tail members — so the manifest the model sees is always the one
 * compress validates against (spec §4 snapshot rule).
 */
export interface AcpRoundStatus {
	tier: "none" | "L1" | "L2" | "L3";
	/** Compress method allowed this round (§5.2 table: >L3, or pending-strong riding over L1). */
	method: "normal" | "strong";
	/** Zone over its budget line (§5.2 rows 5/6): ephemeral gets the pending-strong annotation. */
	pendingStrong: boolean;
	/** Rendered token total of the live zone (the zone-size axis of the §5.2 table). */
	zoneTokens: number;
	/** Active-zone tokens, post-prune values (spec §8). */
	activeTokens: number;
	/** Token total of the projection (zone renders + surviving active blocks; block-sum approximation). */
	projectedTokens: number;
	manifestIds: string[];
	/** Candidates dropped by the manifest render budget: exempt this round, re-listed next round (§7). */
	exempted: number;
	/** Rendered manifest section (largest first), including the exemption trailer when truncated. */
	manifestText: string;
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
		| "degraded"
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
	/** Latest round status (tier + manifest) driving the ephemeral; null until the first auto-generated projection. */
	roundStatus: AcpRoundStatus | null = null;
	/** §5.3 permanent degrade: projection off, ephemeral stopped, compress rejected, base chain restored. */
	degraded = false;
	/** Why the session degraded (observability; empty while active). */
	degradeReason = "";
	/** Latest request view annotated with block ids (captured by projectView). */
	lastSource: AcpSourceMessage[] = [];
	lastBlocks: AcpBlockInfo[] = [];
	/** Latest projected request (test/assembly observability). */
	lastProjected: AgentMessage[] = [];
	#deps: AcpRuntimeDeps;
	/** Per-session compress mutex: a promise chain (the exclusive tool channel is unavailable, spec §6). */
	#lock: Promise<unknown> = Promise.resolve();
	/** True while a test/assembly pinned a manifest: auto-generation and the ephemeral stay off. */
	#manifestOverride = false;
	/** Host-side block token memo (spec §8): fingerprint|suffix|length -> tokens, reused across requests. */
	#tokenMemo = new Map<string, number>();
	/** Zone render token memo: compaction block id -> rendered tokens (blocks are immutable once written). */
	#zoneRenderTokens = new Map<string, number>();
	/** Zone budget line (spec §11): window × 35%, 0 = no limit (unknown window). */
	#zoneLimitTokens = 0;
	/** Total-volume guard line (spec §5.3): window − effectiveReserveTokens; 0 = off (unknown window). */
	#guardLineTokens = 0;
	/** Monotonic request counter: one projectView call = one request (context event). */
	#requestSeq = 0;
	/** Request seq whose ephemeral carried the L3 ultimatum (spec §5.2 round attribution). */
	#ultimatumAt = 0;
	/** Request seq whose projection was over the guard line (spec §5.3). */
	#guardAt = 0;
	/** Request seq during which a successful (≥ minCompress) compression landed. */
	#successAt = 0;
	/** Request seq the level-3 force is armed for; 0 = none (spec §5.2). */
	#forcedFor = 0;
	/** Armed force: the next successful compress executes forced-strong (meta.forced, spec §5.2). */
	#forcedExecution = false;
	/** Forced success: the next projection must come back under the guard line or degrade (spec §5.3). */
	#expectRelief = false;
	/** bN short-ref registry + acp_status-pair facts, replayed from the journal (spec §3/§6 v10, host/acp-refs.ts). */
	#refs = new AcpRefBook();

	constructor(deps: AcpRuntimeDeps) {
		this.#deps = deps;
		this.params = { ...ACP_DEFAULT_PARAMS, ...deps.params };
		this.#recomputeWindowLines(deps.contextWindow ?? 0);
	}

	/** Both window-derived lines (zone × 35%, guard = window − base reserve); 0 window disables them. */
	#recomputeWindowLines(contextWindow: number): void {
		this.#zoneLimitTokens = Math.floor(contextWindow * ACP_ZONE_LIMIT_RATIO);
		// Reuse the base reserve math verbatim (max(15%, default floor)) so the
		// guard line matches what the base's own overflow paths would assume.
		this.#guardLineTokens = contextWindow > 0 ? contextWindow - effectiveReserveTokens(contextWindow, {}) : 0;
	}

	/** Serialize executions; validation failures inside the lock do not break the chain. */
	runLocked<T>(fn: () => T | Promise<T>): Promise<T> {
		const run = this.#lock.then(fn, fn);
		this.#lock = run.catch(() => {});
		return run;
	}

	/** Pin a manifest by hand (tests/assembly): suspends auto-generation and the ephemeral until cleared. */
	setManifest(ids: string[]): void {
		this.#syncRefs(); // pinned ids are journal ids: make sure their short refs exist for the entry decode
		this.#manifestOverride = true;
		this.roundStatus = null; // a pinned manifest is test mode: no ephemeral of our own
		this.manifest = { ids, consumed: false };
	}

	/** Resume auto-generation (tests switching a fixture back to the real supply). */
	clearManifestOverride(): void {
		this.#manifestOverride = false;
	}

	/** Advance the journal walk (short refs + acp_status-pair facts); idempotent, called at every entry point (spec §3/§6 v10). */
	#syncRefs(): void {
		this.#refs.sync(this.#deps.getEntries());
	}

	/** The bN short ref of a journal block id (syncs first, so tests can ask any time; spec §3 v10). */
	shortRef(id: string): string | undefined {
		this.#syncRefs();
		return this.#refs.shortRef(id);
	}

	/**
	 * Active-zone blocks of the latest captured view: compressed blocks and
	 * retired acp_status pairs excluded — the latter left the projection, so
	 * they no longer count toward the active zone either (spec §6 v10).
	 */
	activeBlocks(): AcpBlockInfo[] {
		return this.lastBlocks.filter((b) => !this.compressed.has(b.id) && !this.#refs.droppedStatusResults.has(b.id));
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
	 * zone filtered to non-compressed blocks, then — when the round delivers
	 * the ultimatum — the v10.1 synthetic status pair, and finally the
	 * [acp-status] ephemeral appended when a tier is active (spec §6/§7 v10.1).
	 * Also refreshes the snapshot the compress validation runs against (same
	 * coordinate system as the manifest: the round status is re-derived from
	 * the settled round-end state — spec §5.2 round attribution) and anchors
	 * the failure-exit state machine to this request (ultimatum/guard lines).
	 * Degraded sessions pass the original view through verbatim (spec §5.3).
	 */
	projectView(view: readonly AgentMessage[]): AgentMessage[] {
		if (this.degraded) return [...view];
		this.#syncRefs();
		const source = annotateView(view, this.#deps.getEntries());
		this.lastSource = source;
		this.lastBlocks = splitBlocks(source, this.#deps.countTokens, this.#tokenMemo);
		// Retired acp_status pairs leave the projection pair-wise: dropping the
		// result block id from `kept` removes both the toolResult message and
		// its tool_use body (the pair filter keys on the result id, spec §6 v10).
		const dropped = this.#refs.droppedStatusResults;
		const kept = new Set(this.lastBlocks.filter((b) => !this.compressed.has(b.id) && !dropped.has(b.id)).map((b) => b.id));
		const out = projectContext(source, kept, this.zone, this.#deps.countTokens, (id) => this.#refs.label(id));
		if (!this.#manifestOverride) this.#refreshRoundStatus(true);
		if (this.roundStatus) this.#anchorRound(this.roundStatus);
		if (this.degraded) return [...view]; // the relief check degraded mid-projection
		const rs = this.roundStatus;
		// v10.1 synthetic status pair: requests that deliver the ultimatum copy —
		// the L3 tier itself, the request an armed force is pinned to, or a
		// guard-line direct trigger — carry a synthetic acp_status pair at the
		// active-zone end so the forced model already holds the manifest (spec
		// §5.2/§6 v10.1). Never journaled, never a candidate: it lives only in
		// this projected output and is rebuilt (byte-identical while the round
		// state holds) on every qualifying request.
		if (rs && (rs.tier === "L3" || this.#forcedFor === this.#requestSeq || this.#guardAt === this.#requestSeq)) {
			const pair = renderSyntheticStatusPair(rs, this.params);
			assertToolPairing(pair); // the pair rides as a complete tool round (spec §6 v10.1)
			out.push(pair[0], pair[1]);
		}
		if (rs && (rs.tier !== "none" || rs.pendingStrong)) {
			out.push(renderEphemeralMessage(rs, this.params));
		}
		this.lastProjected = out;
		return out;
	}

	/**
	 * Anchor the failure-exit machine to the request just projected (spec §5.2
	 * round attribution / §5.3): the L3 ultimatum counts as delivered with this
	 * request, and a projected total over the guard line arms the direct force
	 * path (no ultimatum wait). Also resolves the post-force relief check: a
	 * forced success must bring the total back under the line.
	 */
	#anchorRound(rs: AcpRoundStatus): void {
		this.#requestSeq++;
		if (this.#expectRelief) {
			this.#expectRelief = false;
			if (this.#guardLineTokens > 0 && rs.projectedTokens > this.#guardLineTokens) {
				this.degrade(`projected total ${rs.projectedTokens} still over the guard line ${this.#guardLineTokens} after the forced compression (spec §5.3)`);
				return;
			}
		}
		if (rs.tier === "L3") this.#ultimatumAt = this.#requestSeq;
		if (this.#guardLineTokens > 0 && rs.projectedTokens > this.#guardLineTokens) this.#guardAt = this.#requestSeq;
	}

	/**
	 * Turn-end judgment (spec §5.2 round attribution / §5.3 failure exits),
	 * driven by the session's turn_end event. A turn whose request carried the
	 * L3 ultimatum (or sat over the guard line) and produced no successful
	 * compression arms the level-3 force for the next request; a forced turn
	 * that still ends without success (validation failures, illegal output, or
	 * an API-error turn — error turns emit turn_end with no tool call)
	 * degrades. Successful rounds answer everything. Idle sessions never wake
	 * the machine: no timers, no queues — the next request (whenever it comes)
	 * consumes the armed force.
	 */
	onTurnEnd(): void {
		if (this.degraded) return;
		const req = this.#requestSeq;
		const success = this.#successAt === req;
		if (this.#forcedFor > 0 && req === this.#forcedFor) {
			this.#forcedFor = 0;
			this.#forcedExecution = false;
			if (!success) {
				this.degrade(`forced compression turn produced no successful compression (request ${req}, spec §5.2)`);
				return;
			}
			// Relief expectation (spec §5.3): the next projection must come in
			// under the guard line, or the session degrades.
			this.#expectRelief = this.#guardLineTokens > 0;
			return;
		}
		if (success) {
			// A successful compression answers any standing ultimatum and
			// retires a stale arm (the queue was consumed by another path).
			this.#forcedFor = 0;
			this.#forcedExecution = false;
			return;
		}
		if (this.#guardAt === req) return this.#armForce(`projected total over the guard line at request ${req}`);
		if (this.#ultimatumAt === req) return this.#armForce(`L3 ultimatum unanswered by the turn of request ${req}`);
	}

	/**
	 * Arm the level-3 force for the next request (spec §5.2). The only
	 * host-reachable channel is AgentSession.setForcedToolChoice: the named
	 * form ① where the face supports it, and form ② for free on
	 * openai-completions faces, whose transport degrades a named choice to
	 * "required" + a single-tool list when the face lacks named support. A
	 * throw means neither form exists (form ③): degrade immediately.
	 */
	#armForce(reason: string): void {
		if (this.#forcedFor > 0) return; // never double-arm
		try {
			this.#deps.forceCompressTool?.();
		} catch (err) {
			this.degrade(`cannot force compress_context: ${reason} (spec §5.2 form ③)`, err);
			return;
		}
		this.#forcedFor = this.#requestSeq + 1;
		this.#forcedExecution = true;
	}

	/**
	 * Permanently exit ACP for this session (spec §5.3): projection off
	 * (messages pass through verbatim), ephemeral stopped, compress rejected
	 * at the entry, and the assembly hook restores the base compaction chain
	 * on the session settings overlay. Idempotent.
	 */
	degrade(reason: string, err?: unknown): void {
		if (this.degraded) return;
		this.degraded = true;
		this.degradeReason = reason;
		safeStderr(`[ACP] degraded for this session; the base compaction chain takes over: ${reason}`, err);
		try {
			this.#deps.onDegrade?.(reason);
		} catch (hookErr) {
			safeStderr("[ACP] degrade hook failed", hookErr);
		}
	}

	/**
	 * Re-derive the round status (tier judgment + current-round manifest) from
	 * the freshly captured view (spec §5.1/§5.2/§7). Candidates = active zone −
	 * protected tail − acp_status pairs (never compressible, spec §6 v10),
	 * listed largest-first with bN short refs under the §11 render budget;
	 * blocks dropped by truncation are exempt this round and re-enter the next
	 * one. `adopt` swaps the returned manifest in as the current round's (an
	 * acp_status call adopts — voiding the previous round; a pinned test
	 * manifest only reads).
	 */
	#refreshRoundStatus(adopt: boolean): AcpRoundStatus {
		const countTokens = this.#deps.countTokens;
		const active = this.activeBlocks();
		const protectedIds = this.protectedZone(active);
		// Pseudo-id blocks (view messages with no journal entry behind them) can
		// never enter a manifest: their ids are positional, so "compressing" one
		// would phantom-fold a slot that reappears as a different id next round.
		const candidates = active
			.filter(
				(b) => !protectedIds.has(b.id) && !b.id.startsWith(ACP_VIEW_PSEUDO_PREFIX) && !this.#refs.liveStatusResults.has(b.id),
			)
			// Descending by size; the id tiebreak keeps the render deterministic.
			.sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const lines = candidates.map((b) => `${this.#refs.label(b.id)} | ${b.tokens} | ${b.intent}`);
		const trailer = (n: number) => `… ${n} more (exempt this round, re-listed next round)`;
		let keptCount = lines.length;
		if (keptCount > 0 && countTokens(lines.join("\n")) > ACP_MANIFEST_RENDER_BUDGET) {
			do {
				keptCount--;
			} while (keptCount > 0 && countTokens([...lines.slice(0, keptCount), trailer(lines.length - keptCount)].join("\n")) > ACP_MANIFEST_RENDER_BUDGET);
		}
		const manifestText =
			keptCount === lines.length ? lines.join("\n") : [...lines.slice(0, keptCount), trailer(lines.length - keptCount)].join("\n");
		const manifestIds = candidates.slice(0, keptCount).map((b) => b.id);
		if (adopt) this.manifest = { ids: manifestIds, consumed: false };
		const zoneTokens = this.#zoneTokens();
		const activeTokens = active.reduce((n, b) => n + b.tokens, 0);
		const plan = computeRoundPlan(activeTokens, this.params, { tokens: zoneTokens, limitTokens: this.#zoneLimitTokens });
		const rs: AcpRoundStatus = {
			tier: plan.tier,
			method: plan.method,
			pendingStrong: plan.pendingStrong,
			zoneTokens,
			activeTokens,
			projectedTokens: activeTokens + zoneTokens,
			manifestIds,
			exempted: lines.length - keptCount,
			manifestText,
		};
		this.roundStatus = rs;
		return rs;
	}

	/** Rendered token total of the live zone blocks (memoized; immutable once written, spec §8). */
	#zoneTokens(): number {
		const countTokens = this.#deps.countTokens;
		return this.zone.reduce((n, z) => {
			let t = this.#zoneRenderTokens.get(z.id);
			if (t === undefined) {
				t = countTokens(renderCompactionBlock(z, countTokens, (id) => this.#refs.label(id)));
				this.#zoneRenderTokens.set(z.id, t);
			}
			return n + t;
		}, 0);
	}

	/**
	 * acp_status entry (spec §6 v10): the pull channel. Every call re-derives
	 * the round status from the current settled snapshot and returns the
	 * dashboard + manifest; the returned manifest is the compression scope
	 * until the next call (the previous round's manifest is void). A pinned
	 * test manifest renders without adopting. Degraded sessions reject at the
	 * entry, same stance as compress/recall.
	 */
	status(): { ok: true; text: string } | { ok: false; error: string } {
		this.#syncRefs();
		if (this.degraded) {
			return {
				ok: false,
				error: "ACP is degraded for this session; the base compaction chain owns context management (spec §5.3).",
			};
		}
		const rs = this.#refreshRoundStatus(!this.#manifestOverride);
		return { ok: true, text: renderStatusText(rs, this.params) };
	}

	/**
	 * Rebind the token counter to a new model (spec §8; T3 leftover). The memo
	 * must go too: cached counts belong to the old encoding, and both
	 * window-derived lines (zone × 35%, guard) follow the new window.
	 */
	rebindModel(model: unknown): void {
		const tokenizer = new Tokenizer(model as never);
		this.#deps.countTokens = (s) => tokenizer.countTokens(s);
		this.#tokenMemo.clear();
		this.#zoneRenderTokens.clear();
		this.#recomputeWindowLines((model as { contextWindow?: number } | null | undefined)?.contextWindow ?? 0);
	}

	/** compress_context entry: mutex + full §6 validation sequence + execution. */
	compress(input: { keep?: string[]; summary?: string }): Promise<CompressOutcome | CompressRejection> {
		return this.runLocked(() => this.#validateAndExecute(input));
	}

	#validateAndExecute(input: { keep?: string[]; summary?: string }): CompressOutcome | CompressRejection {
		const p = this.params;
		const countTokens = this.#deps.countTokens;
		// §5.3 degrade — customTools cannot be unregistered after session
		// creation, so the tool surface stays and the entry rejects instead.
		if (this.degraded) {
			return {
				ok: false,
				code: "degraded",
				error: "ACP is degraded for this session; the base compaction chain owns context management (spec §5.3).",
			};
		}
		// §6.1 — a consumed (or missing) manifest rejects before anything else,
		// pointing at the pull channel for a fresh round (spec §6 v10).
		if (!this.manifest) {
			return { ok: false, code: "no-manifest", error: "No compression manifest for this round — call acp_status to get one." };
		}
		if (this.manifest.consumed) {
			return {
				ok: false,
				code: "manifest-consumed",
				error: "This round's manifest is already consumed; call acp_status for the next round's manifest.",
			};
		}
		// Tool-entry decode inside the lock (spec §3 v10): keep speaks bN short
		// refs; unknown refs pass through and the §6.2 validation judges them.
		this.#syncRefs();
		const keep = [...new Set((input.keep ?? []).map((ref) => this.#refs.resolve(ref)))];
		const keepSet = new Set(keep);
		const active = this.activeBlocks();
		const byId = new Map(active.map((b) => [b.id, b]));
		const protectedIds = this.protectedZone(active);
		const manifestSet = new Set(this.manifest.ids);
		const candidates = this.manifest.ids.filter((id) => byId.has(id) && !protectedIds.has(id));

		// §6.2 — hallucinated keep ids reject the whole call, with the full valid
		// candidate set (short refs, spec §3 v10).
		const bad = keep.filter((id) => !byId.has(id) || protectedIds.has(id));
		if (bad.length > 0) {
			const reasons = bad.map((id) => {
				if (protectedIds.has(id)) return `${this.#refs.label(id)} (protected tail)`;
				if (this.compressed.has(id)) return `${this.#refs.label(id)} (already compressed)`;
				if (manifestSet.has(id) && !byId.has(id)) return `${this.#refs.label(id)} (no longer active)`;
				return `${id} (nonexistent)`;
			});
			const valid = candidates.map((id) => this.#refs.label(id));
			return {
				ok: false,
				code: "hallucinated-keep",
				error: `keep contains invalid block ids: ${reasons.join(", ")}. Valid candidates: ${valid.length ? valid.join(", ") : "(none)"}.`,
				validCandidates: valid,
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

		// §6.5 — summary budget; basis = this round's compressed set plus, for a
		// strong reset, every old summary the zone merges in (§5.2/§11). The
		// method is re-derived here from the same settled snapshot the round
		// status uses (request-anchored judgment, §5.2): past L3, or riding a
		// zone over its line with active > L1 — a pure zone reset at or under L1
		// does not ride and stays normal. A level-3 armed force overrides to
		// strong unconditionally (§5.2: forced compression runs strong
		// semantics with meta.forced=true).
		const compressedIds = this.manifest.ids.filter((id) => byId.has(id) && !keepSet.has(id));
		const compressedTokens = compressedIds.reduce((n, id) => n + (byId.get(id)?.tokens ?? 0), 0);
		const activeTokensBefore = active.reduce((n, b) => n + b.tokens, 0);
		const zoneTokens = this.#zoneTokens();
		const forced = this.#forcedExecution;
		const method: "normal" | "strong" = forced
			? "strong"
			: computeRoundPlan(activeTokensBefore, p, { tokens: zoneTokens, limitTokens: this.#zoneLimitTokens }).method;
		const mergedOldSummaryTokens = method === "strong" ? zoneTokens : 0;
		const budget = computeSummaryBudget(compressedTokens, mergedOldSummaryTokens, p);
		const summaryTokens = countTokens(summary);
		if (summaryTokens > budget) {
			return {
				ok: false,
				code: "summary-over-budget",
				error:
					compressedIds.length === 0 && method !== "strong"
						? `keep covers the entire manifest — nothing would be compressed, so the summary budget is 0 (${summaryTokens} > ${budget}); unkeep some candidate blocks.`
						: `summary is ${summaryTokens} tokens, over the budget ${budget} = min((compressed ${compressedTokens} + merged old summaries ${mergedOldSummaryTokens}) / ${p.summaryDivisor}, ${p.summaryBudgetMax}); shorten it.`,
			};
		}

		// §6.6 — an empty compressed set rejects, EXCEPT a strong pure reset:
		// folding only the old zone summaries is a legal submission whose budget
		// basis is those summaries (§5.2/§6 exception; acceptance 14).
		if (compressedIds.length === 0 && method !== "strong") {
			return { ok: false, code: "nothing-to-compress", error: "Nothing to compress: the manifest minus keep intersects no active block." };
		}

		// Execution (§6): normal appends to the zone end; strong supersedes the
		// whole live zone and inherits its full compressedIds/index union, so the
		// zone renders as a single block and rebuild never walks supersedes
		// chains (§9). depth counts strong generations (normal blocks sit at 0).
		const activeTokensAfter = activeTokensBefore - compressedTokens;
		const supersedes = method === "strong" ? this.zone.map((z) => z.id) : [];
		const inheritedIds = new Set<string>();
		const index: AcpIndexLine[] = [];
		if (method === "strong") {
			for (const z of this.zone) {
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
		const written = appendAcpSummary(this.#deps.sink, {
			summary,
			index,
		meta: {
			createdAt: Date.now(),
			depth: method === "strong" ? this.zone.reduce((m, z) => Math.max(m, z.meta.depth), 0) + 1 : 0,
			method,
			...(forced ? { forced: true } : {}),
			keepIds: keep,
			compressedIds: [...inheritedIds, ...compressedIds],
			supersedes,
			tokensBefore: activeTokensBefore,
			tokensAfter: activeTokensAfter,
		},
		});
		// The fresh block sits at the journal tail: take its short ref now so the
		// outcome can name it the way the model will recall it (spec §3 v10).
		const blockLabel = this.#refs.assign(written.id);
		if (method === "strong") this.zone = [written];
		else this.zone.push(written);
		for (const id of compressedIds) this.compressed.add(id);
		this.manifest.consumed = true;
		// minCompress never gates validation (spec §5.2): below it the call
		// still succeeds — L2 adds a warning; L3 does not count it as a
		// successful compression for the §5.2/§5.3 failure exits. A pure reset
		// (folded tokens 0) likewise never counts (§5.2 compressed-set reading).
		const tierBefore = computeTier(activeTokensBefore, p);
		const countedAsSuccess = compressedTokens >= p.minCompress;
		this.#forcedExecution = false;
		if (countedAsSuccess) this.#successAt = this.#requestSeq;
		const warning =
			tierBefore === "L2" && !countedAsSuccess
				? `compressed ${compressedTokens} tokens is under minCompress ${p.minCompress}; allowed with warning at ${tierBefore} tier.`
				: undefined;
		return {
			ok: true,
			blockId: blockLabel,
			compressed: { blocks: compressedIds.length, tokens: compressedTokens },
			kept: { blocks: keep.length, tokens: keepTokens },
			activeTokensAfter,
			tier: computeTier(activeTokensAfter, p),
			countedAsSuccess,
			...(warning ? { warning } : {}),
		};
	}

	/**
	 * recall_block entry (spec §6): bN decode, then the four-id-class dispatch
	 * in acp-recall-tool.ts. The recalled text itself is a normal new
	 * tool-result block: no exemption, next round's manifest picks it up like
	 * any other. An old short ref of an already-compressed block still resolves
	 * and returns the original journal content (spec §3 v10).
	 */
	recall(id: unknown): RecallOutcome {
		if (this.degraded) {
			return {
				ok: false,
				error: "ACP is degraded for this session; the base compaction chain owns context management (spec §5.3).",
			};
		}
		if (typeof id !== "string" || !id) return { ok: false, error: "recall_block requires a non-empty block id." };
		this.#syncRefs();
		return dispatchRecall(this.#refs.resolve(id), { getEntries: this.#deps.getEntries, countTokens: this.#deps.countTokens }, (id2) =>
			this.#refs.label(id2),
		);
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
		// Zone line axis of the §5.2 table: window × 35% (§11); unknown window = no limit.
		contextWindow: (opts.model as { contextWindow?: number } | null | undefined)?.contextWindow ?? 0,
		params: opts.params,
	});
}

// ---- tool + extension -----------------------------------------------------------

const COMPRESS_CONTEXT_DESCRIPTION = `Compress old conversation blocks into a summary (context management).

Call acp_status first: its manifest lists this round's compressible blocks as bN short ids (largest first). Then call with:
- keep: the bN short ids from that manifest that must stay in the context verbatim (recent/important ones).
- summary: a complete technical summary of every listed block NOT kept (conclusions, file paths, decisions, exact values).

One successful compress consumes the manifest — call acp_status again for the next round. Compressed blocks leave the context and are represented by a persistent summary with a per-block index; recall_block can fetch any of them back later. The protected tail and blocks outside the manifest are never compressed — do not list them in keep.`;

/** compress_context ToolDefinition (registered via createAgentSession({ customTools })). */
export function createCompressContextTool(state: AcpRuntimeState) {
	return {
		name: "compress_context",
		label: "Compress Context",
		description: COMPRESS_CONTEXT_DESCRIPTION,
		parameters: type({
			keep: type.array(type("string")).describe("bN short ids from the current acp_status manifest to keep verbatim."),
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
