// ACP projection pairing tolerance: gaps INHERITED from the source view (aborted-turn
// dangling tool calls, base-synthesized results) must pass through untouched — the
// provider transform layer re-pairs the wire per request. Removal itself stays
// pair-granular: a tool_use drops iff its result block drops. (The 2026-10-21 incident:
// a pairing throw here silently disabled the projection while the card kept showing
// projected sizes.)
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-projection-pairing.test.ts
import { describe, expect, test } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-agent-core";
import { projectContext, splitBlocks, type AcpSourceMessage } from "../host/acp-projection.ts";

const tokenizer = new Tokenizer(null);
const countTokens = (s: string) => tokenizer.countTokens(s);

let ts = 1;
const user = (id: string, text: string): AcpSourceMessage => ({
	id,
	message: { role: "user", content: text, timestamp: ts++ } as UserMessage,
});
const assistant = (id: string, content: AssistantMessage["content"]) => ({
	id,
	message: {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		timestamp: ts++,
	} as unknown as AssistantMessage,
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

const keepAll = (source: AcpSourceMessage[]) => new Set(splitBlocks(source, countTokens).map((b) => b.id));

describe("projectContext pairing tolerance", () => {
	test("a dangling tool call (aborted turn, no result anywhere) is kept, not thrown", () => {
		const source = [user("u1", "继续"), assistant("a1", [call("c_dangling")])];
		const out = projectContext(source, keepAll(source), [], countTokens);
		const a = out.find((m) => m.role === "assistant") as AssistantMessage;
		expect(a.content.some((c) => c.type === "toolCall" && c.id === "c_dangling")).toBe(true);
	});

	test("an orphan tool result (call missing from the view) passes through, not thrown", () => {
		const source = [user("u1", "hi"), result("r1", "c_orphan", "skipped")];
		const out = projectContext(source, keepAll(source), [], countTokens);
		expect(out.some((m) => m.role === "toolResult" && m.toolCallId === "c_orphan")).toBe(true);
	});

	test("removal stays pair-granular: compressing a pair drops the call with its result", () => {
		const source = [user("u1", "run it"), assistant("a1", [call("c1")]), result("r1", "c1", "ok"), user("u2", "next")];
		const kept = keepAll(source);
		kept.delete("r1"); // the pair's block id is the result entry's id
		const out = projectContext(source, kept, [], countTokens);
		expect(out.some((m) => m.role === "toolResult")).toBe(false);
		const a = out.find((m) => m.role === "assistant");
		expect(a).toBeUndefined(); // its only content block was the pair's call
	});
});

// Block tokens gate the tier line, the over-target check and the manifest ranking, so a
// content kind the base counter charges but splitBlocks ignored would under-read every
// verdict derived from it (2026-10-21: images were 51% of a screenshot-heavy session).
describe("splitBlocks charges every content kind the base counter does", () => {
	const IMAGE = 1000;
	const withImage = (mimeType: string, data: string) => ({ type: "image", data, mimeType }) as never;

	test("user and toolResult image blocks are priced per image, not silently zero", () => {
		const source: AcpSourceMessage[] = [
			{ id: "u1", message: { role: "user", content: [{ type: "text", text: "look" }, withImage("image/png", "A")], timestamp: ts++ } as UserMessage },
			{ id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "screenshot", content: [withImage("image/png", "B")], isError: false, timestamp: ts++ } as ToolResultMessage },
		];
		const blocks = splitBlocks(source, (t) => t.length, undefined, () => IMAGE);
		expect(blocks.find((b) => b.id === "u1")!.tokens).toBe("look".length + IMAGE);
		expect(blocks.find((b) => b.id === "r1")!.tokens).toBe(IMAGE);
	});

	test("a thinking signature rides with its thinking block", () => {
		const source = [assistant("a1", [{ type: "thinking", thinking: "abc", thinkingSignature: "sig-9" }])];
		const blocks = splitBlocks(source, (t) => t.length);
		expect(blocks.find((b) => b.id === "a1#t")!.tokens).toBe("abc".length + "sig-9".length);
	});

	test("a signature-only thinking block still gets its block entry", () => {
		const source = [assistant("a1", [{ type: "thinking", thinking: "", thinkingSignature: "sig-9" }])];
		const blocks = splitBlocks(source, (t) => t.length);
		expect(blocks.find((b) => b.id === "a1#t")!.tokens).toBe("sig-9".length);
	});
});
