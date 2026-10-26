// ACP assembly layer (split out of acp-runtime.ts for the host file-size
// gate; pure refactor, T11): the runtime factory bound to the session model's
// Tokenizer, the compress_context tool definition, and the request projection
// extension that session-lifecycle wires into the agent session (spec §8/§9).
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { base64ImageSize } from "@oh-my-pi/pi-agent-core/image-tokens";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AcpParams } from "./acp-plan.ts";
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
	/** §5.3 degrade hook: restore the base compaction chain on the settings child. */
	onDegrade?: (reason: string) => void;
}): AcpRuntimeState {
	const tokenizer = new Tokenizer(opts.model as never);
	return new AcpRuntimeState({
		countTokens: (s) => tokenizer.countTokens(s),
		// Same image price the base countMessage charges (pixel size under the
		// reader's catalog rule), so block tokens and the base context counter
		// disagree only by real content, never by an uncounted image.
		countImage: (image) => tokenizer.imageTokens(base64ImageSize(image.data), image.detail),
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


/**
 * Request projection extension: hooks the context event and replaces the view
 * with the dual-zone projection. A projection failure must never blow up the
 * request — the original view passes through (same stance the retired nudge
 * prototype's transform took).
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
		on: (
			event: "context",
			handler: (
				ev: { messages: AgentMessage[] },
				ctx: { sessionManager: { getSessionId(): string } },
			) => { messages: AgentMessage[] },
		) => void;
	}): void => {
		pi.on("context", (ev, ctx) => {
			if (ctx.sessionManager.getSessionId() !== ownerSessionId()) {
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
