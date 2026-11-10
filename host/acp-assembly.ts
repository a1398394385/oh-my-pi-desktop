// ACP assembly layer (split out of acp-runtime.ts for the host file-size
// gate; pure refactor, T11): the runtime factory bound to the session model's
// Tokenizer, the compress_context tool definition, and the request projection
// extension that session-lifecycle wires into the agent session (spec §8/§9).
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { base64ImageSize, type ImageSize } from "@oh-my-pi/pi-agent-core/image-tokens";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { BlobStore, resolveImageDataSync } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import type { AcpParams } from "./acp-plan.ts";
import { signatureTokensOf } from "./acp-projection.ts";
import type { AcpSummarySink } from "./acp-persist.ts";
import { AcpRuntimeState } from "./acp-runtime.ts";
import { safeStderr } from "./stderr.ts";

/**
 * Proactive-compression guidance appended to ACP sessions' system prompts via
 * createAgentSession({ appendSystemPrompt }) (appended verbatim; the SDK's
 * "## User Instructions" heading appears only when the SDK has its own append
 * sections to pair it with — composeAppendPrompt). Motivation: below L1 the model owns the compression timing
 * (spec §7 zero tier) and tool descriptions alone rarely trigger it — desktop
 * usage data (2026-10-17) shows 2/14 spontaneous compressions vs 12/14 only
 * responding to the milestone hint. Wire this only when the ACP tools exist:
 * the text names context_status/compress_context by name.
 */
export const ACP_CONTEXT_BUDGET_PROMPT = `Context budget (ACP): when you finish a stage of work — a subtask completed, an investigation concluded, a plan approved — call context_status and fold settled blocks with compress_context before starting the next stage. Do not wait for a pressure reminder; keep recent and still-referenced blocks verbatim, summarize everything else. When a context-pressure status line appears in the conversation, respond in the same turn: context_status, then compress_context.`;

/** Build a runtime bound to the session model's Tokenizer (spec §8). */
export function createAcpRuntime(opts: {
	model: unknown;
	sink: AcpSummarySink;
	getEntries: () => readonly SessionEntry[];
	params?: Partial<AcpParams>;
	/** Level-3 force channel (spec §5.2/§10): arms tool_choice on the live session. */
	forceCompressTool?: () => void;
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
		// Drift calibration basis: the same counter over the whole projected list.
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
		// Zone line axis of the §5.2 table: window × 35% (§11); unknown window = no limit.
		contextWindow: (opts.model as { contextWindow?: number } | null | undefined)?.contextWindow ?? 0,
		params: opts.params,
		forceCompressTool: opts.forceCompressTool,
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
 * with the dual-zone projection, and keeps the base compaction chain off this
 * session's journal (automatic threshold/idle runs are cancelled) while leaving
 * real overflow/incomplete recoveries through after degrading ACP first. A
 * projection failure must never blow up the request — the original view passes
 * through (same stance the retired nudge prototype's transform took).
 *
 * Why the cancellation lives here instead of a settings pin: `compaction.enabled`
 * is a settings-tree read, and a subagent session is a derived overlay of the
 * parent's settings (task/executor.ts createSubagentSettings), so pinning it off
 * on the ACP session's settings also disabled base compaction inside every
 * `task` subagent of that session — which ACP does not cover at all (no tools,
 * no projection). Base compaction and ACP must only exclude each other on the
 * same journal, i.e. per session until base folds it (spec §5.3).
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
export function createAcpProjectionExtension(state: AcpRuntimeState, ownerSessionId: () => string) {
	return (pi: {
		on(
			event: "context",
			handler: (ev: { messages: AgentMessage[] }, ctx: AcpExtensionCtx) => { messages: AgentMessage[] },
		): void;
		on(event: "auto_compaction_start", handler: (ev: { reason: string }, ctx: AcpExtensionCtx) => void): void;
		on(event: "auto_compaction_end", handler: () => void): void;
		on(
			event: "session_before_compact",
			handler: (ev: unknown, ctx: AcpExtensionCtx) => { cancel: true } | undefined,
		): void;
	}): void => {
		const isOwner = (ctx: AcpExtensionCtx): boolean =>
			ctx.sessionManager.getSessionId() === ownerSessionId();
		// Set by the auto_compaction_start of THIS session's run (the event carries
		// the reason; session_before_compact does not), so a manual /compact — which
		// is the operator asking for the base chain — is never cancelled.
		let cancelAutomatic = false;
		pi.on("auto_compaction_start", (ev, ctx) => {
			if (!isOwner(ctx)) return;
			cancelAutomatic = ev.reason === "threshold" || ev.reason === "idle";
			// Overflow/incomplete recovery is the base chain's last resort: ACP exits
			// first so the fold it commits cannot land behind a live ACP zone
			// (spec §5.3). Without this ordering the request would keep failing while
			// the projection still claimed the context fit.
			if (!cancelAutomatic) state.degrade(`base ${ev.reason} compaction taking over (spec §5.3)`);
		});
		pi.on("auto_compaction_end", () => {
			cancelAutomatic = false;
		});
		pi.on("session_before_compact", (_ev, ctx) => {
			if (!cancelAutomatic || !isOwner(ctx)) return undefined;
			cancelAutomatic = false;
			return { cancel: true };
		});
		pi.on("context", (ev, ctx) => {
			if (!isOwner(ctx)) {
				return { messages: ev.messages };
			}
			try {
				return { messages: state.projectView(ev.messages) };
			} catch (err) {
				// projectContext self-repairs source-view pairing gaps, so reaching
				// here means an unexpected defect; passing the original view through
				// keeps the session usable (the provider layer re-pairs the wire).
				safeStderr(`[ACP] projection failed, passing the original view through:`, err);
				return { messages: ev.messages };
			}
		});
	};
}
