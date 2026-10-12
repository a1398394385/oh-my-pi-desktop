// ACP block model + projection core (spec §3/§4): pure functions, no session wiring.
//
// The storage layer stays untouched (base SessionEntry per entry, one UUID each).
// Logical blocks are derived on demand from the message view the host assembles:
//   user / bashExecution / hookMessage ... -> 1 block (id = entry id)
//   assistant -> optional thinking block `entryId#t` + optional text block `entryId#x`
//                tool pairs are NOT assistant blocks: the tool_use body belongs to
//                the pair, and the pair's block id is the result entry's id
//   acpSummary custom entry -> compaction-zone member, rendered by the projection
//
// Projection = compression zone (rendered user text segments) + active zone
// (block-level filtered omp-domain messages). Wire-shape reassembly (Anthropic
// aggregation / OpenAI multi-message) is done by the base provider layer; the
// host only filters inside the domain, then asserts the tool_use/result pairing
// invariant (P1 probe V4 proved the server enforces it with a 400, so a broken
// projection must fail loudly here rather than at the API).
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-agent-core";
import { messageFingerprint } from "./acp-state.ts";

/** Token counter bound to the active model's Tokenizer (byte-estimate fallback is built in). */
export type CountTokens = (text: string) => number;

/** One journaled message plus the id of the entry that stored it (the block id namespace). */
export interface AcpSourceMessage {
	id: string;
	message: AgentMessage;
}

export type AcpBlockKind = "user" | "result" | "thinking" | "text";

/** A logical block: the unit the compression manifest talks about (spec §3). */
export interface AcpBlockInfo {
	id: string;
	kind: AcpBlockKind;
	/** Entry id the block was derived from. */
	sourceId: string;
	/** Set for kind "result": pairs this block with the tool_use of the same call id. */
	toolCallId?: string;
	/** Token size (post-prune value, per spec §4 prune note). */
	tokens: number;
	/** Short intent line for manifest/index rendering. */
	intent: string;
}

/** Index line of a compaction block (spec §9 `index: [{ id, tokens, intent }]`). */
export interface AcpIndexLine {
	id: string;
	tokens: number;
	intent: string;
}

/** Compaction block payload, mirroring the persisted acpSummary custom-entry `data` (spec §9). */
export interface AcpCompactionBlock {
	/** The acpSummary entry's own id (recall target). */
	id: string;
	summary: string;
	index: AcpIndexLine[];
	meta: {
		createdAt: number;
		depth: number;
		method: "normal" | "strong";
		/** Ids of superseded compaction blocks; those drop out of the rendered zone. */
		supersedes?: string[];
	};
}

/** Rendered index zone stays under this many tokens; overflow drops the oldest segments (spec §11). */
export const ACP_INDEX_RENDER_BUDGET = 4096;

function truncIntent(s: string, n = 100): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export function flattenText(content: string | readonly unknown[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c): string => {
			if (!c || typeof c !== "object") return "";
			if (c.type === "text") return c.text;
			if (c.type === "thinking") return c.thinking;
			return "";
		})
		.join("");
}

/**
 * Split a source message view into logical blocks (spec §3). Deterministic and
 * side-effect free; block ids derive only from entry ids, so a manifest built
 * from an earlier split stays valid as long as the entry ids survive.
 *
 * `memo` caches block token counts keyed by message fingerprint + block
 * suffix + text length (spec §8: the base WeakMap memo misses every round on
 * the context event's fresh copies, so the host keeps its own Map). The length
 * term is what catches prune rewrites that a head-only fingerprint would miss.
 */
export function splitBlocks(
	source: readonly AcpSourceMessage[],
	countTokens: CountTokens,
	memo?: Map<string, number>,
): AcpBlockInfo[] {
	const blocks: AcpBlockInfo[] = [];
	for (const { id, message } of source) {
		// Memo key basis: fingerprint identifies the message, suffix separates
		// the #t/#x blocks of one assistant message, length detects rewrites.
		const fp = memo ? messageFingerprint(message) : "";
		const count = (text: string, suffix = ""): number => {
			if (!memo) return countTokens(text);
			const key = `${fp}|${suffix}|${text.length}`;
			let n = memo.get(key);
			if (n === undefined) {
				n = countTokens(text);
				memo.set(key, n);
			}
			return n;
		};
		if (message.role === "user" || message.role === "developer") {
			const text = flattenText(message.content);
			blocks.push({ id, kind: "user", sourceId: id, tokens: count(text), intent: truncIntent(text) });
		} else if (message.role === "toolResult") {
			const text = flattenText(message.content);
			blocks.push({
				id,
				kind: "result",
				sourceId: id,
				toolCallId: message.toolCallId,
				tokens: count(text),
				intent: truncIntent(`${message.toolName}: ${text}`),
			});
		} else if (message.role === "assistant") {
			let thinking = "";
			let text = "";
			// tool_use bodies ride with their result block, never split into their own.
			for (const c of message.content) {
				if (c.type === "thinking" || c.type === "redactedThinking")
					thinking += c.type === "thinking" ? c.thinking : c.data;
				else if (c.type === "text") text += c.text;
			}
			if (thinking)
				blocks.push({
					id: `${id}#t`,
					kind: "thinking",
					sourceId: id,
					tokens: count(thinking, "t"),
					intent: truncIntent(thinking),
				});
			if (text)
				blocks.push({ id: `${id}#x`, kind: "text", sourceId: id, tokens: count(text, "x"), intent: truncIntent(text) });
		}
		// Custom agent messages and anything else are not compression candidates; skip.
	}
	return blocks;
}

/** Render one compaction block as its user-role text segment (spec §4.1). */
export function renderCompactionBlock(b: AcpCompactionBlock, countTokens: CountTokens): string {
	const header =
		`[acp-summary id=${b.id} time=${new Date(b.meta.createdAt).toISOString()} ` +
		`depth=${b.meta.depth} blocks=${b.index.length} method=${b.meta.method}]`;
	const lines = b.index.map((l) => `${l.id} | ${l.tokens} | ${l.intent}`);
	const render = (ls: readonly string[], trailer?: string): string =>
		[header, b.summary, "Index:", ...ls, ...(trailer ? [trailer] : [])].join("\n");
	let out = render(lines);
	if (countTokens(out) <= ACP_INDEX_RENDER_BUDGET) return out;
	// Over budget: drop the oldest segments (index lines are chronological) and
	// point the model at recall_block for the full index (spec §11).
	let kept = lines.length;
	const trailer = () => `… ${lines.length - kept} more, recall_block(${b.id}) 取完整索引`;
	while (kept > 0 && countTokens(render(lines.slice(lines.length - kept), trailer())) > ACP_INDEX_RENDER_BUDGET) kept--;
	return render(lines.slice(lines.length - kept), trailer());
}

/**
 * Assert the tool_use/result pairing invariant on a projected message sequence
 * (spec §3/§4.3). `exemptUseIds` marks tool_use blocks that never had a result
 * in the source (unfinished turn — they cannot enter the compression manifest).
 */
export function assertToolPairing(messages: readonly AgentMessage[], exemptUseIds?: ReadonlySet<string>): void {
	const uses = new Set<string>();
	const results = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const c of m.content) {
				if (c.type === "toolCall" && !exemptUseIds?.has(c.id)) uses.add(c.id);
			}
		} else if (m.role === "toolResult") {
			results.add(m.toolCallId);
		}
	}
	for (const id of uses) if (!results.has(id)) throw new Error(`acp projection: tool_use ${id} has no result`);
	for (const id of results) if (!uses.has(id)) throw new Error(`acp projection: tool result ${id} has no tool_use`);
}

/**
 * Project a source view into the request message sequence (spec §4.1-4.3):
 * compression zone first (unsuperseded blocks, original order), then the active
 * zone filtered to `keptBlockIds`. Messages are copied on change, never mutated.
 */
export function projectContext(
	source: readonly AcpSourceMessage[],
	keptBlockIds: ReadonlySet<string>,
	compactionBlocks: readonly AcpCompactionBlock[],
	countTokens: CountTokens,
): AgentMessage[] {
	const blocks = splitBlocks(source, countTokens);
	// toolCallId -> owning pair block; a tool_use body rides with its result.
	const pairByCallId = new Map<string, string>();
	for (const b of blocks) if (b.toolCallId !== undefined) pairByCallId.set(b.toolCallId, b.id);
	// tool_use ids with no settled result: unfinished turn, exempt from pairing.
	const unfinishedUseIds = new Set<string>();
	for (const { message } of source)
		if (message.role === "assistant")
			for (const c of message.content) if (c.type === "toolCall" && !pairByCallId.has(c.id)) unfinishedUseIds.add(c.id);
	const superseded = new Set<string>();
	for (const b of compactionBlocks) for (const s of b.meta.supersedes ?? []) superseded.add(s);

	const out: AgentMessage[] = [];
	for (const b of compactionBlocks) {
		if (superseded.has(b.id)) continue;
		const rendered: UserMessage = {
			role: "user",
			content: renderCompactionBlock(b, countTokens),
			synthetic: true,
			timestamp: b.meta.createdAt,
		};
		out.push(rendered);
	}

	for (const { id, message } of source) {
		if (message.role === "assistant") {
			const filtered = message.content.filter((c) => {
				if (c.type === "toolCall") {
					const pairId = pairByCallId.get(c.id);
					// No settled result = unfinished turn: the pair is not a
					// compression candidate, keep the call as-is.
					return pairId === undefined ? true : keptBlockIds.has(pairId);
				}
				if (c.type === "thinking" || c.type === "redactedThinking") return keptBlockIds.has(`${id}#t`);
				if (c.type === "text") return keptBlockIds.has(`${id}#x`);
				return true;
			});
			// Every block compressed away -> the whole assistant message drops (spec §4.2).
			if (filtered.length === 0) continue;
			const projected: AssistantMessage = { ...message, content: filtered };
			out.push(projected);
		} else if (message.role === "toolResult") {
			if (!keptBlockIds.has(id)) continue;
			const kept: ToolResultMessage = { ...message };
			out.push(kept);
		} else if (message.role === "user" || message.role === "developer") {
			if (!keptBlockIds.has(id)) continue;
			out.push(message);
		}
		// Custom agent messages pass through untouched (not compression candidates).
		else out.push(message);
	}

	assertToolPairing(out, unfinishedUseIds);
	return out;
}
