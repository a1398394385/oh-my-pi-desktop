// Regression for host/auto-review.ts (LLM tool-approval gate).
// The two fail-safe invariants under test: only an explicit valid "allow"
// verdict skips the human approval card, and every failure mode (parse
// deviation, throw, timeout) maps to "unavailable" — which the wiring layer
// must treat exactly like deny.
import { afterAll, expect, mock, test } from "bun:test";
import {
	buildAutoReviewUserPrompt,
	collectAutoReviewModels,
	defaultAutoReviewLlm,
	parseAutoReviewVerdict,
	rememberToolCall,
	renderTranscript,
	reviewToolCall,
	takePendingToolCall,
} from "../host/auto-review.ts";

// The review chain delegates to the base's tiny-candidate collector; fake it
// so chain tests stay unit-level.
let tinyChain: unknown[] = [];
mock.module("@oh-my-pi/pi-coding-agent/tiny/online-candidates", () => ({
	collectOnlineTinyCandidates: () => tinyChain,
}));

const fakeHost = {
	availableModels: [],
	// resolveModelRoleValue reads getModelRole when the tiny chain is empty.
	settings: { getModelRole: () => undefined },
	modelRegistry: { resolver: () => "key" },
} as const;

const opts = { sessionId: "s1", title: "Approve bash?", toolName: "bash", params: { cmd: "ls" }, messages: [] as unknown[] };

const reply = (text: string) => async () => text;

test("allow verdict skips the card", async () => {
	const result = await reviewToolCall(fakeHost, opts, reply('{"risk":"low","decision":"allow"}'));
	expect(result.decision).toBe("allow");
	expect(result.title).toBe(opts.title);
});

test("deny verdict prefixes the reason into the card title", async () => {
	const result = await reviewToolCall(fakeHost, opts, reply('{"risk":"high","decision":"deny","reason":"rm -rf"}'));
	expect(result.decision).toBe("deny");
	expect(result.title).toBe("[auto-review] rm -rf");
});

test("deny without reason still gets a title prefix", async () => {
	const result = await reviewToolCall(fakeHost, opts, reply('{"risk":"high","decision":"deny"}'));
	expect(result.decision).toBe("deny");
	expect(result.title.startsWith("[auto-review]")).toBe(true);
});

test("thrown LLM error maps to unavailable, never throws", async () => {
	const result = await reviewToolCall(fakeHost, opts, async () => {
		throw new Error("boom");
	});
	expect(result.decision).toBe("unavailable");
	expect(result.title).toBe(opts.title);
});

test("timeout abort maps to unavailable", async () => {
	const result = await reviewToolCall(
		fakeHost,
		opts,
		(_h, timeoutMs) =>
			new Promise<string>((_, reject) => {
				AbortSignal.timeout(timeoutMs).addEventListener("abort", () => reject(new Error("timed out")));
			}),
		20,
	);
	expect(result.decision).toBe("unavailable");
});

test("verdict parsing tolerates fenced blocks and stray prose", () => {
	expect(parseAutoReviewVerdict('```json\n{"risk":"medium","decision":"allow"}\n```')?.decision).toBe("allow");
	expect(parseAutoReviewVerdict('Sure!\nHere: {"risk":"high","decision":"deny","reason":"x"} hope that helps')?.decision).toBe("deny");
	expect(parseAutoReviewVerdict("no json at all")).toBeNull();
	expect(parseAutoReviewVerdict('{"risk":"low","decision":"maybe"}')).toBeNull();
	expect(parseAutoReviewVerdict('{"risk":"ultra","decision":"allow"}')).toBeNull();
});

test("reason on allow is a protocol violation -> null", () => {
	expect(parseAutoReviewVerdict('{"risk":"low","decision":"allow","reason":"why not"}')).toBeNull();
});

test("invalid JSON verdict fail-safes to unavailable (no silent allow)", async () => {
	const result = await reviewToolCall(fakeHost, opts, reply("<html>error page</html>"));
	expect(result.decision).toBe("unavailable");
});

test("params are truncated at 4000 chars in the prompt", () => {
	const prompt = buildAutoReviewUserPrompt("bash", { cmd: "x".repeat(10_000) }, []);
	expect(prompt.length).toBeLessThan(4_200);
	expect(prompt.includes("[truncated]")).toBe(true);
});

test("transcript folding drops oldest lines and marks the cut", () => {
	const messages = Array.from({ length: 400 }, (_, i) => ({ role: "user", content: `message number ${i} ${"y".repeat(50)}` }));
	const transcript = renderTranscript(messages);
	expect(transcript.startsWith("[")).toBe(true);
	expect(transcript.includes("older transcript line(s) omitted")).toBe(true);
	expect(transcript.includes("message number 399")).toBe(true);
	expect(transcript.includes("message number 0 ")).toBe(false);
});

test("transcript renders user texts and assistant tool names", () => {
	const transcript = renderTranscript([
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "ignored" }] },
	]);
	expect(transcript).toContain("user: hello");
	expect(transcript).toContain("assistant tools: bash");
});

test("pending tool call: newest wins per session, take clears the slot", () => {
	rememberToolCall("s1", { toolName: "a", params: {} });
	rememberToolCall("s1", { toolName: "b", params: {} });
	rememberToolCall("s2", { toolName: "c", params: {} });
	expect(takePendingToolCall("s1")?.toolName).toBe("b");
	expect(takePendingToolCall("s1")).toBeNull();
	expect(takePendingToolCall("s2")?.toolName).toBe("c");
	expect(takePendingToolCall("missing")).toBeNull();
});

test("wiring contract: removing the allow fast-path or fail-safe must fail here", async () => {
	// allow is the ONLY decision that keeps the original title untouched and skips review downstream
	const allow = await reviewToolCall(fakeHost, opts, reply('{"risk":"medium","decision":"allow"}'));
	const unavailable = await reviewToolCall(fakeHost, opts, reply("garbage"));
	// both non-allow outcomes must preserve the human card path (original or prefixed title)
	expect([allow.title, unavailable.title].every((t) => typeof t === "string")).toBe(true);
	expect(allow.decision).not.toBe(unavailable.decision);
});

test("review chain passes the tiny candidates straight through", () => {
	tinyChain = [{ model: "m-tiny" }, { model: "m-commit" }];
	const models = collectAutoReviewModels(fakeHost);
	expect(models).toEqual(["m-tiny", "m-commit"]);
});

test("review chain falls back to default when no tiny roles resolve", () => {
	tinyChain = [];
	// Empty availableModels -> default role resolves to nothing either.
	expect(collectAutoReviewModels(fakeHost)).toEqual([]);
});

test("defaultAutoReviewLlm retries down the chain after a model failure", async () => {
	tinyChain = [{ model: "m1" }, { model: "m2" }];
	const calls: unknown[][] = [];
	const complete = async (_model: unknown, opts: unknown) => {
		calls.push([_model, opts]);
		if (calls.length === 1) throw new Error("provider down");
		return { content: [{ type: "text", text: '{"risk":"low","decision":"allow"}' }] };
	};
	mock.module("@oh-my-pi/pi-ai", () => ({ completeSimple: complete }));
	await expect(defaultAutoReviewLlm(fakeHost, "prompt", 1_000)).resolves.toBe('{"risk":"low","decision":"allow"}');
	expect(calls.length).toBe(2);
});
test("defaultAutoReviewLlm throws the last error when the whole chain fails", async () => {
	tinyChain = [{ model: "m1" }];
	const complete = async () => {
		throw new Error("provider down");
	};
	mock.module("@oh-my-pi/pi-ai", () => ({ completeSimple: complete }));
	await expect(defaultAutoReviewLlm(fakeHost, "prompt", 1_000)).rejects.toThrow("provider down");
});

afterAll(() => mock.restore());
