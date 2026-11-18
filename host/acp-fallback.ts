// ACP fallback after the L3 force ladder: the runtime stops forcing once three
// consecutive forced rounds fail, and the host owns recovery from the ACP
// projection. At a safe point it hands the base manual compaction an
// ACP-derived preparation (patched CompactOptions.preparation), so no base
// fallback can re-prepare from the raw journal or revive the auto chain.
import { type CompactionPreparation, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { SessionEntry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { CompactionSettings } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { createFileOps } from "@oh-my-pi/snapcompact";
import { ACP_VIEW_PSEUDO_PREFIX } from "./acp-refs.ts";
import type { AcpRuntimeState } from "./acp-runtime.ts";
import { safeStderr } from "./stderr.ts";

export type { AcpRuntimeState } from "./acp-runtime.ts";

/**
 * Build the base preparation from the ACP projection: the protected tail is
 * the keep boundary, everything the projection still sends before it is the
 * summarized prefix. Journal entries contribute ids only. Returns undefined
 * when no safe cut exists — callers must report that, never retry the raw
 * journal.
 */
export function buildAcpPreparation(
	state: AcpRuntimeState,
	branch: readonly SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	const active = state.activeZoneMessages(branch);
	if (!active || active.length === 0) return undefined;
	// Reuse the takeover guard set verbatim. Any pseudo id anywhere in the
	// active zone (not just at the cut) would leak a view-only message into the
	// summary or recentEntryIds; any id absent from the branch means the
	// snapshot is from an older branch.
	const pseudo = active.find((source) => source.id.startsWith(ACP_VIEW_PSEUDO_PREFIX));
	if (pseudo) return undefined;
	const branchPositions = new Map(branch.map((entry, index) => [entry.id, index]));
	const missing = active.find((source) => !branchPositions.has(source.id));
	if (missing) return undefined;
	const blocks = state.activeBlocks();
	const protectedIds = state.protectedZone(blocks);
	const protectedSources = new Set<string>();
	for (const block of blocks) if (protectedIds.has(block.id)) protectedSources.add(block.sourceId);
	let cutIndex = active.findIndex((source) => protectedSources.has(source.id));
	// No protected tail (tail params disabled): keep at least the latest user
	// turn, or nothing can be safely summarized.
	if (cutIndex < 0) cutIndex = active.findLastIndex((source) => source.message.role === "user");
	if (cutIndex <= 0) return undefined;
	// A projection-driven cut can land mid-turn (a compressed user block leaves
	// the assistant visible, or a result block leads its pair). Presenting that
	// as a non-split preparation would summarize half a turn, so the keep
	// boundary steps back to the nearest turn-start user and keeps the whole
	// turn instead. No user before the cut = no safe boundary: report it.
	while (cutIndex > 0 && active[cutIndex].message.role !== "user") cutIndex--;
	if (cutIndex <= 0 || active[cutIndex].message.role !== "user") return undefined;
	const firstKept = active[cutIndex];
	if (firstKept.id.startsWith(ACP_VIEW_PSEUDO_PREFIX)) return undefined;
	const cutPosition = branchPositions.get(firstKept.id);
	if (cutPosition === undefined) return undefined;
	// The takeover's overlap guard: a zone block whose folded ids land in the
	// retained tail would survive both as summary text and as original messages.
	const retainedIds = new Set(branch.slice(cutPosition).map((entry) => entry.id));
	const sourceByBlock = new Map(state.lastBlocks.map((block) => [block.id, block.sourceId]));
	for (const block of state.zone) {
		for (const id of block.meta.compressedIds) {
			if (retainedIds.has(id) || retainedIds.has(sourceByBlock.get(id) ?? "")) return undefined;
		}
	}
	const summarized = active.slice(0, cutIndex);
	const retained = active.slice(cutIndex);
	return {
		firstKeptEntryId: firstKept.id,
		messagesToSummarize: summarized.map((source) => source.message),
		turnPrefixMessages: [],
		recentMessages: retained.map((source) => source.message),
		recentEntryIds: retained.map((source) => source.id),
		lastSummarizedEntryId: active[cutIndex - 1]?.id,
		isSplitTurn: false,
		tokensBefore: state.projectedTokenEstimate(),
		previousSummary: state.zoneRenderText() || undefined,
		// The projection does not track file operations; an empty set is safer
		// than claiming files, and the summary prompt still carries the prefix.
		fileOps: createFileOps(),
		settings,
	};
}

export type AcpFallbackTrigger = "threshold" | "overflow";

/**
 * Whether the ACP fallback should compact now. The threshold reads the ACP
 * projection (`projectedTokenEstimate`: non-message + calibrated active +
 * rendered zone) and the base's own `resolveThresholdTokens`, with the base's
 * strict `>` comparison — never a raw stored-history floor.
 */
export function acpFallbackTrigger(
	state: AcpRuntimeState,
	model: Model,
	settings: CompactionSettings,
	assistant?: AssistantMessage,
): AcpFallbackTrigger | undefined {
	const contextWindow = model.contextWindow ?? 0;
	if (assistant && AIError.isContextOverflow(assistant, contextWindow)) return "overflow";
	const threshold = resolveThresholdTokens(contextWindow, settings);
	if (threshold <= 0) return undefined;
	return state.projectedTokenEstimate() > threshold ? "threshold" : undefined;
}

/** Host-visible subset of the base's CompactOptions (the manual paths use these). */
export interface AcpCompactionOptions {
	preparation?: CompactionPreparation;
	suppressContinuation?: boolean;
	internalGuidance?: string;
}

/** Minimal session surface the supervisor drives (AgentSession fits structurally). */
export interface AcpFallbackSession {
	readonly isCompacting: boolean;
	readonly model: Model | undefined;
	readonly settings: Settings;
	readonly sessionManager: { getBranch(): SessionEntry[] };
	compact(instructions?: string, options?: AcpCompactionOptions): Promise<unknown>;
}

/**
 * Route a host-initiated manual compaction through the ACP preparation when the
 * session is ACP-owned; sessions without the runtime keep the base default.
 * In ACP mode every raw-journal preparation is refused: a degraded runtime has
 * no projection snapshot, and focus/internal guidance cannot be honored once
 * the base never prepares from the journal. `degraded` and `undefined` state
 * are the two explicit rejection reasons.
 */
export async function compactSessionWithAcp(
	state: AcpRuntimeState | undefined,
	session: AcpFallbackSession,
	options: { instructions?: string; internalGuidance?: string; suppressContinuation?: boolean } = {},
): Promise<unknown> {
	if (!state) return session.compact(options.instructions, options);
	if (state.degraded) {
		throw new Error(
			"ACP is degraded for this session; manual compaction cannot prepare from the raw journal and was refused.",
		);
	}
	const model = session.model;
	if (!model) throw new Error("No model selected");
	const settings = resolveModelCompactionSettings(session.settings, model);
	const preparation = buildAcpPreparation(state, session.sessionManager.getBranch(), settings);
	if (!preparation) {
		throw new Error(
			"ACP preparation is unavailable (projection snapshot or a safe turn-start cut is missing); manual compaction was refused.",
		);
	}
	// The takeover hook appends `event.customInstructions` to its summary prompt
	// and the base's own fallbacks consume the same public field, so plan-mode
	// internal guidance rides it too: both ACP and base reach the same directive.
	return session.compact(options.instructions ?? options.internalGuidance, {
		preparation,
		suppressContinuation: options.suppressContinuation,
	});
}

export interface AcpFallbackSupervisor {
	/** Safe-point check (turn end). No-op outside fallback or while a run is in flight. */
	check(assistant?: AssistantMessage): void;
	/** Await the in-flight run (tests / orderly shutdown). */
	idle(): Promise<void>;
}

/**
 * One guarded fallback run per safe point. A failed run records the error and
 * blocks a retry on the same history (no tight loop); success clears the
 * runtime's fallback and resyncs the ACP baseline onto the committed boundary.
 */
export function createAcpFallbackSupervisor(deps: {
	state: AcpRuntimeState;
	session: AcpFallbackSession;
}): AcpFallbackSupervisor {
	let run: Promise<void> | undefined;
	const start = (assistant: AssistantMessage | undefined): Promise<void> => {
		const task = Promise.resolve()
			.then(async () => {
				const { state, session } = deps;
				if (!state.fallbackActive() || !state.fallbackAttemptAllowed() || session.isCompacting) return;
				const model = session.model;
				if (!model) return;
				const settings = resolveModelCompactionSettings(session.settings, model);
				if (!acpFallbackTrigger(state, model, settings, assistant)) return;
				const preparation = buildAcpPreparation(state, session.sessionManager.getBranch(), settings);
				if (!preparation) {
					state.onFallbackCompactionFailed(
						"ACP preparation is unavailable (projection snapshot or a safe cut is missing)",
					);
					return;
				}
				try {
					await session.compact(undefined, { preparation });
				} catch (err) {
					state.onFallbackCompactionFailed(err instanceof Error ? err.message : String(err), err);
					return;
				}
				state.onFallbackCompactionSucceeded();
				state.resyncToBranch(session.sessionManager.getBranch());
				safeStderr("[ACP] fallback compaction committed; leaving fallback");
			})
			.catch((err: unknown) => {
				deps.state.onFallbackCompactionFailed(err instanceof Error ? err.message : String(err), err);
			})
			.finally(() => {
				if (run === task) run = undefined;
			});
		return task;
	};
	return {
		check(assistant?: AssistantMessage): void {
			const { state, session } = deps;
			if (run || !state.fallbackActive() || !state.fallbackAttemptAllowed() || session.isCompacting) return;
			const model = session.model;
			if (!model) return;
			const settings = resolveModelCompactionSettings(session.settings, model);
			if (!acpFallbackTrigger(state, model, settings, assistant)) return;
			run = start(assistant);
			void run;
		},
		async idle(): Promise<void> {
			await run;
		},
	};
}
