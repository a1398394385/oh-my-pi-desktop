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
// host only filters inside the domain, and filtering is pair-granular by
// construction (a tool_use rides with its result's block id, so removal never
// splits a pair). Pairing gaps INHERITED from the source view (aborted-turn
// dangling calls, base-synthesized skipped results) are passed through as-is:
// the provider transform layer re-pairs them per request (synthesizing aborted
// placeholder results), so failing loudly here would only disable compression
// for a condition the wire tolerates. A gap is still logged once per request
// so a manifest-validation hole remains observable.
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-agent-core";
import { base64ImageSize, estimateImageTokens, type ImageDetail } from "@oh-my-pi/pi-agent-core/image-tokens";
import { messageFingerprint } from "./acp-fingerprint.ts";

/** Token counter bound to the active model's Tokenizer (byte-estimate fallback is built in). */
export type CountTokens = (text: string) => number;

/** Image charge of one content block; the host binds it to the session model's Tokenizer (spec §8). */
export type CountImage = (image: { data: string; detail?: ImageDetail }) => number;

/** Fallback for pure-function callers: the wire rule the base tokenizer uses without a catalog image rule. */
const defaultCountImage: CountImage = (image) => estimateImageTokens(base64ImageSize(image.data), image.detail);

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
 * Text plus the image charge of one message content: the base tokenizer prices
 * image blocks by pixel size ({@link estimateImageContentTokens}), and a block
 * that dropped that charge would under-read its own size — and every tier/
 * budget verdict derived from it — by the whole image cost.
 */
function splitContent(
	content: string | readonly unknown[] | undefined,
	countImage: CountImage,
): { text: string; imageTokens: number } {
	if (typeof content === "string") return { text: content, imageTokens: 0 };
	if (!Array.isArray(content)) return { text: "", imageTokens: 0 };
	let text = "";
	let imageTokens = 0;
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		if (c.type === "text") text += c.text;
		else if (c.type === "thinking") text += c.thinking;
		else if (c.type === "image") imageTokens += countImage(c);
	}
	return { text, imageTokens };
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
 *
 * `countImage` prices `image` blocks, which carry no text: the host binds it to
 * the session Tokenizer so a block reads exactly as large as the base counter
 * charges it. Callers that only need ids pass a zero counter.
 */
export function splitBlocks(
	source: readonly AcpSourceMessage[],
	countTokens: CountTokens,
	memo?: Map<string, number>,
	countImage: CountImage = defaultCountImage,
): AcpBlockInfo[] {
	const blocks: AcpBlockInfo[] = [];
	// tool_use bodies ride with their result block (spec §3), so their cost is
	// charged to the owning result block: the pair leaves the request together
	// on compression, and every consumer derived from splitBlocks (activity
	// zone, tier lines, manifest ranking) must see the pair's full size. Calls
	// without a settled result (unfinished turn) stay uncounted — they are a
	// transient request tail, not compression candidates.
	const callTokens = new Map<string, number>();
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
			const { text, imageTokens } = splitContent(message.content, countImage);
			blocks.push({ id, kind: "user", sourceId: id, tokens: count(text) + imageTokens, intent: truncIntent(text) });
		} else if (message.role === "toolResult") {
			const { text, imageTokens } = splitContent(message.content, countImage);
			blocks.push({
				id,
				kind: "result",
				sourceId: id,
				toolCallId: message.toolCallId,
				tokens: count(text) + imageTokens + (callTokens.get(message.toolCallId) ?? 0),
				intent: truncIntent(`${message.toolName}: ${text}`),
			});
		} else if (message.role === "assistant") {
			let thinking = "";
			// Providers bill the opaque signature riding along a thinking block, and the
			// base countMessage charges it — an uncounted signature leaves the block under
			// its wire size by that payload.
			let signature = "";
			let text = "";
			// tool_use bodies ride with their result block, never split into their own.
			for (const c of message.content) {
				if (c.type === "thinking") {
					thinking += c.thinking;
					if (c.thinkingSignature) signature += c.thinkingSignature;
				} else if (c.type === "redactedThinking") thinking += c.data;
				else if (c.type === "text") text += c.text;
				else if (c.type === "toolCall")
					callTokens.set(c.id, count(`${c.name} ${JSON.stringify(c.arguments)}`, "c"));
			}
			if (thinking || signature)
				blocks.push({
					id: `${id}#t`,
					kind: "thinking",
					sourceId: id,
					tokens: count(thinking, "t") + (signature ? count(signature, "s") : 0),
					intent: truncIntent(thinking),
				});
			if (text)
				blocks.push({ id: `${id}#x`, kind: "text", sourceId: id, tokens: count(text, "x"), intent: truncIntent(text) });
		}
		// Custom agent messages and anything else are not compression candidates; skip.
	}
	return blocks;
}

/**
 * Render one compaction block as its user-role text segment (spec §4.1).
 * `refOf` re-labels ids as short refs on model-facing surfaces (spec §3 v10);
 * the default keeps raw ids for pure-function callers.
 */
export function renderCompactionBlock(b: AcpCompactionBlock, countTokens: CountTokens, refOf?: (id: string) => string): string {
	const ref = refOf ?? ((id: string) => id);
	const header =
		`[acp-summary id=${ref(b.id)} time=${new Date(b.meta.createdAt).toISOString()} ` +
		`depth=${b.meta.depth} blocks=${b.index.length} method=${b.meta.method}]`;
	const lines = b.index.map((l) => `${ref(l.id)} | ${l.tokens} | ${l.intent}`);
	const render = (ls: readonly string[], trailer?: string): string =>
		[header, b.summary, "Index:", ...ls, ...(trailer ? [trailer] : [])].join("\n");
	let out = render(lines);
	if (countTokens(out) <= ACP_INDEX_RENDER_BUDGET) return out;
	// Over budget: drop the oldest segments (index lines are chronological) and
	// point the model at recall_block for the full index (spec §11).
	let kept = lines.length;
	const trailer = () => `… ${lines.length - kept} more, recall_block(${ref(b.id)}) 取完整索引`;
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
 * `refOf` rides into the zone render for short-ref labels (spec §3 v10).
 */
export function projectContext(
	source: readonly AcpSourceMessage[],
	keptBlockIds: ReadonlySet<string>,
	compactionBlocks: readonly AcpCompactionBlock[],
	countTokens: CountTokens,
	refOf?: (id: string) => string,
	onPairingGap?: (err: Error) => void,
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
			content: renderCompactionBlock(b, countTokens, refOf),
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

	// Pairing gaps inherited from the source view (aborted-turn dangling calls,
	// base-synthesized results) are passed through untouched: the provider
	// transform layer re-pairs the wire per request. Filtering itself is
	// pair-granular (see pairByCallId above), so any gap reported here points
	// at the source view or a manifest-validation hole, not at removal.
	try {
		assertToolPairing(out, unfinishedUseIds);
	} catch (err) {
		onPairingGap?.(err instanceof Error ? err : new Error(String(err)));
	}
	return out;
}
