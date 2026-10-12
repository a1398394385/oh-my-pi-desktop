// recall_block ToolDefinition + rendering (spec §6, ticket T5).
//
// Split out of acp-runtime.ts for the host file-size gate. The dispatch logic
// (four id classes: normal block / compaction block / superseded compaction
// block / unknown) lives on AcpRuntimeState.recall; this module owns the
// tool surface, the payload rendering, and the base truncation pipeline hookup.
import { type } from "@oh-my-pi/omptype";
import type { AcpBlockInfo, AcpSourceMessage } from "./acp-projection.ts";
import { flattenText } from "./acp-projection.ts";
import type { AcpSummaryData } from "./acp-persist.ts";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";

/** Structural dependency: any runtime exposing recall() (AcpRuntimeState; no import cycle). */
interface RecallHost {
	recall(id: unknown): RecallOutcome;
}

export type RecallOutcome = { ok: true; text: string } | { ok: false; error: string };

/** Full-index render for recall — the §11 4K budget exists only in the zone render, never here. */
export function renderFullIndex(b: AcpSummaryData): string {
	return [
		`[acp-recall id=${b.id} compaction block depth=${b.meta.depth} method=${b.meta.method} folded=${b.meta.compressedIds.length}]`,
		b.summary,
		"Full index:",
		...b.index.map((l) => `${l.id} | ${l.tokens} | ${l.intent}`),
	].join("\n");
}

/** Original journal content of one message block (spec §6); tool pairs render call + result together. */
export function renderNormalBlock(block: AcpBlockInfo, source: readonly AcpSourceMessage[]): string {
	const header = `[acp-recall id=${block.id} kind=${block.kind} tokens=${block.tokens}]`;
	if (block.kind === "result") {
		let call = "(tool call not found)";
		for (const { message } of source) {
			if (message.role !== "assistant") continue;
			for (const c of message.content) {
				if (c.type === "toolCall" && c.id === block.toolCallId) call = `${c.name}(${JSON.stringify(c.arguments ?? {})})`;
			}
		}
		const text = flattenText(source.find((s) => s.id === block.id)?.message.content);
		return `${header}\ntool call: ${call}\ntool result:\n${text}`;
	}
	const message = source.find((s) => s.id === block.sourceId)?.message;
	if (message?.role === "assistant") {
		const parts = message.content.filter((c) =>
			block.kind === "thinking" ? c.type === "thinking" || c.type === "redactedThinking" : c.type === "text",
		);
		return `${header}\n${flattenText(parts)}`;
	}
	return `${header}\n${flattenText(message?.content)}`;
}

const RECALL_BLOCK_DESCRIPTION = `Fetch a block back from the compaction zone (context management).

Call with the id shown in a summary index line or the round manifest:
- A message-block id returns the original content from the journal (a tool pair comes back as call + result together). The recalled content is a normal new block with no exemption — later compression rounds treat it like any other.
- A compaction-block id returns that block's FULL index (the rendered index truncates at 4096 tokens; this bypasses it).
- A superseded compaction block redirects to the newest strong block's full index.`;

/** recall_block ToolDefinition (spec §6, registered next to compress_context). */
export function createRecallBlockTool(state: RecallHost) {
	return {
		name: "recall_block",
		label: "Recall Block",
		description: RECALL_BLOCK_DESCRIPTION,
		parameters: type({
			id: type("string").describe("Block id to fetch back (index-line id or compaction-block id)."),
		}),
		loadMode: "essential" as const,
		approval: "write" as const,
		execute: async (
			_id: string,
			params: { id?: string },
			_signal: undefined,
			_onUpdate: unknown,
			ctx?: { allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }> },
		) => {
			const out = state.recall(params?.id);
			if (!out.ok) return { content: [{ type: "text", text: out.error }], isError: true };
			// Large results ride the base truncation pipeline (spec §6): cap the
			// inline text and spill the full version to an artifact the model reads
			// back in segments — recall itself never truncates. The pipeline is
			// opt-in per tool (agent-loop applies no automatic cap), reached via the
			// same ToolSession ctx every tool — customTools included — receives.
			let text = out.text;
			const allocate = ctx?.allocateOutputArtifact;
			if (typeof allocate === "function") {
				text = await enforceInlineByteCap(text, {
					saveArtifact: async full => {
						const { id, path } = (await allocate("recall_block")) ?? {};
						if (!id || !path) return undefined;
						await Bun.write(path, full);
						return id;
					},
				});
			}
			return { content: [{ type: "text", text }] };
		},
	};
}
