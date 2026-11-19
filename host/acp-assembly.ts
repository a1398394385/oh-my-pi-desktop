// ACP assembly layer (split out of acp-runtime.ts for the host file-size
// gate; pure refactor, T11): the runtime factory bound to the session model's
// Tokenizer, the compress_context tool definition, and the request projection
// extension that session-lifecycle wires into the agent session (spec §8/§9).
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { base64ImageSize, type ImageSize } from "@oh-my-pi/pi-agent-core/image-tokens";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { takeoverBaseCompaction, type AcpBaseTakeoverDeps } from "./acp-base-takeover.ts";
import { BlobStore, resolveImageDataSync } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import type { AcpParams } from "./acp-plan.ts";
import { signatureTokensOf } from "./acp-projection.ts";
import type { AcpSummarySink } from "./acp-persist.ts";
import { AcpRuntimeState } from "./acp-runtime.ts";

/**
 * Proactive-compression guidance appended to ACP sessions' system prompts via
 * createAgentSession({ appendSystemPrompt }) (appended verbatim; the SDK's
 * "## User Instructions" heading appears only when the SDK has its own append
 * sections to pair it with — composeAppendPrompt). Motivation: below L1 the model owns the compression timing
 * (spec §7 zero tier) and tool descriptions alone rarely trigger it — desktop
 * usage data (2026-10-17) shows 2/14 spontaneous compressions vs 12/14 only
 * responding to the milestone hint. Wire this only when the ACP tools exist:
 * the text names context_status/compress_context by name. L3/forced stays
 * non-deferrable. Voluntary checks gate only closure and safe preservation;
 * requiring discovery or a unique next step would create an L2 stall. Large
 * early exploration belongs to subagents, so those transitions are not
 * compression triggers by themselves.
 */
export const ACP_CONTEXT_BUDGET_PROMPT = `Context budget (ACP): follow these rules in priority order.

A final notice (L3) or a host-enforced forced round requires compression before other work. The voluntary checks below must not defer it. On a forced round, use the supplied manifest; the host blocks context_status and every other non-compress tool.

Otherwise, consider compression at a settled work boundary when accumulated settled or redundant history is worth folding. This is not an obligation after every step. An exploration-to-implementation transition, plan approval, pre-implementation review, or a subagent result alone is not a compression trigger.

For voluntary compression at L1 or L2, ground these safety checks in observed results and the latest user requirements. Do not print a checklist:
- CLOSED: the current bounded step, including its required immediate validation, has an observed outcome. An edit completing does not mean it was verified; a failed validation can be an outcome. Any command or subagent result needed to close this step must have arrived; a background job handle is not its final result. A user-requested pause or handoff is also a boundary: preserve any unverified state explicitly.
- SAFE: choose blocks individually from the current manifest. Fold blocks whose needed state can be recorded accurately; keep blocks that still require verbatim content. Preserve the latest requirements and decisions, exact errors, rejected approaches, unresolved branches, partial edits, and cross-file constraints. Keep only listed bN ids; do not list protected-tail or exempt blocks.

Lack of a new discovery or a unique solution is not itself a reason to defer compression. Repeated failures may be folded when their negative results and rejected approaches survive.

At an eligible boundary, call context_status for the current scope, or use its latest unconsumed result. If it reports that context is below the activation line, continue without compress_context; do not query again merely because another small step ended. Recheck after substantial history growth or a new pressure hint.

Use the existing three-part summary: established findings, workspace state, and remaining actions. Cover every listed block not kept. Remaining actions must name a concrete next action or the diagnostic, decision, or pending result needed to proceed; update them after user steering. A unique solution is not required. For strong compression, also carry forward still-needed information from the old compression-zone summaries being replaced. Keep unresolved issues consistent with the remaining actions.

Respect the target and summary-budget limits. Do not discard required state just to fit. A normal compression must fold at least one listed block; strong compression may instead rewrite an existing compression zone. If no safe, feasible submission exists, follow the tier's continuation rule rather than submitting a known-invalid call.`;

/** Build a runtime bound to the session model's Tokenizer (spec §8). */
export function createAcpRuntime(opts: {
	model: unknown;
	sink: AcpSummarySink;
	getEntries: () => readonly SessionEntry[];
	getBranch?: () => readonly SessionEntry[];
	params?: Partial<AcpParams>;
	/** Full param re-derivation for a context window (percent tier lines); see AcpRuntimeDeps.resolveParams. */
	resolveParams?: (contextWindow: number) => AcpParams;
	/** Non-message request part (system prompt + tools + skills + context); see AcpRuntimeDeps.nonMessageTokens. */
	nonMessageTokens?: () => number;
	/** §5.3 degrade hook: fired once when ACP exits this session (observability; no settings write-back). */
	onDegrade?: (reason: string) => void;
}): AcpRuntimeState {
	const tokenizer = new Tokenizer(opts.model as never);
	const blobs = new BlobStore(getBlobsDir());
	const imageSizes = new Map<string, ImageSize | null>();
	return new AcpRuntimeState({
		countTokens: (s) => tokenizer.countTokens(s),
		// Block prices follow the catalog's thinking-replay axis (step: kimi `none`
		// bills no signature); the base counter owns that decision, so the block
		// takes its increment instead of a host-side provider table.
		countSignatureTokens: signatureTokensOf(tokenizer),
		// Local side of the provider anchor arithmetic: one counter over the whole projected list.
		countMessages: (msgs) => tokenizer.countMessages(msgs),
		// Persistence replaces image bytes with blob refs; measuring the ref itself
		// would charge the unknown-size maximum instead of the actual pixel cost.
		countImage: (image) => {
			let size = imageSizes.get(image.data);
			if (size === undefined) {
				size = base64ImageSize(resolveImageDataSync(blobs, image.data));
				imageSizes.set(image.data, size);
			}
			return tokenizer.imageTokens(size, image.detail);
		},
		sink: opts.sink,
		getEntries: opts.getEntries,
		getBranch: opts.getBranch,
		// Zone line axis of the §5.2 table: window × 35% (§11); unknown window = no limit.
		contextWindow: (opts.model as { contextWindow?: number } | null | undefined)?.contextWindow ?? 0,
		nonMessageTokens: opts.nonMessageTokens,
		params: opts.params,
		resolveParams: opts.resolveParams,
		onDegrade: opts.onDegrade,
	});
}

// ---- tool + extension -----------------------------------------------------------

const COMPRESS_CONTEXT_DESCRIPTION = `Compress old conversation blocks into a summary (context management).

Call context_status first: its manifest lists this round's compressible blocks as bN short ids (largest first). Then call with:
- keep: the bN short ids from that manifest that must stay in the context verbatim (recent/important ones).
- summary: a working-state summary of every listed block NOT kept, structured in three parts:
  1. established findings: conclusions, root causes, exact file paths/values/decisions that later work depends on;
  2. workspace state: files changed so far, tests run and their results, environment facts;
  3. remaining actions: what is still to be done, starting with your concrete next step.
  Unresolved issues recorded in the summary must be consistent with the remaining actions — never state an open problem and then propose to finish (summary self-consistency).

One successful compress consumes the manifest — call context_status again for the next round. Compressed blocks leave the context and are represented by a persistent summary; details folded into a summary are gone from the context, so record what later work depends on (paths, values, decisions) in the summary text itself. The protected tail and blocks outside the manifest are never compressed — do not list them in keep. A good habit: check context_status and compress after finishing a stage of work, before the context grows large.`;

/** compress_context ToolDefinition (registered via createAgentSession({ customTools })). */
export function createCompressContextTool(state: AcpRuntimeState) {
	return {
		name: "compress_context",
		label: "Compress Context",
		description: COMPRESS_CONTEXT_DESCRIPTION,
		parameters: type({
			keep: type.array(type("string")).describe("bN short ids from the current context_status manifest to keep verbatim."),
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


/** Session identity the owner-only handlers judge against (the extension context's slice). */
type AcpExtensionCtx = { sessionManager: { getSessionId(): string } };

/**
 * Request projection extension: hooks the context event and replaces the view
 * with the dual-zone projection, and takes over base compaction summarization
 * for the owning session. A projection failure never returns the raw journal
 * view: ACP degrades explicitly and the request throws, because a raw view
 * would dump the history the projection was meant to own. Takeover failures
 * return undefined so the caller's injected preparation (or the base default
 * for non-ACP manual compaction) handles the summary.
 *
 * Owner-only. This factory is registered as an inline extension, and the SDK
 * deliberately rebinds inline factories into child sessions (sdk.ts preparedExtensions
 * → task/structured-subagent.ts preloadedPreparedExtensions → bindExtension), so this
 * closure also fires for a `task` subagent or `/tan` child. `state` holds the OWNER's
 * journal, compaction zone and compressed-id set, and projectView prints that zone
 * unconditionally (acp-projection.ts:226) — projecting a child view through it would
 * inject the parent's compressed blocks as synthetic user turns, i.e. tell the child it
 * did work it never did. Session identity is the only reliable discriminator (the view
 * itself can't be used: a child may fingerprint-match a parent message), so anything but
 * the owning session passes through untouched.
 *
 * `ownerSessionId` is a getter, not a captured string: SessionManager re-mints its id on
 * fork/switch (session-manager.ts #sessionId), and both sides must move together or a
 * switched owner would stop recognizing itself.
 */
export function createAcpProjectionExtension(
	state: AcpRuntimeState,
	ownerSessionId: () => string,
	base?: Omit<AcpBaseTakeoverDeps, "state">,
) {
	return (pi: {
		on(
			event: "context",
			handler: (ev: { messages: AgentMessage[] }, ctx: AcpExtensionCtx) => { messages: AgentMessage[] },
		): void;
		on(event: "auto_compaction_start", handler: (ev: { reason: string }, ctx: AcpExtensionCtx) => void): void;
		on(event: "auto_compaction_end", handler: () => void): void;
		on(event: "session_compact", handler: (ev: unknown, ctx: AcpExtensionCtx) => void): void;
		on(
			event: "tool_call",
			handler: (
				ev: { toolName: string },
				ctx: AcpExtensionCtx,
			) => { block?: boolean; reason?: string } | undefined | void,
		): void;
		on(
			event: "session_before_compact",
			handler: (
				ev: SessionBeforeCompactEvent,
				ctx: AcpExtensionCtx,
			) => Promise<SessionBeforeCompactResult | undefined> | SessionBeforeCompactResult | undefined,
		): void;
	}): void => {
		const isOwner = (ctx: AcpExtensionCtx): boolean =>
			ctx.sessionManager.getSessionId() === ownerSessionId();
		let ownerCompacting = false;
		pi.on("auto_compaction_start", (_ev, ctx) => {
			if (isOwner(ctx)) ownerCompacting = true;
		});
		pi.on("auto_compaction_end", () => {
			if (!ownerCompacting) return;
			ownerCompacting = false;
			state.resyncToBranch();
		});
		pi.on("session_compact", (_ev, ctx) => {
			if (isOwner(ctx)) state.resyncToBranch();
		});
		pi.on("session_before_compact", (ev, ctx) => {
			if (!base || !isOwner(ctx)) return undefined;
			return takeoverBaseCompaction(ev, { ...base, state });
		});
		// Level-3 forced round: keep the provider tool list unchanged. The owner-only
		// gate below rejects every tool call except compress_context with corrective text.
		pi.on("tool_call", (ev, ctx) => {
			if (!isOwner(ctx) || ev.toolName === "compress_context" || !state.forcedRoundActive()) return undefined;
			return {
				block: true,
				reason: "Level-3 forced round: only compress_context is allowed on this turn. Call compress_context now with keep (bN short ids from the manifest in the context_status return above) and a summary covering every block you are not keeping.",
			};
		});
		pi.on("context", (ev, ctx) => {
			if (!isOwner(ctx)) {
				return { messages: ev.messages };
			}
			try {
				return { messages: state.projectView(ev.messages) };
			} catch (err) {
				// projectContext self-repairs source-view pairing gaps, so reaching
				// here means an unexpected defect. ACP cannot manage context without
				// its projection, and an ACP-owned request must never silently fall
				// back to the raw journal view: exit explicitly (the base auto chain
				// stays pinned off) and fail the request with the cause.
				state.degrade(
					`projection failed: ${err instanceof Error ? err.message : String(err)}`,
					err,
				);
				throw err;
			}
		});
	};
}
