// ACP T1 smoke: block model + projection core (spec §3/§4, acceptance matrix 1/2/9-adjacent).
// Pure-function assertions, single-process bun run; touches no profile state.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-acp-projection.ts
import assert from "node:assert/strict";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-agent-core";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic.js";
import { convertMessages as convertOpenAIMessages } from "@oh-my-pi/pi-ai/providers/openai-completions.js";
import {
	assertToolPairing,
	projectContext,
	renderCompactionBlock,
	splitBlocks,
	ACP_INDEX_RENDER_BUDGET,
	type AcpCompactionBlock,
	type AcpSourceMessage,
} from "../host/acp-projection.ts";

// Unknown model -> Tokenizer keeps its byte-estimate fallback (spec §8), good enough here.
const tokenizer = new Tokenizer(null);
const countTokens = (s: string) => tokenizer.countTokens(s);

let ts = 1;
const user = (id: string, text: string): AcpSourceMessage => ({
	id,
	message: { role: "user", content: text, timestamp: ts++ } as UserMessage,
});
const assistant = (id: string, content: AssistantMessage["content"]): AcpSourceMessage => ({
	id,
	message: { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", timestamp: ts++ },
});
const result = (id: string, callId: string, text: string): AcpSourceMessage => ({
	id,
	message: {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts++,
	} as ToolResultMessage,
});
const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { cmd: `echo ${id}` } });

// --- Block model (spec §3) ---------------------------------------------------
const src: AcpSourceMessage[] = [
	user("u1", "list the files"),
	assistant("a1", [
		{ type: "thinking", thinking: "I should list files", thinkingSignature: "sig" },
		{ type: "text", text: "Running ls" },
		call("c1"),
		call("c2"),
		call("c3"),
	]),
	result("e1", "c1", "file-a"),
	result("e2", "c2", "file-b"),
	result("e3", "c3", "file-c"),
];
const blocks = splitBlocks(src, countTokens);
const ids = blocks.map((b) => b.id);
assert.deepEqual(ids, ["u1", "a1#t", "a1#x", "e1", "e2", "e3"]);
const e2 = blocks.find((b) => b.id === "e2")!;
assert.equal(e2.kind, "result");
assert.equal(e2.toolCallId, "c2");
console.log("ok: splitBlocks ids/kinds/tool pair mapping");

// --- Acceptance 1: round of 3 tools, keep 1 -> assistant holds only that call --
const kept1 = new Set(["u1", "a1#t", "a1#x", "e2"]);
const out1 = projectContext(src, kept1, [], countTokens);
assert.equal(out1.length, 3); // user + assistant + one result
const a1out = out1.find((m) => m.role === "assistant") as AssistantMessage;
assert.deepEqual(
	a1out.content.map((c) => c.type),
	["thinking", "text", "toolCall"],
);
assert.equal(a1out.content[2].type === "toolCall" && a1out.content[2].id, "c2");
assert.equal((out1.find((m) => m.role === "toolResult") as ToolResultMessage).toolCallId, "c2");
console.log("ok: matrix 1 — projection keeps exactly the kept pair, pairing assert passes");

// --- Acceptance 2: fully compressed assistant drops entirely -------------------
const out2 = projectContext(src, new Set(["u1"]), [], countTokens);
assert.ok(!out2.some((m) => m.role === "assistant"));
assert.ok(!out2.some((m) => m.role === "toolResult"));
const out3 = projectContext(src, new Set(["u1", "e1", "e2", "e3"]), [], countTokens);
console.log("ok: matrix 2 — fully compressed assistant/result vanish, no orphans");

// Thinking/text dropped independently of pairs (block-level filter, spec §4.2):
assert.equal(out3.length, 5); // user + assistant(toolCalls only) + 3 results
const a3 = out3.find((m) => m.role === "assistant") as AssistantMessage;
assert.deepEqual(
	a3.content.map((c) => c.type),
	["toolCall", "toolCall", "toolCall"],
);
console.log("ok: thinking/text blocks filter independently of tool pairs");

// --- Pairing assertion throws on single-sided output ---------------------------
assert.throws(() => assertToolPairing([{ role: "assistant", content: [call("cx")] } as AgentMessage]), /cx has no result/);
assert.throws(() => assertToolPairing([result("ex", "cy", "r").message]), /cy has no tool_use/);
console.log("ok: single-sided tool_use/result throws");

// --- Unfinished turn: tool_use with no result passes through ------------------
const unfinished = projectContext(
	[...src, assistant("a2", [call("c9")])],
	new Set(["u1", "a1#t", "a1#x", "e1", "e2", "e3"]),
	[],
	countTokens,
);
assert.ok(unfinished.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.id === "c9")));
console.log("ok: unfinished-turn tool_use kept, pairing exempt");

// --- Compaction zone rendering (spec §4.1, §11) --------------------------------
const cb: AcpCompactionBlock = {
	id: "sum-1",
	summary: "Explored the repo layout.",
	index: [
		{ id: "u1", tokens: 12, intent: "list the files" },
		{ id: "a1#t", tokens: 8, intent: "planning" },
		{ id: "e1", tokens: 40, intent: "ls output" },
	],
	meta: { createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), depth: 0, method: "normal" },
};
const rendered = renderCompactionBlock(cb, countTokens);
assert.match(rendered, /\[acp-summary id=sum-1 time=2026-01-02T03:04:05\.000Z depth=0 blocks=3 method=normal\]/);
assert.match(rendered, /^Explored the repo layout\.$/m);
assert.match(rendered, /^u1 \| 12 \| list the files$/m);
assert.ok(rendered.indexOf("u1 |") < rendered.indexOf("a1#t |"));
assert.ok(!rendered.includes("recall_block"));
console.log("ok: compaction render — header/summary/index lines, no truncation under budget");

// Over 4K: oldest segments dropped + recall trailer (spec §11)
const many = Array.from({ length: 60 }, (_, i) => ({
	id: `blk${i}`,
	tokens: 100,
	intent: "x".repeat(600),
}));
const big: AcpCompactionBlock = { ...cb, index: many };
const bigRender = renderCompactionBlock(big, countTokens);
assert.ok(countTokens(bigRender) <= ACP_INDEX_RENDER_BUDGET, `render ${countTokens(bigRender)} <= budget`);
assert.match(bigRender, /… \d+ more, recall_block\(sum-1\) 取完整索引$/);
assert.ok(!bigRender.includes("blk0 |"), "oldest segment dropped");
assert.ok(bigRender.includes("blk59 |"), "newest segment kept");
console.log("ok: index truncation over 4K drops oldest, keeps newest, recall trailer appended");

// Projection places the rendered zone first, superseded blocks skipped:
const cb2: AcpCompactionBlock = { ...cb, id: "sum-2", meta: { ...cb.meta, supersedes: ["sum-1"] } };
const out4 = projectContext(src, kept1, [cb, cb2], countTokens);
assert.equal(out4.length, 4);
assert.equal((out4[0] as UserMessage).content, renderCompactionBlock(cb2, countTokens));
assert.ok(!(out4[1] as UserMessage).content.includes("sum-1]"));
console.log("ok: superseded compaction blocks not rendered; zone precedes active area");

// --- Wire shapes via base provider converters (domain-level guarantee) ---------
// convertAnthropicMessages / convertMessages are not re-exported from the pi-ai
// root, but the `providers/*` subpath export makes them importable directly —
// so the smoke exercises the real wire conversion, not a domain-level stand-in.
const anthropicModel = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5", input: "claude-sonnet-4-5", compat: { officialEndpoint: true } } as never;
const anthropicWire = convertAnthropicMessages(out1 as never, anthropicModel, false);
assert.ok(anthropicWire.length >= 3);
assert.ok(anthropicWire.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("c2")));
assert.ok(!JSON.stringify(anthropicWire).includes("c1"));
console.log(`ok: anthropic wire conversion (${anthropicWire.length} params), compressed calls absent`);

const openaiModel = { api: "openai-completions", provider: "openai", id: "gpt-4o", input: "gpt-4o" } as never;
const openaiWire = convertOpenAIMessages(openaiModel, { messages: out1, systemPrompt: [] } as never, {} as never);
assert.ok(openaiWire.length >= 3);
assert.ok(!JSON.stringify(openaiWire).includes("c1"));
assert.ok(JSON.stringify(openaiWire).includes("c2"));
console.log(`ok: openai-completions wire conversion (${openaiWire.length} params), compressed calls absent`);

console.log("\nALL ACP T1 PROJECTION SMOKE CHECKS PASSED");
