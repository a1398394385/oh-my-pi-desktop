// Adapter layer for the opencode-acp compression tool surface.
//
// Goal: register opencode-acp's (Active Context Pruning) five context
// management tools (compress / decompress / search_context / acp_status /
// acp_context_recap) into the omp SDK session with the original
// opencode-acp parameter schemas and description texts, so the model sees the
// same ACP tool surface in omp-desktop as in the opencode host.
//
// Boundaries (honest declaration, not a silent fake):
// - This adapter only provides "tool visibility + parameter validation +
//   adapter-state receipts"; opencode-acp's compression engine
//   (SessionStateRegistry / prepareSession / prune / nudge / mNNNNN ref
//   injection) runs on the opencode plugin API and was NOT ported with this
//   file. compress and friends return an explicit adapter-state explanation
//   and never fake "compression succeeded".
// - schemas and descriptions are taken verbatim from the opencode-acp source:
//   lib/compress/range.ts, decompress.ts, search.ts, status.ts, recap.ts,
//   lib/prompts/compress-range.ts, lib/prompts/extensions/tool.ts.
// - Tool signatures follow omp's ToolDefinition (execute(toolCallId, params,
//   signal, onUpdate, ctx) -> AgentToolResult { content: TextContent[] }),
//   registered via createAgentSession({ customTools }).
import { type } from "@oh-my-pi/omptype";
import type { AcpBlock, AcpSessionState } from "./acp-state.ts";
import { messageText, ACP_TOOL_NAMES } from "./acp-state.ts";
import { expandToTransactionBounds, serializeForArchive } from "./acp-context.ts";

// ---- description texts (ported verbatim from opencode-acp) ----

const COMPRESS_DESCRIPTION = `Collapse a range in the conversation into a detailed summary.

COMPRESSED BLOCK PLACEHOLDERS
The system auto-detects any previously compressed blocks whose anchor messages fall inside your selected range. You do NOT need to manually list \`(bN)\` placeholders in your summary — every consumed block is tracked automatically.

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Rules:

- Write your summary normally. The system handles block consumption automatically.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` as a RESERVED TOKEN. Do not emit \`(bN)\` text anywhere in the summary.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (never as a placeholder).

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context. If you cannot see an ID in the messages above, it is stale and will fail.
- Prefer \`startId\` before \`endId\` in conversation order. ACP can normalize reversed boundaries, but do not rely on that behavior.
- Do not invent IDs. Use only IDs that are present in context.
- NEVER use IDs from compressed block summaries, previous nudges, or your own memory — only IDs currently visible as XML metadata tags in the conversation.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.

When the ranges cover unrelated topics, give each entry its own \`topic\` for better summary quality — do not force unrelated content under a single shared topic. Omit the top-level \`topic\` when every entry has its own. Use the top-level \`topic\` only as a fallback when entries don't specify one.

\`\`\`
compress({ content: [
  { topic: "Auth System Exploration", startId: "m00010", endId: "m00050", summary: "..." },
  { topic: "Bug Hunt", startId: "m00060", endId: "m00080", summary: "..." },
  { topic: "Deployment", startId: "m00090", endId: "m00110", summary: "..." },
]})
\`\`\`

KEEP AND REF MARKERS
When writing a summary, you may embed markers that reference specific messages in the compressed range. The system resolves them automatically:

- \`[[KEEP:mNNNNN]]\` — Expands to the original message content inline (truncated to a max length). Use for critical content you want preserved verbatim in the summary without re-typing it: key function definitions, important error messages, essential file contents.
- \`[[REF:mNNNNN|short description]]\` — Creates a compact link like \`[→ m00065: key function definition]\`. Use for content the reader can decompress later if needed. Does not expand — saves space.

Use KEEP sparingly — each expansion adds to the summary length. Prefer REF for content that is important but not immediately critical.

THE FORMAT OF COMPRESS

\`\`\`
{
  topic?: string,          // OPTIONAL fallback topic for entries without their own.
                           //   Omit when every content entry specifies its own topic.
  content: [               // One or more ranges to compress
    {
      topic?: string,      // OPTIONAL per-entry topic for this range.
                           //   Falls back to top-level topic.
                           //   Give each entry its own topic when compressing
                           //   unrelated ranges in one call.
      startId: string,     // Boundary ID at range start: mNNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\`
Each entry needs a topic — either its own or the top-level fallback.`;

const DECOMPRESS_DESCRIPTION = `Restores previously compressed content.

Use this tool when you need exact details from compressed content that the summary cannot provide.
The tool returns a condensed preview of the restored content so you can reason about it immediately.

TWO MODES:

1. Block mode (default): decompress a single block by ID.
   - blockId: block reference to decompress (e.g., "b0", "b2")

2. Range mode: decompress ALL blocks overlapping a message range. Use this to restore
   content across multiple blocks without calling acp_status + decompress repeatedly.
   - startId: starting message or block ref (e.g., "m00150")
   - endId: ending message or block ref (e.g., "m00200")

   Range mode finds every active block whose effectiveMessageIds touch the range and
   batch-restores them. Partial overlap decompresses the whole block (content cannot be
   partially restored). Nested blocks are handled automatically.

ARGUMENTS:
- blockId?: string — use this OR startId+endId (mutually exclusive)
- startId?: string — range start (message or block ref)
- endId?: string — range end (message or block ref)
- toFile?: string — if provided, writes restored content to this file path (must be under
  /tmp or ~/.cache/opencode/) instead of inflating context. Block(s) stay compressed.

IMPORTANT:
- Decompressing inflates context. Check context usage before decompressing.
- Message-mode blocks from the same batch (same runId) are restored together.
- TIER-AWARE: by default, decompressing a multi-tier block restores the PREVIOUS tier's
  summaries (e.g., decompress T2 → T1 summaries visible, not raw messages). Use full:true
  to restore all the way to original messages (can be very expensive for T2/T3 blocks).
- After decompression, the restored content will appear in full in your next context window.
- Do NOT call this tool in parallel with compress — their state mutations may conflict.`;

const SEARCH_CONTEXT_DESCRIPTION = `Search through active compressed block summaries to find relevant content. Use this BEFORE decompressing to find the right block. Returns a hit list with block IDs, relevance scores, and previews.

Examples:
- search_context({ query: "decoder accuracy" }) — find compressed blocks about decoder accuracy
- search_context({ query: "training loss PPL" }) — find training results
- search_context({ query: "architecture design", limit: 5 }) — top 5 results`;

const ACP_STATUS_DESCRIPTION = `Show context status — overview includes compressible ranges (compression candidates when compress.candidates is enabled).

No args: Overview with totals, compressed blocks, and compressible ranges (or candidates when enabled).
scope:"uncompressed": Compressible ranges by default (view:"candidates" when compress.candidates is enabled). Use view:"ranges" for raw grouped ranges or view:"messages" for per-message listing.
scope:"compressed": Drill into compressed blocks — list each with full details (age, generation, consumed lineage).

Use this tool to:
- See what's consuming context + compressible targets in one call (no args)
- Focus on ranges only (scope:"uncompressed")
- Find all messages of a specific tool type (scope:"uncompressed", view:"messages", tool:"bash")
- Check block details before decompressing (scope:"compressed")`;

const RECAP_DESCRIPTION = `Read-only retrieval of compression block summaries.

Call this tool to re-fetch a specific block's summary without decompressing the full original content. Useful when a past compress tool call's summary has scrolled out of context or was truncated by the provider.

Args:
- blockId: optional block number (e.g., 5). If omitted, lists all active blocks with brief info.`;

// ---- parameter schemas (zod schemas from the opencode-acp source, transcribed to omptype/ArkType) ----

const compressEntrySchema = type({
  "topic?": type("string").describe(
    "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality.",
  ),
  startId: type("string").describe(
    "Message or block ID marking the beginning of range (e.g. m00001, b2)",
  ),
  endId: type("string").describe(
    "Message or block ID marking the end of range (e.g. m00012, b5)",
  ),
  summary: type("string").describe(
    "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
  ),
});

const compressParams = type({
  "topic?": type("string").describe(
    "Fallback topic for entries without their own. Omit when each content entry specifies its own topic.",
  ),
  content: compressEntrySchema
    .array()
    .describe(
      "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic.",
    ),
  "summaryMaxChars?": type("number").describe(
    "Override max summary length (default max: 12000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit.",
  ),
  "dangerous?": type("boolean").describe(
    "Set to true ONLY when you are certain the most recent message(s) must be compressed. Required when a range includes the tail of the conversation.",
  ),
  "acknowledgeRisk?": type("boolean"),
});

const decompressParams = type({
  "blockId?": type("string").describe(
    'Block reference to decompress (e.g., "b0", "b2"). Mutually exclusive with startId/endId.',
  ),
  "startId?": type("string").describe(
    'Range start: message ref (e.g., "m00150") or block ref (e.g., "b2"). Used with endId.',
  ),
  "endId?": type("string").describe(
    'Range end: message ref (e.g., "m00200") or block ref (e.g., "b5"). Used with startId.',
  ),
  "toFile?": type("string").describe(
    "If provided, writes restored content to this file path instead of inflating context. Block stays compressed. Path must be under /tmp or ~/.cache/opencode/. Example: '/tmp/block52.txt'",
  ),
  "full?": type("boolean").describe(
    "If true, restores ALL content down to original messages (multi-level decompress). Default: false — restores one tier up (e.g., decompressing a T2 block restores T1 summaries, not raw messages). Use full:true only when you need the exact original content and have context budget for it.",
  ),
});

const searchContextParams = type({
  query: type("string").describe("Search query — keywords or phrase to find"),
  "limit?": type("number").describe("Maximum results to return (default: 10)"),
  "deep?": type("boolean").describe(
    "Reserved for compatibility; the current search indexes active compressed block summaries.",
  ),
});

const acpStatusParams = type({
  "scope?": type("string").describe(
    'Drill down: "compressed" or "uncompressed". No arg = overview of both.',
  ),
  "view?": type("string").describe(
    'Display format for scope:"uncompressed": "candidates" (default when compress.candidates is enabled — otherwise "ranges"), "ranges" (raw grouped ranges), or "messages" (per-message listing with sort/filter)',
  ),
  "tool?": type("string").describe(
    'Filter by tool type (only with scope:"uncompressed", view:"messages"). e.g., "bash", "todowrite", "write"',
  ),
  "sort?": type("string").describe('Sort order: "size" (default), "time", or "tool"'),
  "limit?": type("number").describe("Max items to list (default 30)"),
});

const recapParams = type({
  "blockId?": type("number").describe(
    "Block number to retrieve (e.g., 5). If omitted, lists all active blocks.",
  ),
});


// ---- tool bodies (real implementation: reads/writes AcpSessionState; view transform in acp-context.ts) ----

/** Rough token estimate (4 chars/token — status display only, never used for compression decisions). */
function estTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

export function createAcpCompressTools(state: AcpSessionState) {
	return [
		{
			name: "compress",
			label: "ACP Compress",
			description: COMPRESS_DESCRIPTION,
			parameters: compressParams,
			loadMode: "essential" as const,
			approval: "write" as const,
			execute: async (_id: string, params: Record<string, unknown>) => {
				const entries = params?.content as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(entries) || entries.length === 0) {
					return textResult("Error: content array is required.");
				}
				for (const entry of entries) {
					if (!entry?.startId || !entry?.endId || !entry?.summary) {
						return textResult("Error: each content entry requires startId, endId, and summary.");
					}
				}
				const messages = state.lastOriginal;
				if (messages.length === 0) {
					return textResult("Error: no conversation view captured yet — send at least one message first.");
				}
				// Per-entry locating + pair closure + overlap validation
				const ranges: Array<{ first: number; last: number; entry: Record<string, unknown> }> = [];
				for (const entry of entries) {
					const range = state.locateRange(String(entry.startId), String(entry.endId));
					if (!range) {
						return textResult(
							`Error: boundary ${entry.startId}..${entry.endId} not found in the current visible context. Use only IDs visible in <dcp-message-id> tags.`,
						);
					}
					const bounds = expandToTransactionBounds(messages, range.first, range.last);
					ranges.push({ first: bounds.start, last: bounds.end, entry });
				}
				ranges.sort((a, b) => a.first - b.first);
				for (let i = 1; i < ranges.length; i++) {
					if (ranges[i].first <= ranges[i - 1].last) {
						return textResult("Error: content ranges overlap — merge them into one entry or fix boundaries.");
					}
				}
				// Existing active blocks only allow full coverage (consumption); partial overlap is rejected
				for (const r of ranges) {
					for (const block of state.activeBlocks()) {
						const anchors = state.locateBlockAnchors(block);
						if (!anchors) continue;
						const overlaps = r.first <= anchors.last && anchors.first <= r.last;
						const covers = r.first <= anchors.first && anchors.last <= r.last;
						if (overlaps && !covers) {
							return textResult(
								`Error: range partially overlaps active block b${block.blockId} (${anchors.first}..${anchors.last}). Either cover it entirely (its summary will be consumed) or exclude it.`,
							);
						}
					}
			}
			// Hard protection: calls/results of ACP's own tools must never be
			// compressed (summaries are the history contract — compressing the
			// carrier of block metadata breaks both decompress and traceability)
			for (const r of ranges) {
				for (let i = r.first; i <= r.last; i++) {
					const m = messages[i] as { role?: string; toolName?: string; content?: unknown };
					if (m?.role === "toolResult" && ACP_TOOL_NAMES.has(String(m.toolName ?? ""))) {
						return textResult(
							`Error: range includes a protected ${m.toolName} tool result (message ${i + 1}). ACP tool calls carry block metadata and are never compressible — adjust boundaries to exclude it.`,
						);
					}
					if (m?.role === "assistant" && Array.isArray(m.content)) {
						const acpCall = (m.content as Array<{ type?: string; tool?: string }>).find(
							(c) => c?.type === "toolCall" && ACP_TOOL_NAMES.has(String(c.tool ?? "")),
						);
						if (acpCall) {
							return textResult(
								`Error: range includes a protected ${acpCall.tool} tool call (message ${i + 1}). ACP tool calls carry block metadata and are never compressible — adjust boundaries to exclude it.`,
							);
						}
					}
				}
			}
				// Create blocks (back-to-front; covered old blocks are consumed, their references injected into the new block's summary header)
			const created: string[] = [];
			for (const r of [...ranges].reverse()) {
				const entry = r.entry;
				const topic = String(entry.topic ?? params.topic ?? "");
				const blockId = state.allocBlockId();
				const consumedNow = state
					.activeBlocks()
					.filter((b) => {
						const anchors = state.locateBlockAnchors(b);
						return anchors && r.first <= anchors.first && anchors.last <= r.last;
					})
					.map((b) => `b${b.blockId} "${b.topic || "untitled"}"`);
				const summaryPrefix = consumedNow.length > 0 ? `[Consumed blocks: ${consumedNow.join("; ")}]\n` : "";
				state.blocks.set(blockId, {
					blockId,
					topic,
					summary: summaryPrefix + String(entry.summary),
					originalMessages: messages.slice(r.first, r.last + 1).map((m) => structuredClone(m)),
					firstIndex: r.first,
					lastIndex: r.last,
					active: true,
					createdAt: Date.now(),
				});
				created.unshift(`b${blockId}`);
			}
				for (const block of state.activeBlocks()) {
					const anchors = state.locateBlockAnchors(block);
					if (!anchors) continue;
					const consumed = ranges.some((r) => r.first <= anchors.first && anchors.last <= r.last);
					if (consumed && !created.includes(`b${block.blockId}`)) block.active = false;
				}
				const lines = [
					`📦 [ACP] Compressed ${ranges.length} range(s) → blocks ${created.join(", ")}.`,
					"",
					...ranges.map((r) => {
						const original = messages
							.slice(r.first, r.last + 1)
							.map((m) => messageText(m))
							.join("");
						const summary = String(r.entry.summary);
						return `- b? (${r.entry.topic ?? params.topic ?? "untitled"}): ${r.last - r.first + 1} messages, ~${estTokens(original)} tok → ${summary.length} chars summary (~${Math.max(1, Math.round((summary.length / Math.max(1, original.length)) * 100))}%)`;
					}),
					"",
					"The compressed sections will be replaced by summaries in your next context window.",
				];
				return textResult(lines.join("\n"));
			},
		},
		{
			name: "decompress",
			label: "ACP Decompress",
			description: DECOMPRESS_DESCRIPTION,
			parameters: decompressParams,
			loadMode: "essential" as const,
			approval: "read" as const,
			execute: async (_id: string, params: Record<string, unknown>) => {
				const blockId = params?.blockId as string | undefined;
				const startId = params?.startId as string | undefined;
				const endId = params?.endId as string | undefined;
				const toFile = params?.toFile as string | undefined;

				if (toFile) {
					const os = await import("node:os");
					const path = await import("node:path");
					const fs = await import("node:fs/promises");
					const resolved = path.resolve(toFile.replace(/^~/, os.homedir()));
					const allowed = ["/tmp", path.join(os.homedir(), ".cache")].some((p) => resolved.startsWith(p));
					if (!allowed) {
						return textResult("Error: toFile path must be under /tmp or ~/.cache/.");
					}
					const targets = blockId
						? [state.blocks.get(Number(/^b(\d+)$/.exec(blockId)?.[1] ?? "-1"))].filter(
								(b): b is NonNullable<typeof b> => !!b,
							)
						: state.activeBlocks();
					if (targets.length === 0) return textResult("Error: no matching block for toFile export.");
					await fs.writeFile(resolved, serializeForArchive(targets.flatMap((b) => b.originalMessages)), "utf-8");
					return textResult(
						`📦 [ACP] Exported ${targets.length} block(s) (${targets.map((b) => `b${b.blockId}`).join(", ")}) to ${resolved}. Blocks stay compressed.`,
					);
				}

				let targets: AcpBlock[];
				if (blockId) {
					const n = /^b(\d+)$/.exec(blockId)?.[1];
					const block = n ? state.blocks.get(Number(n)) : undefined;
					if (!block) return textResult(`Error: block ${blockId} not found.`);
					targets = [block];
				} else if (startId && endId) {
					const range = state.locateRange(startId, endId);
					if (!range) return textResult(`Error: range ${startId}..${endId} not found in current context.`);
					targets = state.activeBlocks().filter((b) => {
						const anchors = state.locateBlockAnchors(b);
						return anchors && anchors.first <= range.last && range.first <= anchors.last;
					});
					if (targets.length === 0) return textResult(`No active blocks overlap ${startId}..${endId}.`);
				} else {
					return textResult("Error: provide blockId, or startId+endId (mutually exclusive modes).");
				}

				for (const block of targets) block.active = false;
				return textResult(
					`📦 [ACP] Decompressed ${targets.map((b) => `b${b.blockId}`).join(", ")}. Original content returns in your next context window (it will grow — check usage with acp_status).`,
				);
			},
		},
		{
			name: "search_context",
			label: "ACP Search Context",
			description: SEARCH_CONTEXT_DESCRIPTION,
			parameters: searchContextParams,
			loadMode: "essential" as const,
			approval: "read" as const,
			execute: async (_id: string, params: Record<string, unknown>) => {
				const query = String(params?.query ?? "").toLowerCase().trim();
				if (!query) return textResult("Error: query is required.");
				const limit = Number(params?.limit ?? 10);
				const blocks = state.activeBlocks();
				if (blocks.length === 0) return textResult("No compressed blocks to search. Nothing has been compressed yet.");

				// TF scoring (weights match opencode-acp search.ts: topic 0.15/cap 0.45,
				// summary 0.04/cap 0.20, whole-word hit x1.2, phrase +0.25, existence bonus +0.05 compensating CJK)
				const terms = query.split(/\s+/).filter(Boolean);
				const countOccurrences = (text: string, term: string): number => {
					let count = 0;
					let idx = 0;
					while ((idx = text.indexOf(term, idx)) !== -1) {
						count++;
						idx += term.length;
					}
					return count;
				};
				const scored = blocks
					.map((block) => {
						const topic = (block.topic || "").toLowerCase();
						const summary = (block.summary || "").toLowerCase();
						let relevance = 0;
						let hitTerms = 0;
						for (const term of terms) {
							relevance += Math.min(0.45, countOccurrences(topic, term) * 0.15);
							relevance += Math.min(0.2, countOccurrences(summary, term) * 0.04);
							if (summary.includes(` ${term} `) || summary.startsWith(`${term} `) || summary.endsWith(` ${term}`))
								relevance *= 1.2;
							if (topic.includes(term) || summary.includes(term)) hitTerms++;
						}
						if (summary.includes(query)) relevance += 0.25;
						// Existence bonus: +0.05 when any term hits — compensates CJK (the
						// English whole-word boost depends on space tokenization and never
						// fires for unspaced Chinese; pure TF would push already-hit blocks
						// below the threshold)
						if (hitTerms > 0) relevance += 0.05;
						return { block, relevance };
					})
					.filter((s) => s.relevance >= 0.1)
					.sort((a, b) => b.relevance - a.relevance)
					.slice(0, limit);

				if (scored.length === 0) {
					return textResult(`No blocks match "${params?.query}" (min relevance 0.1). Try broader terms.`);
				}
				return textResult(
					scored
						.map((s) => {
							const preview = s.block.summary.slice(0, 200) + (s.block.summary.length > 200 ? "..." : "");
							return `b${s.block.blockId} (score ${s.relevance.toFixed(2)}) [→ decompress b${s.block.blockId}]\n  ${s.block.topic}: ${preview}`;
						})
						.join("\n\n"),
				);
			},
		},
		{
			name: "acp_status",
			label: "ACP Status",
			description: ACP_STATUS_DESCRIPTION,
			parameters: acpStatusParams,
			loadMode: "essential" as const,
			approval: "read" as const,
			execute: async (
				_id: string,
				params: Record<string, unknown>,
				_signal: unknown,
				_onUpdate: unknown,
				ctx: { sessionManager?: { getSessionId?: () => string } },
			) => {
				const messages = state.lastOriginal;
				const blocks = state.activeBlocks();
				const viewTokens = estTokens(messages.map((m) => messageText(m)).join(""));
				const blockSummaryChars = blocks.reduce((n, b) => n + b.summary.length, 0);
				const originalChars = blocks.reduce((n, b) => n + b.originalMessages.length, 0);
				const lines = [
					`ACP Context Analysis (omp-desktop adapter)`,
					``,
					`Session: ${ctx?.sessionManager?.getSessionId?.() ?? "unknown"}`,
					`Messages in view: ${messages.length} (~${viewTokens} tok estimated)`,
					`Blocks: ${blocks.length} active (${blockSummaryChars} chars summary covering ${originalChars} messages)`,
				];
				if (params?.scope === "compressed") {
					if (blocks.length === 0) lines.push("  (none)");
					for (const b of blocks) {
						lines.push(
							`  b${b.blockId} "${b.topic || "untitled"}" ${b.summary.length} chars, ${b.originalMessages.length} msgs original, age=${Math.round((Date.now() - b.createdAt) / 60000)}m`,
						);
					}
				} else {
					lines.push(``, `Compressible: the uncompressed message range in your context (see <dcp-message-id> tags).`);
					lines.push(`Use scope:"compressed" to list block details.`);
				}
				return textResult(lines.join("\n"));
			},
		},
		{
			name: "acp_context_recap",
			label: "ACP Context Recap",
			description: RECAP_DESCRIPTION,
			parameters: recapParams,
			loadMode: "essential" as const,
			approval: "read" as const,
			execute: async (_id: string, params: Record<string, unknown>) => {
				const blocks = state.activeBlocks();
				if (blocks.length === 0) return textResult("No active compression blocks.");
				if (params?.blockId !== undefined) {
					const block = blocks.find((b) => b.blockId === Number(params.blockId)) ?? state.blocks.get(Number(params.blockId));
					if (!block) return textResult(`Block b${params.blockId} not found. Active blocks: ${blocks.map((b) => `b${b.blockId}`).join(", ")}`);
					if (!block.active) return textResult(`Block b${block.blockId} is inactive (decompressed or consumed by a nested compression).`);
					return textResult(`b${block.blockId} "${block.topic || "untitled"}":\n\n${block.summary}`);
				}
				return textResult(
					blocks.map((b) => `- b${b.blockId} "${b.topic || "untitled"}" (${b.summary.length} chars)`).join("\n"),
				);
			},
		},
	];
}
