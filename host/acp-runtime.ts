// ACP dual-zone runtime: the per-session state machine (spec §5/§6/§7,
// tickets T3+T4+T6+T7; T11 split — the compress §6 validation/planning lives
// in acp-compress.ts and the factory/tool/extension assembly in
// acp-assembly.ts, re-exported below for the frozen importers).
//
// Since T6 the §5.2 table runs on both axes: the zone-size axis (rendered zone
// tokens vs window × 35%) drives the pending-strong state — strong execution
// semantics for the next compress once the total is past L1 (riding) or past
// L3 (always). pendingStrong is a derived state only: it never injects on its
// own, never extends an injection, and never moves the milestone cursor.
//
// Total arithmetic (§5.1): every "context total" consumer reads the last
// provider-reported prompt size anchored to the local count of the request it
// answered — P_anchor + (L_current − L_anchor). L covers the same complete
// request on both sides (non-message context + the final projected messages,
// ephemeral and synthetic status pair included). A projection that did not
// change therefore reports exactly P_anchor; new messages add their local
// delta and a compression subtracts its local delta. Without an anchor (first
// request, model/branch change) the local completeness estimate is used.
//
// T7 adds the failure-exit state (spec §5.2/§5.3): ultimatum round counting
// (anchored per request, judged at turn_end), the desktop's host-enforced forced
// round (which leaves the provider tool list unchanged), an optional provider
// hard-pin hook for other integrations, the total-volume guard, and degraded
// passthrough. Boundary-derived degradation is recomputed on branch resync and can recover.
//
// v10 (pull mode + short refs): the manifest leaves the ephemeral for the
// context_status tool — the no-tier range injects nothing at all and active tiers
// inject a one-line status row pointing at the tool (§7). Every model-facing
// id surface renders bN short refs from the journal-replayed AcpRefBook
// (host/acp-refs.ts; the persisted layer keeps entry ids, spec §3), the tool
// entries decode bN back to entry ids, and context_status tool pairs are neither
// compressible nor rendered once a later successful compress retires them
// (spec §6). The dashboard render lives in host/acp-status-tool.ts.
//
// v10.1: ultimatum-carrying requests (L3 tier / armed force / guard-line
// trigger) also ride a synthetic context_status pair at the active-zone end,
// before the ephemeral line (spec §5.2/§6 v10.1; renderer in acp-status-tool.ts).
//
// One AcpRuntimeState per session owns everything the tool and the projection
// need to agree on: the compaction zone (journal order), the compressed-id set
// (runtime mirror of rebuildAcpState), the current-round manifest, and the
// per-session compress mutex. The round status (tier + candidate manifest) is
// re-derived from the fresh post-prune view on every request AND on every
// context_status call (each return voids the previous round's manifest; spec §6
// v10). Tests may still pin a manifest directly via setManifest
// (auto-generation suspended while an override is pinned).
//
// Block-id alignment: the SDK context event hands over deep-copied view
// messages with no entry ids, while the manifest talks in entry-id block ids
// (spec §3). Ids are re-attached per request by fingerprint-matching the view
// against the journal (annotateView in acp-refs.ts); unmatched view messages
// (base-synthetic reminders) get pseudo ids that can never enter a manifest
// and pass through untouched.
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Tokenizer, effectiveReserveTokens } from "@oh-my-pi/pi-agent-core";
import { calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	assertToolPairing,
	projectContext,
	projectActiveMessages,
	renderCompactionBlock,
	signatureTokensOf,
	splitBlocks,
	type AcpBlockInfo,
	type AcpSourceMessage,
	type CountImage,
	type CountMessages,
	type CountSignatureTokens,
} from "./acp-projection.ts";
import { appendAcpSummary, branchCompactionFingerprint, rebuildAcpState, type AcpSummaryData, type AcpSummarySink } from "./acp-persist.ts";
import { ACP_VIEW_PSEUDO_PREFIX, AcpRefBook, annotateView } from "./acp-refs.ts";
import { renderEphemeralMessage, renderMilestoneMessage, renderStatusText, renderSyntheticStatusPair } from "./acp-status-tool.ts";
import { safeStderr } from "./stderr.ts";

// Parameters, the tier ladder, and the §5.2 decision table live in the pure
// leaf acp-plan.ts (single decision source, spec §5.1/§5.2/§11).
import {
	ACP_DEFAULT_PARAMS,
	ACP_MANIFEST_RENDER_BUDGET,
	ACP_ZONE_LIMIT_RATIO,
	type AcpParams,
	computeRoundPlan,
	computeTier,
	milestoneFor,
} from "./acp-plan.ts";

// Compress validation/planning moved to acp-compress.ts and the assembly
// layer (factory/tool/extension) to acp-assembly.ts (T11 split, pure
// refactor); the moved symbols are re-exported here so existing importers —
// session-lifecycle aside, the unmodifiable smoke scripts — keep resolving.
import { planCompression, type CompressOutcome, type CompressRejection } from "./acp-compress.ts";

export {
	createAcpRuntime,
	createCompressContextTool,
	createAcpProjectionExtension,
} from "./acp-assembly.ts";
export type { CompressOutcome, CompressRejection } from "./acp-compress.ts";

// ---- runtime state --------------------------------------------------------------

export interface AcpRuntimeDeps {
	/** Token counter bound to the session model's Tokenizer (spec §8; byte-estimate fallback is built in). */
	countTokens: (text: string) => number;
	/** Image charge bound to the same Tokenizer (spec §8): block tokens must price images like the base counter. */
	countImage?: CountImage;
	/** Encrypted-reasoning charge per assistant message (catalog thinking-replay axis); omitted = signature bytes. */
	countSignatureTokens?: CountSignatureTokens;
	/** Whole-list count over the final projected messages: the local side of the provider anchor arithmetic (§5.1). */
	countMessages?: CountMessages;
	/** Journal write channel for compaction blocks (SessionManager, spec §9). */
	sink: AcpSummarySink;
	/** Journal read for short refs and the provider prompt anchor. */
	getEntries: () => readonly SessionEntry[];
	/** Current branch only; defaults to the already branch-scoped test fixture feed. */
	getBranch?: () => readonly SessionEntry[];
	/** Session model context window (spec §11 zone line = window × 35%; §5.3 guard line = window − reserve); 0/unknown = neither line. */
	contextWindow?: number;
	/**
	 * Non-message part of the request (system prompt + tools + skills + injected
	 * context), from the base's own breakdown. It rides the local side of the
	 * anchor arithmetic, so a roster change lands in the delta; absent = 0
	 * (messages-only, the fixture behavior).
	 */
	nonMessageTokens?: () => number;
	params?: Partial<AcpParams>;
	/**
	 * Re-derives the full param set for a context window. Required for
	 * tierMode=percent: the tier lines are percentages of the model window, and
	 * the window is unknown at construction (createSessionCore receives no model
	 * on the load/branch paths) — only rebindModel knows it. Without this hook
	 * the lines stay whatever the window-less conversion produced for the whole
	 * session (percent degenerating to 25/50/75 tokens pinned every session at
	 * L3).
	 */
	resolveParams?: (contextWindow: number) => AcpParams;

	/**
	 * Degrade side effect (spec §5.3/§10): fired once when ACP exits this
	 * session, after the projection and tools have already stopped. The base
	 * auto chain stays pinned off at assembly (no settings write-back); smokes
	 * and future surfaces observe the reason here.
	 */
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
	/** Full request total: provider anchor + local delta (§5.1); the tier axis and every threshold read this. */
	projectedTokens: number;
	/** Live active-block count (dashboard surfaces). */
	activeBlocks: number;
	manifestIds: string[];
	/** Candidates dropped by the manifest render budget: exempt this round, re-listed next round (§7). */
	exempted: number;
	/** Rendered manifest section (largest first), including the exemption trailer when truncated. */
	manifestText: string;
}

/** The round's own model-facing injection (§7 v10.4): none, a once-per-crossing milestone, or the per-request forced ephemeral. */
type RoundInjection = { kind: "none" } | { kind: "message"; message: AgentMessage; milestoneKey: number | null };

export class AcpRuntimeState {
	/**
	 * Consecutive forced-round failures before the L3 ladder gives up: the
	 * first two re-arm the force, the third enters the persistent fallback where
	 * the host drives the base's manual compaction from this projection.
	 */
	static readonly FORCE_FAILURE_LIMIT = 3;
	/** Rebuilt by #applyWindow whenever the window changes (percent tier lines are window-relative). */
	params: AcpParams;
	readonly compressed = new Set<string>();
	zone: AcpSummaryData[] = [];
	manifest: AcpManifest | null = null;
	/** Latest round status (tier + manifest) driving the ephemeral; null until the first auto-generated projection. */
	roundStatus: AcpRoundStatus | null = null;
	/** Projection disabled; branch resync re-derives whether a boundary-era degrade can resume. */
	degraded = false;
	/** Why the session degraded (observability; empty while active). */
	degradeReason = "";
	/** Latest request view annotated with block ids (captured by projectView). */
	lastSource: AcpSourceMessage[] = [];
	lastBlocks: AcpBlockInfo[] = [];
	/** Latest projected request (test/assembly observability). */
	lastProjected: AgentMessage[] = [];
	/** Full branch-id prefix captured with lastSource; valid only until a boundary or branch move. */
	#snapshotEntryIds: string[] = [];
	#snapshotValid = false;
	#resetId: string | null = null;
	#compactionId: string | null = null;
	#alignFrom: string | undefined;
	#baseSummary: string | undefined;
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
	/**
	 * Highest delivered milestone, packed as rank×1000 + line (spec §7 v10.4):
	 * the L1..L3 segment injects once per crossed sub-line, never standing. The
	 * rank term carries the L2→L3 crossing, where the line index saturates — the
	 * ultimatum must still land once. Reset to 0 when a forced request injects
	 * its per-request ephemeral or when the tier drops; pendingStrong never
	 * resets it (it is a derived state with no injection of its own).
	 * In-memory only: a host restart re-fires once — harmless, self-healing.
	 */
	#delivered = 0;
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
	/** True from the first forced request through its turn_end, including provider retries. */
	#forcedRoundDelivered = false;
	/** A successful compression anywhere in the delivered forced turn. */
	#forcedRoundSuccess = false;
	/** Forced success: the next projection must come back under the guard line or degrade (spec §5.3). */
	#expectRelief = false;
	/**
	 * Persistent fallback after FORCE_FAILURE_LIMIT consecutive failed forced
	 * rounds. The L3 ladder stops arming; the host watches the base threshold
	 * from this runtime's projection and drives a manual base compaction with an
	 * ACP preparation. Only a successful fallback compaction clears it.
	 */
	fallback = false;
	/** Why fallback was entered, or the last fallback compaction failure (observability). */
	fallbackReason = "";
	/** Consecutive forced rounds that ended without a successful compression. */
	#forcedFailures = 0;
	/**
	 * Entry count when the last fallback compaction attempt failed. A same-history
	 * retry is a tight loop, so the host only retries after the branch changes.
	 */
	#fallbackAttemptEntries = -1;
	/** bN short-ref registry + context_status-pair facts, replayed from the journal (spec §3/§6 v10, host/acp-refs.ts). */
	#refs = new AcpRefBook();
	/** [compress-hint] injections since the last accepted compress (stats telemetry, reset on success). */
	#hintCount = 0;
	/** Tokens of the latest context_status return; the compress it feeds records it (stats telemetry). */
	#lastStatusTokens: number | null = null;
	/**
	 * Provider prompt anchor (§5.1): the last reported input size and the local
	 * count of the exact request it answered. The total is
	 * `promptTokens + local - localTokens`; the anchor is dropped whenever the
	 * pairing can no longer hold (model rebind, branch resync, degrade).
	 */
	#anchor: { promptTokens: number; localTokens: number } | null = null;
	/** Basis of the latest projection awaiting the provider's report: local count + anchor entry + branch tail at that time. */
	#lastProjection: {
		anchorEntryId: string | null;
		localTokens: number;
		branchTailId: string | null;
		branchLength: number;
	} | null = null;
	/** Anchored total of the latest request (status/fallback readers); 0 until the first projection. */
	#lastTotal = 0;

	constructor(deps: AcpRuntimeDeps) {
		this.#deps = deps;
		this.params = { ...ACP_DEFAULT_PARAMS, ...deps.params };
		this.#applyWindow(deps.contextWindow ?? 0);
	}

	/** Re-derive everything window-dependent: the zone/guard lines and, when the caller supplies the hook, the tier lines. */
	#applyWindow(contextWindow: number): void {
		this.#recomputeWindowLines(contextWindow);
		if (!this.#deps.resolveParams) return;
		this.params = { ...ACP_DEFAULT_PARAMS, ...this.#deps.resolveParams(contextWindow) };
		// Shifted tier lines make the milestone cursor's rank/key comparison meaningless; restart the ladder.
		this.#delivered = 0;
	}

	/** Both window-derived lines (zone × 35%, guard = window − base reserve); 0 window disables them. */
	#recomputeWindowLines(contextWindow: number): void {
		this.#zoneLimitTokens = Math.floor(contextWindow * ACP_ZONE_LIMIT_RATIO);
		// Reuse the base reserve math verbatim (max(15%, default floor)) so the
		// guard line matches what the base's own overflow paths would assume.
		this.#guardLineTokens = contextWindow > 0 ? contextWindow - effectiveReserveTokens(contextWindow, {} as never) : 0;
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

	/** Advance the journal walk (short refs + context_status-pair facts); idempotent, called at every entry point (spec §3/§6 v10). */
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
	 * retired context_status pairs excluded — the latter left the projection, so
	 * they no longer count toward the active zone either (spec §6 v10).
	 */
	activeBlocks(): AcpBlockInfo[] {
		return this.lastBlocks.filter((b) => !this.compressed.has(b.id) && !this.#refs.droppedStatusResults.has(b.id));
	}

	/**
	 * Protected tail: min(last tailTurns turns, tailTokens) of the active zone,
	 * floored at the latest tailUserMessages real user inputs — walk backwards
	 * group by group and stop at whichever limit fires first (spec §11). A group
	 * = one assistant message (all its #t/#x blocks) plus every result block it
	 * owns; a user block is its own group and closes a turn. Groups join
	 * atomically, so the cut always lands on a group boundary and never
	 * separates a tool_use from its result (providers enforce pairing —
	 * Anthropic 400/2013) or splits one message's blocks apart.
	 *
	 * The user-message floor wins over the turn/token ceilings: a session whose
	 * recent blocks are mostly synthetic auto-continues would otherwise satisfy
	 * tailTurns before reaching N real user requests.
	 */
	protectedZone(active: readonly AcpBlockInfo[] = this.activeBlocks()): Set<string> {
		const p = this.params;
		const ids = new Set<string>();
		const userFloor = p.tailUserMessages;
		const ceilingsOff = p.tailTurns <= 0 && p.tailTokens <= 0;
		if (ceilingsOff && userFloor <= 0) return ids;
		let tokens = 0;
		let turns = 0;
		let userInputs = 0;
		let i = active.length - 1;
		// Keep walking while the user-message floor is unmet, then stop at
		// whichever ceiling fires first (min semantics); a zeroed parameter
		// disables its limit. With both ceilings off the floor alone ends it.
		while (
			i >= 0 &&
			((userFloor > 0 && userInputs < userFloor) ||
				(!ceilingsOff && !((p.tailTurns > 0 && turns >= p.tailTurns) || (p.tailTokens > 0 && tokens >= p.tailTokens))))
		) {
			const group: AcpBlockInfo[] = [];
			while (i >= 0 && active[i].kind === "result") group.push(active[i--]);
			if (i >= 0 && active[i].kind === "user") {
				const user = active[i--];
				group.push(user);
				turns++;
				// View-only injections (base reminders) never reach the journal and
				// must not spend the user-message floor on a non-candidate.
				if (user.userInput && !user.id.startsWith(ACP_VIEW_PSEUDO_PREFIX)) userInputs++;
			} else if (i >= 0) {
				// assistant message head: pull in every block of the same source message
				const sid = active[i].sourceId;
				while (i >= 0 && active[i].sourceId === sid) group.push(active[i--]);
			}
			for (const b of group) {
				ids.add(b.id);
				tokens += b.tokens;
			}
		}
		return ids;
	}

	#branch(): readonly SessionEntry[] {
		return this.#deps.getBranch?.() ?? this.#deps.getEntries();
	}

	#ensureBranchCurrent(branch: readonly SessionEntry[]): void {
		const current = branchCompactionFingerprint(branch);
		if (current.resetId !== this.#resetId || current.compactionId !== this.#compactionId) this.resyncToBranch(branch);
	}

	#invalidateSnapshot(): void {
		this.#snapshotValid = false;
		this.#snapshotEntryIds = [];
		this.lastSource = [];
		this.lastBlocks = [];
		this.lastProjected = [];
	}

	/**
	 * Active projection with real journal ids for base-compaction takeover. A
	 * same-branch append extends the captured view; any boundary or non-prefix
	 * move invalidates it instead of summarizing a stale branch.
	 */
	activeZoneMessages(branchEntries: readonly SessionEntry[]): AcpSourceMessage[] | null {
		this.#ensureBranchCurrent(branchEntries);
		if (this.degraded || !this.#snapshotValid) return null;
		const ids = branchEntries.map((entry) => entry.id);
		for (let i = 0; i < this.#snapshotEntryIds.length; i++) {
			if (this.#snapshotEntryIds[i] !== ids[i]) return null;
		}
		if (this.#snapshotEntryIds.length > ids.length) return null;
		const appended = branchEntries.slice(this.#snapshotEntryIds.length);
		if (appended.some((entry) => entry.type === "compaction" || entry.type === "reset_boundary")) return null;
		const appendedSources: AcpSourceMessage[] = [];
		let sourceChanged = false;
		for (const entry of appended) {
			if (entry.type !== "message") continue;
			const source = annotateView([entry.message], [entry])[0];
			if (source.id.startsWith(ACP_VIEW_PSEUDO_PREFIX)) return null;
			// The in-flight user message is view-only at projection time and lands
			// in the journal before post-turn compaction. Re-identify a matching
			// trailing pseudo message instead of appending a duplicate.
			let reidentified = false;
			for (let i = this.lastSource.length - 1; i >= 0 && this.lastSource[i].id.startsWith(ACP_VIEW_PSEUDO_PREFIX); i--) {
				if (annotateView([this.lastSource[i].message], [entry])[0].id !== entry.id) continue;
				this.lastSource[i] = source;
				sourceChanged = true;
				reidentified = true;
				break;
			}
			if (!reidentified) appendedSources.push(source);
		}
		if (sourceChanged || appendedSources.length > 0) {
			this.lastSource.push(...appendedSources);
			this.lastBlocks = splitBlocks(
				this.lastSource,
				this.#deps.countTokens,
				this.#tokenMemo,
				this.#deps.countImage,
				this.#deps.countSignatureTokens,
			);
		}
		this.#snapshotEntryIds = ids;
		const dropped = this.#refs.droppedStatusResults;
		const kept = new Set(this.lastBlocks.filter((b) => !this.compressed.has(b.id) && !dropped.has(b.id)).map((b) => b.id));
		return projectActiveMessages(this.lastSource, kept, this.#deps.countTokens);
	}

	zoneRenderText(): string {
		this.#syncRefs();
		return this.zone.map((block) => renderCompactionBlock(block, (id) => this.#refs.label(id))).join("\n\n");
	}

	/**
	 * Project a request view (spec §4): compression zone first, then the active
	 * zone filtered to non-compressed blocks, then — when the round delivers
	 * the ultimatum — the v10.1 synthetic status pair, and finally the
	 * [compress-hint] ephemeral appended when a tier is active (spec §6/§7 v10.1).
	 * Also refreshes the snapshot the compress validation runs against (same
	 * coordinate system as the manifest: the round status is re-derived from
	 * the settled round-end state — spec §5.2 round attribution) and anchors
	 * the failure-exit state machine to this request (ultimatum/guard lines).
	 * Degraded sessions pass the original view through verbatim (spec §5.3).
	 */
	projectView(view: readonly AgentMessage[]): AgentMessage[] {
		const branch = this.#branch();
		this.#ensureBranchCurrent(branch);
		if (this.degraded) return [...view];
		this.#syncRefs();
		// Pair the newest provider report with the request it answered before the
		// total is measured (the report answers the previous projection).
		this.#tryAdoptAnchor(branch);
		const source = annotateView(view, branch, this.#alignFrom);
		this.lastSource = source;
		this.lastBlocks = splitBlocks(
			source,
			this.#deps.countTokens,
			this.#tokenMemo,
			this.#deps.countImage,
			this.#deps.countSignatureTokens,
		);
		this.#snapshotEntryIds = branch.map((entry) => entry.id);
		this.#snapshotValid = true;
		// Retired context_status pairs leave the projection pair-wise: dropping the
		// result block id from `kept` removes both the toolResult message and
		// its tool_use body (the pair filter keys on the result id, spec §6 v10).
		const dropped = this.#refs.droppedStatusResults;
		const kept = new Set(this.lastBlocks.filter((b) => !this.compressed.has(b.id) && !dropped.has(b.id)).map((b) => b.id));
		const base = projectContext(source, kept, this.zone, this.#deps.countTokens, (id) => this.#refs.label(id), (err) =>
			safeStderr(`[ACP] projection pairing gap (passing through; the provider layer re-pairs the wire):`, err),
		);
		const active = this.activeBlocks();
		const activeTokens = active.reduce((n, b) => n + b.tokens, 0);
		// The tier the injections carry is itself part of the total: seed the
		// round from the un-injected projection and stabilize below.
		if (!this.#manifestOverride) {
			this.#refreshRoundStatus(true, undefined, this.#anchoredTotal(this.#localRequestTokens(base, activeTokens + this.#zoneTokens())));
		}
		let forcedNow = false;
		let injection: RoundInjection = { kind: "none" };
		let out: AgentMessage[] = base;
		let localTokens = this.#localRequestTokens(base, activeTokens + this.#zoneTokens());
		// A pinned test manifest suspends auto-generation and every injection.
		const rs0 = this.#manifestOverride ? null : this.roundStatus;
		if (rs0) {
			this.#beginRequest();
			let rs = rs0;
			// The injections add tokens and the guard breach adds injections: the
			// fixed point is bounded by the four tiers, so a short loop settles it.
			for (let pass = 0; pass < 4; pass++) {
				forcedNow = this.#forcedNow(rs);
				injection = this.#injectionFor(rs, forcedNow);
				const built = this.#assembleRequest(base, rs, forcedNow, injection);
				out = built;
				localTokens = this.#localRequestTokens(out, activeTokens + this.#zoneTokens());
				const total = this.#anchoredTotal(localTokens);
				const plan = computeRoundPlan(total, this.params, { tokens: this.#zoneTokens(), limitTokens: this.#zoneLimitTokens });
				if (total === rs.projectedTokens && plan.tier === rs.tier && plan.method === rs.method && plan.pendingStrong === rs.pendingStrong) {
					break;
				}
				rs = { ...rs, tier: plan.tier, method: plan.method, pendingStrong: plan.pendingStrong, projectedTokens: total };
			}
			this.roundStatus = rs;
			this.#judgeRound(rs);
			if (this.degraded) return [...view]; // the relief check degraded mid-projection
			this.#commitInjection(rs, injection);
		}
		this.lastProjected = out;
		this.#lastTotal = this.#anchoredTotal(localTokens);
		this.#lastProjection = {
			anchorEntryId: this.#latestAnchor(branch)?.entryId ?? null,
			localTokens,
			branchTailId: branch.at(-1)?.id ?? null,
			branchLength: branch.length,
		};
		return out;
	}

	/**
	 * Newest journaled assistant turn carrying a provider prompt report: the
	 * anchor of the total arithmetic (§5.1). Aborted/error turns report partial
	 * or zero usage and never qualify, and `promptTokens` is the provider's
	 * input size — never `usage.totalTokens`, which adds the output side.
	 */
	#latestAnchor(branch: readonly SessionEntry[]): { entryId: string; promptTokens: number } | null {
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			if (message.stopReason === "aborted" || message.stopReason === "error") continue;
			const promptTokens = message.contextSnapshot?.promptTokens ?? (message.usage ? calculatePromptTokens(message.usage) : 0);
			if (promptTokens > 0) return { entryId: entry.id, promptTokens };
		}
		return null;
	}

	/**
	 * Bind the provider's latest report to the local count of the request it
	 * answered — the previous projection. A new anchor turn is the signal that
	 * the report arrived: an errored or aborted turn leaves the previous anchor
	 * in place, and a model rebind or branch resync clears the pairing first.
	 */
	#tryAdoptAnchor(branch: readonly SessionEntry[]): void {
		const latest = this.#latestAnchor(branch);
		const last = this.#lastProjection;
		if (!latest || !last || latest.entryId === last.anchorEntryId) return;
		// The recorded request must still describe this branch: a rewind or an
		// in-place branch rewrite leaves no pairing, so the anchor is dropped.
		const tail = last.branchLength > 0 ? branch[last.branchLength - 1] : undefined;
		if ((tail?.id ?? null) !== last.branchTailId) {
			this.#anchor = null;
			return;
		}
		this.#anchor = { promptTokens: latest.promptTokens, localTokens: last.localTokens };
	}

	/**
	 * Local side of the anchor arithmetic: the non-message context plus the
	 * complete projected request. `countMessages` prices every message the
	 * provider receives (zone render, active zone, ephemeral, synthetic status
	 * pair) and the live runtime always binds it (createAcpRuntime/rebindModel);
	 * `fallbackTokens` is the block-only projection for fixtures that bind no
	 * message counter — view-only injections have no blocks there.
	 */
	#localRequestTokens(messages: readonly AgentMessage[], fallbackTokens: number): number {
		const nonMessage = this.#deps.nonMessageTokens?.() ?? 0;
		const counted = this.#deps.countMessages?.(messages);
		return nonMessage + (counted ?? fallbackTokens);
	}

	/** Provider anchor plus the local change since the anchored request (§5.1). */
	#anchoredTotal(localTokens: number): number {
		const anchor = this.#anchor;
		if (!anchor) return localTokens;
		return Math.max(0, anchor.promptTokens + localTokens - anchor.localTokens);
	}

	/** Anchor the failure-exit machine to this request (spec §5.2 round attribution). */
	#beginRequest(): void {
		this.#requestSeq++;
		if (this.#forcedFor > 0 && this.#requestSeq >= this.#forcedFor) this.#forcedRoundDelivered = true;
	}

	/** True when this request must carry the per-request forced ephemeral and status pair. */
	#forcedNow(rs: AcpRoundStatus): boolean {
		return this.#forcedRoundDelivered || (this.#guardLineTokens > 0 && rs.projectedTokens > this.#guardLineTokens);
	}

	/**
	 * The round's own injection (§7 v10.4): forced requests keep the per-request
	 * ephemeral; otherwise only a crossed L2..L3 milestone injects, once. The
	 * L1..L2 band and tier none stay silent even while pendingStrong is set —
	 * pendingStrong is a derived state, and other injections (and context_status)
	 * carry its note from the latest round state.
	 */
	#injectionFor(rs: AcpRoundStatus, forcedNow: boolean): RoundInjection {
		if (forcedNow) return { kind: "message", message: renderEphemeralMessage(rs, this.params, true), milestoneKey: null };
		const tier = rs.tier;
		if (tier === "none") return { kind: "none" };
		const rank = tier === "L1" ? 1 : tier === "L2" ? 2 : 3;
		// A tier drop clears the cursor; an in-tier dip does not re-announce.
		const delivered = rank < Math.floor(this.#delivered / 1_000) ? 0 : this.#delivered;
		const milestone = milestoneFor(rs.projectedTokens, this.params);
		const key = rank * 1_000 + milestone; // steps < 1000 keeps the pack unambiguous
		if (milestone > 0 && key > delivered) {
			return { kind: "message", message: renderMilestoneMessage(rs, tier, milestone, this.params), milestoneKey: key };
		}
		return { kind: "none" };
	}

	/** Base projection + synthetic status pair (ultimatum / guard) + the round injection. */
	#assembleRequest(base: AgentMessage[], rs: AcpRoundStatus, forcedNow: boolean, injection: RoundInjection): AgentMessage[] {
		const messages = [...base];
		// L3 and host-enforced forced requests carry a synthetic context_status pair
		// at the active-zone end so the model already has the manifest; the forced
		// tool_call gate rejects context_status, so it cannot fetch one during that turn.
		if (rs.tier === "L3" || forcedNow) {
			const pair = renderSyntheticStatusPair(rs, this.params, forcedNow);
			assertToolPairing(pair); // the pair rides as a complete tool round (spec §6 v10.1)
			messages.push(pair[0], pair[1]);
		}
		if (injection.kind === "message") messages.push(injection.message);
		return messages;
	}

	/** Commit the injection's cursor effects once the round settled. */
	#commitInjection(rs: AcpRoundStatus, injection: RoundInjection): void {
		if (injection.kind === "message") {
			this.#delivered = injection.milestoneKey ?? 0;
			this.#hintCount++;
			return;
		}
		const rank = rs.tier === "L3" ? 3 : rs.tier === "L2" ? 2 : rs.tier === "L1" ? 1 : 0;
		// A tier drop clears the cursor; an in-tier dip does not re-announce.
		if (rank < Math.floor(this.#delivered / 1_000)) this.#delivered = 0;
	}

	/**
	 * Judge the settled round against the failure exits (spec §5.2 round
	 * attribution / §5.3): the L3 ultimatum counts as delivered with this
	 * request, and a total over the guard line arms the direct force path (no
	 * ultimatum wait). Also resolves the post-force relief check: a forced
	 * success must bring the total back under the line.
	 */
	#judgeRound(rs: AcpRoundStatus): void {
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
	 * counts another failure and may enter fallback. Successful rounds answer
	 * the machine: no timers, no queues — the next request (whenever it comes)
	 * consumes the armed force.
	 */
	onTurnEnd(): void {
		if (this.degraded) return;
		const req = this.#requestSeq;
		const forced = this.#forcedRoundDelivered;
		const success = this.#successAt === req || (forced && this.#forcedRoundSuccess);
		if (success) this.#forcedFailures = 0;
		if (forced) {
			this.#forcedFor = 0;
			this.#forcedRoundDelivered = false;
			this.#forcedRoundSuccess = false;
			this.#forcedExecution = false;
			if (!success) {
				this.#forcedFailures++;
				if (this.#forcedFailures < AcpRuntimeState.FORCE_FAILURE_LIMIT) {
					return this.#armForcedRound();
				}
				// The ladder gave up: no degrade (the base raw chain stays pinned
				// off), no more forcing. The host's fallback supervisor takes over
				// from the ACP projection.
				this.fallback = true;
				this.fallbackReason = `forced compression failed ${this.#forcedFailures} consecutive rounds (request ${req})`;
				safeStderr(`[ACP] ${this.fallbackReason}; entering fallback (base manual compaction with an ACP preparation)`);
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
			this.#forcedRoundDelivered = false;
			this.#forcedRoundSuccess = false;
			this.#forcedExecution = false;
			return;
		}
		// Fallback never re-arms the force: a new failed round would just repeat
		// the three failures. The host owns recovery from here.
		if (this.fallback) return;
		if (this.#guardAt === req) return this.#armForcedRound();
		if (this.#ultimatumAt === req) return this.#armForcedRound();
	}

	/** True while the current assistant turn is servicing the host-enforced L3 round. */
	forcedRoundActive(): boolean {
		return this.#forcedRoundDelivered;
	}

	/** True after the L3 force ladder gave up; the host drives base manual compaction. */
	fallbackActive(): boolean {
		return this.fallback && !this.degraded;
	}

	/** Consecutive failed forced rounds (0 after any successful compression). */
	forcedFailureCount(): number {
		return this.#forcedFailures;
	}

	/**
	 * A failed fallback compaction must not be retried on the same history: that
	 * is a tight loop with no new information. Only a branch change (a new turn
	 * or a user message) re-opens the attempt.
	 */
	fallbackAttemptAllowed(): boolean {
		return this.#fallbackAttemptEntries !== this.#deps.getEntries().length;
	}

	/** A committed ACP fallback compaction: leave fallback and clear every ladder counter. */
	onFallbackCompactionSucceeded(): void {
		this.fallback = false;
		this.fallbackReason = "";
		this.#forcedFailures = 0;
		this.#fallbackAttemptEntries = -1;
		this.#forcedFor = 0;
		this.#forcedRoundDelivered = false;
		this.#forcedRoundSuccess = false;
		this.#forcedExecution = false;
		this.#guardAt = 0;
		this.#ultimatumAt = 0;
	}

	/**
	 * A failed fallback compaction: stay in fallback, record the explicit error,
	 * and block a same-history retry. Never degrade into the base raw chain — the
	 * base auto chain stays pinned off for ACP sessions.
	 */
	onFallbackCompactionFailed(reason: string, err?: unknown): void {
		this.fallback = true;
		this.fallbackReason = reason;
		this.#fallbackAttemptEntries = this.#deps.getEntries().length;
		safeStderr(`[ACP] fallback compaction failed; staying in fallback: ${reason}`, err);
	}

	/** Arm the host-enforced level-3 round for the next request (spec §5.2). */
	#armForcedRound(): void {
		this.#forcedFor = this.#requestSeq + 1;
		this.#forcedRoundDelivered = false;
		this.#forcedRoundSuccess = false;
		this.#forcedExecution = true;
	}

	/**
	 * Stop projecting the current state: messages pass through, ephemerals stop,
	 * and compress rejects. Branch resync can clear boundary-derived degradation.
	 */
	degrade(reason: string, err?: unknown): void {
		if (this.degraded) return;
		this.degraded = true;
		this.degradeReason = reason;
		// The projection stops rewriting the request, so no local count can be
		// paired with a later provider report.
		this.#anchor = null;
		this.#lastProjection = null;
		this.#lastTotal = 0;
		safeStderr(`[ACP] degraded for this session; base auto compaction stays pinned off: ${reason}`, err);
		try {
			this.#deps.onDegrade?.(reason);
		} catch (hookErr) {
			safeStderr("[ACP] degrade hook failed", hookErr);
		}
	}

	/**
	 * Re-derive the baseline and zone from the target branch. Summaries on
	 * abandoned siblings stay hidden, and reset/rewind can restore an earlier era.
	 */
	resyncToBranch(entries: readonly SessionEntry[] = this.#branch()): void {
		const rebuilt = rebuildAcpState(entries);
		this.#resetId = rebuilt.resetId;
		this.#compactionId = rebuilt.compactionId;
		this.#alignFrom = rebuilt.alignFrom;
		this.#baseSummary = rebuilt.baseSummary;
		// Branch moves invalidate the pairing: the measured request no longer
		// describes this branch, so the next total starts from the local estimate.
		this.#anchor = null;
		this.#lastProjection = null;
		this.#lastTotal = 0;
		this.#invalidateSnapshot();
		this.zone = rebuilt.zone;
		this.compressed.clear();
		for (const id of rebuilt.compressedBlockIds) this.compressed.add(id);
		if (rebuilt.degraded) {
			this.degrade(rebuilt.degradedReason ?? "current branch has an unsupported compaction boundary");
		} else {
			this.degraded = false;
			this.degradeReason = "";
		}
	}

	/**
	 * Re-derive the round status (tier judgment + current-round manifest) from
	 * the freshly captured view (spec §5.1/§5.2/§7). Candidates = active zone −
	 * protected tail − context_status pairs (never compressible, spec §6 v10),
	 * listed largest-first with bN short refs under the §11 render budget;
	 * blocks dropped by truncation are exempt this round and re-enter the next
	 * one. `adopt` swaps the returned manifest in as the current round's (an
	 * context_status call adopts — voiding the previous round; a pinned test
	 * manifest only reads). `maxManifestBytes` is the caller's inline byte
	 * budget (the base tool-result spill threshold): the manifest must fit it
	 * or the base stage head/tails the list in the middle, so the same
	 * whole-line cut applies and the dropped tail is exempt this round too.
	 *
	 * `totalTokens` is the anchored full-request total (§5.1), measured against
	 * the complete projection by the caller: the tier axis and every threshold
	 * read this one number.
	 */
	#refreshRoundStatus(adopt: boolean, maxManifestBytes: number | undefined, totalTokens: number): AcpRoundStatus {
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
		const fits = (n: number) =>
			n === lines.length ? lines.join("\n") : [...lines.slice(0, n), trailer(lines.length - n)].join("\n");
		if (keptCount > 0 && countTokens(fits(keptCount)) > ACP_MANIFEST_RENDER_BUDGET) {
			do {
				keptCount--;
			} while (keptCount > 0 && countTokens(fits(keptCount)) > ACP_MANIFEST_RENDER_BUDGET);
		}
		if (maxManifestBytes != null) {
			while (keptCount > 0 && Buffer.byteLength(fits(keptCount), "utf-8") > maxManifestBytes) keptCount--;
		}
		const manifestText = fits(keptCount);
		const manifestIds = candidates.slice(0, keptCount).map((b) => b.id);
		if (adopt) this.manifest = { ids: manifestIds, consumed: false };
		const zoneTokens = this.#zoneTokens();
		const activeTokens = active.reduce((n, b) => n + b.tokens, 0);
		const plan = computeRoundPlan(totalTokens, this.params, { tokens: zoneTokens, limitTokens: this.#zoneLimitTokens });
		const rs: AcpRoundStatus = {
			tier: plan.tier,
			method: plan.method,
			pendingStrong: plan.pendingStrong,
			zoneTokens,
			activeTokens,
			projectedTokens: totalTokens,
			activeBlocks: active.length,
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
				t = countTokens(renderCompactionBlock(z, (id) => this.#refs.label(id)));
				this.#zoneRenderTokens.set(z.id, t);
			}
			return n + t;
		}, 0);
	}

	/** Anchored total of the latest request; before the first projection, the local completeness estimate. */
	projectedTokenEstimate(): number {
		if (this.#lastTotal > 0) return this.#lastTotal;
		const active = this.activeBlocks().reduce((n, b) => n + b.tokens, 0);
		return this.#anchoredTotal((this.#deps.nonMessageTokens?.() ?? 0) + active + this.#zoneTokens());
	}

	countProjectedMessages(messages: readonly AgentMessage[]): number | undefined {
		return this.#deps.countMessages?.(messages);
	}

	/**
	 * context_status entry (spec §6 v10): the pull channel. Every call re-derives
	 * the round status from the current settled snapshot and returns the
	 * dashboard + manifest; the returned manifest is the compression scope
	 * until the next call (the previous round's manifest is void). A pinned
	 * test manifest renders without adopting. Degraded sessions reject at the
	 * entry, same stance as compress.
	 *
	 * `maxBytes` is the caller's inline budget (the base tool-result spill
	 * threshold): beyond it the base stage would head/tail the manifest in the
	 * middle, so the round is re-derived with a whole-line cut that keeps the
	 * list readable and the returned manifestIds in step with what the model
	 * actually sees.
	 */
	status(maxBytes?: number): { ok: true; text: string } | { ok: false; error: string } {
		this.#syncRefs();
		if (this.degraded) {
			return {
				ok: false,
				error: "ACP is degraded for this session; context management is frozen and the base auto chain stays disabled (spec §5.3).",
			};
		}
		const projectedTokens = this.projectedTokenEstimate();
		if (computeTier(projectedTokens, this.params) === "none") {
			return {
				ok: false,
				error: `Context total is ${projectedTokens} tokens, at or below the L1 activation line ${this.params.l1}; the context is too small to compress — context_status returns once the total grows past L1.`,
			};
		}
		const adopt = !this.#manifestOverride;
		let rs = this.#refreshRoundStatus(adopt, undefined, projectedTokens);
		let text = renderStatusText(rs, this.params);
		if (maxBytes != null) {
			const overflow = Buffer.byteLength(text, "utf-8") - maxBytes;
			if (overflow > 0) {
				const manifestBytes = Buffer.byteLength(rs.manifestText, "utf-8") - overflow;
				rs = this.#refreshRoundStatus(adopt, Math.max(0, manifestBytes), projectedTokens);
				text = renderStatusText(rs, this.params);
			}
		}
		// Stats telemetry: the compress this manifest feeds records what the pull cost.
		// Survives the next projectView — the pull and the compress it feeds are always
		// separate requests (the model needs the tool result before it can compress).
		this.#lastStatusTokens = this.#deps.countTokens(text);
		return { ok: true, text };
	}

	/**
	 * Rebind the token counter to a new model (spec §8; T3 leftover). The memo
	 * must go too: cached counts belong to the old encoding, and everything
	 * window-derived (zone × 35%, guard, percent tier lines) follows the new
	 * window.
	 */
	rebindModel(model: unknown): void {
		const tokenizer = new Tokenizer(model as never);
		this.#deps.countTokens = (s) => tokenizer.countTokens(s);
		this.#deps.countSignatureTokens = signatureTokensOf(tokenizer);
		this.#deps.countMessages = (msgs) => tokenizer.countMessages(msgs);
		// The provider anchor belongs to the previous model's prompt accounting.
		this.#anchor = null;
		this.#lastProjection = null;
		this.#lastTotal = 0;
		this.#tokenMemo.clear();
		this.#zoneRenderTokens.clear();
		this.#applyWindow((model as { contextWindow?: number } | null | undefined)?.contextWindow ?? 0);
	}

	/** compress_context entry: mutex + full §6 validation sequence + execution. */
	compress(input: { keep?: string[]; summary?: string }): Promise<CompressOutcome | CompressRejection> {
		return this.runLocked(() => this.#validateAndExecute(input));
	}

	// Snapshot inside the lock (spec §4/§6), plan pure in acp-compress.ts,
	// apply the side effects here — validation order and mutex semantics
	// unchanged (T11 split).
	#validateAndExecute(input: { keep?: string[]; summary?: string }): CompressOutcome | CompressRejection {
		this.#syncRefs();
		const active = this.activeBlocks();
		// Zone size before the write: the projected-context delta needs both sides. A snapshot
		// number, not the array reference — a normal compression APPENDS to `this.zone`, so a
		// reference would already read the post-write length by the time the delta is built.
		const zoneBlocksBefore = this.zone.length;
		const zoneTokensBefore = this.#zoneTokens();
		// Anchored total of the current request (§5.1): the same number status() reports.
		const projectedTokensBefore = this.projectedTokenEstimate();
		const r = planCompression(
			{
				degraded: this.degraded,
				manifest: this.manifest,
				active,
				protectedIds: this.protectedZone(active),
				compressed: this.compressed,
				zone: this.zone,
				baseSummary: this.#baseSummary,
				zoneTokens: zoneTokensBefore,
				projectedTokens: projectedTokensBefore,
				zoneLimitTokens: this.#zoneLimitTokens,
				forcedExecution: this.#forcedExecution,
				params: this.params,
				countTokens: this.#deps.countTokens,
				resolve: (ref) => this.#refs.resolve(ref),
				label: (id) => this.#refs.label(id),
			},
			input,
		);
		if ("reject" in r) return r.reject;
		const plan = r.plan;
		// Stats telemetry rides the persisted meta. summaryTokens must be counted
		// before the write (the journal id does not exist yet): nextRef() predicts
		// the label the block is about to get, so the count matches the render.
		const meta = plan.payload.meta;
		meta.summaryTokens = this.#deps.countTokens(
			renderCompactionBlock(
				{ id: "", summary: plan.payload.summary, index: plan.payload.index, meta },
				() => this.#refs.nextRef(),
			),
		);
		if (this.#lastStatusTokens !== null) meta.statusTokens = this.#lastStatusTokens;
		meta.hints = this.#hintCount;
		const written = appendAcpSummary(this.#deps.sink, plan.payload);
		this.#hintCount = 0;
		this.#lastStatusTokens = null;
		// The fresh block sits at the journal tail: take its short ref now so the
		// outcome can name it the way the model will see it (spec §3 v10).
		const blockLabel = this.#refs.assign(written.id);
		if (plan.method === "strong") this.zone = [written];
		else this.zone.push(written);
		for (const id of plan.compressedIds) this.compressed.add(id);
		this.manifest!.consumed = true;
		this.#forcedExecution = false;
		if (plan.countedAsSuccess) {
			this.#successAt = this.#requestSeq;
			if (this.#forcedRoundDelivered) this.#forcedRoundSuccess = true;
			this.#forcedFailures = 0;
		}
		// Projected context after the write (spec §4): the anchored total moves by
		// the local change of the projection — folded active blocks out, the new
		// rendered zone block in (a strong reset charges the replaced zone too).
		const zoneTokensAfter = this.#zoneTokens();
		const projectedTokensAfter = Math.max(
			0,
			projectedTokensBefore + zoneTokensAfter + plan.activeTokensAfter - zoneTokensBefore - plan.activeTokensBefore,
		);
		const tierAfter = computeTier(projectedTokensAfter, this.params);
		// The same turn may call context_status next: publish the post-write total
		// immediately (anchored base + local delta), not on the next projection.
		this.#lastTotal = projectedTokensAfter;
		if (this.roundStatus) {
			const roundPlan = computeRoundPlan(projectedTokensAfter, this.params, {
				tokens: zoneTokensAfter,
				limitTokens: this.#zoneLimitTokens,
			});
			this.roundStatus = {
				...this.roundStatus,
				...roundPlan,
				zoneTokens: zoneTokensAfter,
				activeTokens: plan.activeTokensAfter,
				projectedTokens: projectedTokensAfter,
				activeBlocks: this.activeBlocks().length,
			};
		}
		return {
			ok: true,
			blockId: blockLabel,
			method: plan.method,
			compressed: { blocks: plan.compressedIds.length, tokens: plan.compressedTokens },
			kept: { blocks: plan.keep.length, tokens: plan.keepTokens },
			delta: {
				blocks: this.zone.length - zoneBlocksBefore - plan.compressedIds.length,
				tokens: projectedTokensAfter - projectedTokensBefore,
			},
			zoneBlocksFolded: plan.method === "strong" ? zoneBlocksBefore : 0,
			activeTokensAfter: plan.activeTokensAfter,
			projectedTokensAfter,
			tier: tierAfter,
			countedAsSuccess: plan.countedAsSuccess,
			...(plan.warning ? { warning: plan.warning } : {}),
		};
	}

}
