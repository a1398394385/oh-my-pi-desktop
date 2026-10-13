// ACP assembly layer (split out of acp-runtime.ts for the host file-size
// gate; pure refactor, T11): the runtime factory bound to the session model's
// Tokenizer, the compress_context tool definition, and the request projection
// extension that session-lifecycle wires into the agent session (spec §8/§9).
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AcpParams } from "./acp-plan.ts";
import type { AcpSummarySink } from "./acp-persist.ts";
import { AcpRuntimeState } from "./acp-runtime.ts";
import { safeStderr } from "./stderr.ts";

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
- summary: a working-state summary of every listed block NOT kept, structured in three parts:
  1. established findings: conclusions, root causes, exact file paths/values/decisions that later work depends on;
  2. workspace state: files changed so far, tests run and their results, environment facts;
  3. remaining actions: what is still to be done, starting with your concrete next step.
  Unresolved issues recorded in the summary must be consistent with the remaining actions — never state an open problem and then propose to finish (summary self-consistency).

One successful compress consumes the manifest — call acp_status again for the next round. Compressed blocks leave the context and are represented by a persistent summary with a per-block index; recall_block can fetch any of them back later. The protected tail and blocks outside the manifest are never compressed — do not list them in keep. A good habit: check acp_status and compress after finishing a stage of work, before the context grows large.`;

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
 * request — the original view passes through (same stance the retired nudge
 * prototype's transform took).
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
