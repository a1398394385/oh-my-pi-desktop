// ACP base-compaction takeover (spec W1-W5, R6): when the base asks to compact,
// ACP summarizes the projection's active prefix and hands back a `compaction`,
// or yields with `undefined` (never `cancel`, never a second degrade path).
// The old BUG-129 guard cancelled threshold/idle runs and pre-degraded on
// overflow; v3.6 replaces that behaviour, so these tests pin the takeover
// contract: exact model input, the retained-tail cut, W4's candidate basis,
// cancellation, and branch-scoped snapshots.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-compaction-guard.test.ts
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { createAcpProjectionExtension } from "../host/acp-assembly.ts";
import { AcpRuntimeState } from "../host/acp-runtime.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CompleteCall = { messages: AgentMessage[]; signal: AbortSignal };
type TakeoverResult = { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } };

const OWNER = "owner-session";
// Fixed threshold 100K on a 200K window: the recovery band (W4 target line) is 80K.
const THRESHOLD_TOKENS = 100_000;
const MODEL = { provider: "test", id: "takeover-model", contextWindow: 200_000 } as never;

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part?.type === "text" && "text" in part ? String(part.text) : ""))
		.join("");
}

function messageEntry(id: string, parentId: string | null, text: string, role: "user" | "assistant" = "user"): Extract<SessionEntry, { type: "message" }> {
	const message =
		role === "user"
			? { role, content: text, timestamp: 1 }
			: { role, content: [{ type: "text", text }], timestamp: 1 };
	return { type: "message", id, parentId, timestamp: "2026-11-10T00:00:00Z", message } as never;
}

/** A linear user-only conversation: user block ids are entry ids, which keeps
 * compressed-id fixtures readable. Tests that need a reply add an assistant entry. */
function conversation(ids: readonly string[], size = 40): SessionEntry[] {
	return ids.map((id, i) => messageEntry(id, i === 0 ? null : ids[i - 1], `${id} ${"x".repeat(size)}`));
}

function summaryEntry(
	id: string,
	parentId: string | null,
	summary: string,
	compressedIds: string[],
): SessionEntry {
	return {
		type: "custom",
		customType: "acpSummary",
		id,
		parentId,
		timestamp: "2026-11-10T00:00:01Z",
		data: {
			summary,
			index: [],
			meta: {
				createdAt: 1_000,
				depth: 0,
				method: "normal",
				keepIds: [],
				compressedIds,
				supersedes: [],
				tokensBefore: 10,
				tokensAfter: 5,
			},
		},
	} as never;
}

function compactionEntry(
	id: string,
	parentId: string | null,
	summary: string,
	firstKeptEntryId: string,
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-11-10T00:00:02Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 110_000,
		tokensAfter: 38_000,
	} as never;
}

function viewOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

interface HarnessOptions {
	countMessages?: (messages: readonly AgentMessage[]) => number;
	nonMessageTokens?: number;
	timeoutMs?: number;
	/** Model reply; the default returns a non-empty summary. */
	reply?: (call: CompleteCall) => unknown | Promise<unknown>;
}

function harness(branch: SessionEntry[], options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler>();
	const calls: CompleteCall[] = [];
	let current = branch;
	const state = new AcpRuntimeState({
		countTokens: (text) => text.length,
		countMessages: options.countMessages ?? ((messages) => messages.reduce((n, m) => n + textOf(m).length, 0)),
		sink: { appendCustomEntry: () => "written" },
		getEntries: () => current,
		getBranch: () => current,
		contextWindow: 200_000,
	});
	state.resyncToBranch(current);
	const complete = async (_model: unknown, request: { messages: AgentMessage[] }, run: { signal: AbortSignal }) => {
		const call = { messages: request.messages, signal: run.signal };
		calls.push(call);
		return options.reply
			? await options.reply(call)
			: { content: [{ type: "text", text: "fresh summary" }], stopReason: "stop" };
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	createAcpProjectionExtension(state, () => OWNER, {
		settings: Settings.isolated({ "compaction.thresholdTokens": THRESHOLD_TOKENS }),
		getModel: () => MODEL,
		getApiKey: () => "mock-key",
		getNonMessageTokens: () => options.nonMessageTokens ?? 0,
		complete: complete as never,
		timeoutMs: options.timeoutMs,
		now: () => 7_000,
	})(pi as never);
	const fire = (event: string, payload: unknown = {}, sessionId = OWNER): unknown =>
		handlers.get(event)?.(payload, {
			sessionManager: { getSessionId: () => sessionId },
			model: MODEL,
			modelRegistry: { resolver: () => ({}) },
		});
	const compact = (
		branchEntries: SessionEntry[],
		firstKeptEntryId: string,
		signal?: AbortSignal,
		sessionId = OWNER,
	): Promise<TakeoverResult | undefined> =>
		fire(
			"session_before_compact",
			{
				type: "session_before_compact",
				preparation: {
					firstKeptEntryId,
					// The base's own journal extraction is exactly what W2 forbids sending.
					messagesToSummarize: [{ role: "user", content: "journal original must not be sent", timestamp: 1 }],
					tokensBefore: 110_000,
				},
				branchEntries,
				signal: signal ?? new AbortController().signal,
			},
			sessionId,
		) as Promise<TakeoverResult | undefined>;
	const project = (entries: readonly SessionEntry[]) => state.projectView(viewOf(entries));
	const setBranch = (next: SessionEntry[]) => {
		current = next;
	};
	return { state, calls, fire, compact, project, setBranch };
}

describe("ACP base compaction takeover", () => {
	test("summarizes only the active prefix before firstKeptEntryId and passes the zone as previousSummary", async () => {
		const head = conversation(["m1", "m2", "m3"]);
		const summary = summaryEntry("A", "m3", "folded early turns", ["m1", "m2"]);
		const tail = [
			messageEntry("m4", "A", "retained four"),
			messageEntry("m5", "m4", "retained five"),
		];
		const branch = [...head, summary, ...tail];
		const h = harness(branch);
		h.project(branch);

		const result = await h.compact(branch, "m4");

		expect(result?.compaction).toEqual({
			summary: "fresh summary",
			firstKeptEntryId: "m4",
			tokensBefore: expect.any(Number),
		});
		expect(h.calls).toHaveLength(1);
		const [call] = h.calls;
		// m3 is the only active message before the cut; m4/m5 are the base's
		// retained tail and the folded m1/m2 never come back as raw journal text.
		expect(call.messages).toHaveLength(2);
		expect(textOf(call.messages[0])).toBe("m3 " + "x".repeat(40));
		const prompt = textOf(call.messages[1]);
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain("folded early turns");
		expect(prompt).toContain("[acp-summary");
		expect(prompt).not.toContain("journal original must not be sent");
		expect(prompt).not.toContain("retained four");
		expect(prompt).not.toContain("retained five");
	});

	test("cuts at firstKeptEntryId: only the prefix is new work, the zone is inherited whole", async () => {
		const head = conversation(["m1", "m2", "m3", "m4"]);
		const summary = summaryEntry("A", "m4", "folded early turns", ["m1", "m2"]);
		const branch = [...head, summary, messageEntry("m5", "A", "retained five")];

		// firstKept=m4: m3 is the only uncompressed prefix message; m4/m5 stay out.
		const atM4 = harness(branch);
		atM4.project(branch);
		const four = await atM4.compact(branch, "m4");
		expect(four?.compaction?.firstKeptEntryId).toBe("m4");
		expect(atM4.calls[0].messages).toHaveLength(2);
		expect(textOf(atM4.calls[0].messages[0])).toBe("m3 " + "x".repeat(40));
		expect(textOf(atM4.calls[0].messages[1])).toContain("folded early turns");

		// firstKept=m3: the compression prefix is empty, so C only inherits A.
		const atM3 = harness(branch);
		atM3.project(branch);
		const three = await atM3.compact(branch, "m3");
		expect(three?.compaction?.firstKeptEntryId).toBe("m3");
		expect(atM3.calls[0].messages).toHaveLength(1);
		expect(textOf(atM3.calls[0].messages[0])).toContain("folded early turns");
	});

	test("an overflow or incomplete auto run takes over like any other and never degrades", async () => {
		const branch = conversation(["m1", "m2"]);
		for (const reason of ["overflow", "incomplete", "threshold", "idle"]) {
			const h = harness(branch);
			h.project(branch);
			h.fire("auto_compaction_start", { reason });
			expect((await h.compact(branch, "m2"))?.compaction).toBeDefined();
			expect(h.state.degraded).toBe(false);
		}
	});

	test("yields when the active view carries a pseudo id", async () => {
		const branch = conversation(["m1", "m2", "m3"]);
		const h = harness(branch);
		// A base-synthesized reminder has no journal entry, so annotateView gives
		// it a `view:` id: the cut cannot be proven and the hook must yield.
		h.state.projectView([
			...viewOf(branch),
			{ role: "user", content: "reminder not in the journal", synthetic: true, timestamp: 1 },
		]);

		expect(await h.compact(branch, "m2")).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("yields when firstKeptEntryId is missing or empty", async () => {
		const branch = conversation(["m1", "m2"]);
		const h = harness(branch);
		h.project(branch);
		expect(await h.compact(branch, "")).toBeUndefined();
		expect(await h.compact(branch, "not-on-the-branch")).toBeUndefined();
		// Nothing new before the cut and no zone to inherit: nothing to persist.
		expect(await h.compact(branch, "m1")).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("W4 judges the candidate result, not the pre-compaction projection", async () => {
		// 110K prefix + 20K retained tail, 8K summary, 10K non-message overhead:
		// 8,011 + 20,000 + 10,000 = 38,011 lands inside the 80K recovery band.
		const prefix = messageEntry("p1", null, "p1" + "x".repeat(109_998));
		const retained = messageEntry("r1", "p1", "r1" + "x".repeat(19_998));
		const branch = [prefix, retained];
		let counted: readonly AgentMessage[] = [];
		const h = harness(branch, {
			nonMessageTokens: 10_000,
			countMessages: (messages) => {
				counted = messages;
				return messages.reduce((n, m) => n + textOf(m).length, 0);
			},
			reply: () => ({ content: [{ type: "text", text: "s".repeat(8_000) }], stopReason: "stop" }),
		});
		h.project(branch);

		const result = await h.compact(branch, "r1");

		expect(result?.compaction?.summary).toHaveLength(8_000);
		// The pair inspecting the candidate: rendered [acp-base] block + the
		// actually retained original messages; the old zone/history is not resent.
		expect(textOf(counted[0]).startsWith("[acp-base]\n")).toBe(true);
		expect(counted).toHaveLength(2);
		expect(textOf(counted[1])).toBe("r1" + "x".repeat(19_998));
		expect(h.state.projectedTokenEstimate()).toBeGreaterThan(100_000);
	});

	test("W4 compares against the recovery band and yields when the candidate exceeds it", async () => {
		const prefix = messageEntry("p1", null, "p1" + "x".repeat(109_998));
		const retained = messageEntry("r1", "p1", "r1" + "x".repeat(19_998));
		const branch = [prefix, retained];
		const countMessages = (messages: readonly AgentMessage[]) =>
			messages.reduce((n, m) => n + textOf(m).length, 0);
		const run = async (summarySize: number) => {
			const h = harness(branch, {
				nonMessageTokens: 10_000,
				countMessages,
				reply: () => ({ content: [{ type: "text", text: "s".repeat(summarySize) }], stopReason: "stop" }),
			});
			h.project(branch);
			return { result: await h.compact(branch, "r1"), calls: h.calls.length };
		};

		// Exactly on the 80K line: 49,989 + 11 header + 20,000 + 10,000 = 80,000.
		expect((await run(49_989)).result?.compaction).toBeDefined();
		// One token over: 49,990 + 11 + 20,000 + 10,000 = 80,001.
		const over = await run(49_990);
		expect(over.result).toBeUndefined();
		expect(over.calls).toBe(1);
	});

	test("yields on an already-aborted event signal without calling the model", async () => {
		const branch = conversation(["m1", "m2"]);
		const h = harness(branch);
		h.project(branch);
		const aborted = new AbortController();
		aborted.abort();

		expect(await h.compact(branch, "m2", aborted.signal)).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("aborting the event signal cancels the in-flight request and yields", async () => {
		const branch = conversation(["m1", "m2"]);
		let observedAbort = false;
		const h = harness(branch, {
			reply: (call) => {
				const { promise, resolve } = Promise.withResolvers<unknown>();
				call.signal.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						resolve({ content: [{ type: "text", text: "late summary" }], stopReason: "stop" });
					},
					{ once: true },
				);
				return promise;
			},
		});
		h.project(branch);
		const controller = new AbortController();
		const pending = h.compact(branch, "m2", controller.signal);
		controller.abort();

		expect(await pending).toBeUndefined();
		expect(observedAbort).toBe(true);
	});

	test("the 25s ACP deadline aborts the model request and only then yields", async () => {
		const branch = conversation(["m1", "m2"]);
		const order: string[] = [];
		const h = harness(branch, {
			timeoutMs: 20,
			reply: (call) => {
				const { promise, resolve } = Promise.withResolvers<unknown>();
				call.signal.addEventListener(
					"abort",
					() => {
						order.push("aborted");
						// The handler must wait for the request to settle; a late
						// response still cannot be written.
						order.push("request-ended");
						resolve({ content: [{ type: "text", text: "late summary" }], stopReason: "stop" });
					},
					{ once: true },
				);
				return promise;
			},
		});
		h.project(branch);
		const eventSignal = new AbortController();
		const pending = h.compact(branch, "m2", eventSignal.signal);

		expect(await pending).toBeUndefined();
		order.push("handler-returned");
		expect(order).toEqual(["aborted", "request-ended", "handler-returned"]);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].signal).not.toBe(eventSignal.signal);
		expect(h.calls[0].signal.aborted).toBe(true);
		// The ACP deadline is its own cancellation source; the event's signal was
		// never touched, and the 30s outer timeout is not evidence of cancellation.
		expect(eventSignal.signal.aborted).toBe(false);
	});

	test("extends the snapshot for a same-branch leaf append instead of yielding", async () => {
		const head = conversation(["m1", "m2", "m3"]);
		const h = harness(head);
		h.project(head);

		const withReply = [...head, messageEntry("m4", "m3", "reply four", "assistant")];
		const first = await h.compact(withReply, "m4");

		expect(first?.compaction?.firstKeptEntryId).toBe("m4");
		expect(h.calls[0].messages).toHaveLength(4);
		expect(h.calls[0].messages.slice(0, 3).map(textOf)).toEqual([
			"m1 " + "x".repeat(40),
			"m2 " + "x".repeat(40),
			"m3 " + "x".repeat(40),
		]);
		expect(h.state.lastSource.map((source) => source.id)).toEqual(["m1", "m2", "m3", "m4"]);

		// A second append continues from the advanced snapshot, not from m3.
		const withSecond = [...withReply, messageEntry("m5", "m4", "reply five", "assistant")];
		const second = await h.compact(withSecond, "m5");
		expect(second?.compaction).toBeDefined();
		expect(h.state.lastSource.map((source) => source.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	});

	test("re-identifies an in-flight user message once it lands before post-turn compaction", async () => {
		const head = conversation(["m1", "m2"]);
		const h = harness(head);
		h.project(head);
		const inFlight = messageEntry("m3", "m2", "current request");
		h.state.projectView([...viewOf(head), inFlight.message]);
		expect(h.state.lastSource.at(-1)?.id.startsWith("view:")).toBe(true);

		const landed = [...head, inFlight, messageEntry("m4", "m3", "reply four", "assistant")];
		h.setBranch(landed);
		const result = await h.compact(landed, "m4");

		expect(result?.compaction).toBeDefined();
		expect(h.state.lastSource.map((source) => source.id)).toEqual(["m1", "m2", "m3", "m4"]);
		expect(h.calls[0].messages.slice(0, -1).map(textOf)).toEqual([
			"m1 " + "x".repeat(40),
			"m2 " + "x".repeat(40),
			"current request",
		]);
	});

	test("yields when the cached snapshot is not a prefix of the current branch", async () => {
		const branch = conversation(["m1", "m2", "m3"]);
		const h = harness(branch);
		h.project(branch);

		// The leaf moved to a sibling that does not share the captured prefix.
		const sibling = [messageEntry("x1", null, "sibling one"), messageEntry("x2", "x1", "sibling two")];
		const reordered = [sibling[0], branch[1], branch[2]];
		expect(await h.compact(reordered, "m3")).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("yields when the appended region carries a compaction boundary", async () => {
		const branch = conversation(["m1", "m2", "m3"]);
		const h = harness(branch);
		h.project(branch);

		const compacted = [...branch, compactionEntry("C", "m3", "base summary", "m2")];
		expect(await h.compact(compacted, "m3")).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("yields when a live zone block overlaps the retained tail", async () => {
		const head = conversation(["m1", "m2", "m3", "m4"]);
		// A folded m4 even though m4 is about to become the base's retained tail:
		// swallowing A would resurrect m4's original next to the summary.
		const summary = summaryEntry("A", "m4", "folds m1 and m4", ["m1", "m4"]);
		const branch = [...head, summary, messageEntry("m5", "A", "tail five")];
		const h = harness(branch);
		h.project(branch);

		expect(await h.compact(branch, "m3")).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("yields on an empty or whitespace-only model reply", async () => {
		const branch = conversation(["m1", "m2"]);
		const h = harness(branch, {
			reply: () => ({ content: [{ type: "text", text: "  \n\t " }], stopReason: "stop" }),
		});
		h.project(branch);

		expect(await h.compact(branch, "m2")).toBeUndefined();
		expect(h.calls).toHaveLength(1);
	});

	test("owner takes over; child sessions and non-owner events pass through untouched", async () => {
		const branch = conversation(["m1", "m2"]);
		const h = harness(branch);
		h.project(branch);

		expect(await h.compact(branch, "m2", undefined, "child-session")).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	test("auto_compaction_end and session_compact resync the owner branch only", () => {
		const base = conversation(["m1", "m2"]);
		const folded = [...base, summaryEntry("A", "m2", "folded m1", ["m1"])];

		const auto = harness(folded);
		auto.project(folded);
		expect(auto.state.zone.map((block) => block.id)).toEqual(["A"]);
		auto.setBranch(base);
		auto.fire("auto_compaction_start", { reason: "threshold" });
		auto.fire("auto_compaction_end");
		expect(auto.state.zone).toEqual([]);
		expect(auto.state.lastSource).toEqual([]);

		const compactEvent = harness(folded);
		compactEvent.project(folded);
		compactEvent.setBranch(base);
		compactEvent.fire("session_compact", {}, OWNER);
		expect(compactEvent.state.zone).toEqual([]);
		expect(compactEvent.state.lastSource).toEqual([]);

		const child = harness(folded);
		child.setBranch(base);
		child.fire("auto_compaction_start", { reason: "threshold" }, "child-session");
		child.fire("auto_compaction_end");
		child.fire("session_compact", {}, "child-session");
		expect(child.state.zone.map((block) => block.id)).toEqual(["A"]);
	});

	test("the persisted summary projects as one [acp-base] root with the retained tail once", () => {
		const head = conversation(["m1", "m2", "m3", "m4"]);
		const summary = summaryEntry("A", "m4", "folded early turns", ["m1", "m2"]);
		const tail = messageEntry("m5", "A", "retained five");
		const branch = [...head, summary, tail];

		const assertProjection = (firstKeptEntryId: string, expected: string[]) => {
			const compaction = compactionEntry("C", "m5", "fresh base summary", firstKeptEntryId);
			const after = [...branch, compaction];
			const h = harness(after);
			const baseView: AgentMessage[] = [
				{ role: "compactionSummary", summary: "fresh base summary", tokensBefore: 110_000, timestamp: 1 },
				...viewOf(branch.slice(branch.findIndex((entry) => entry.id === firstKeptEntryId)).filter((entry) => entry.type === "message")),
			];
			const texts = h.state.projectView(baseView).map(textOf);
			expect(texts).toHaveLength(expected.length + 1);
			expect(texts[0].startsWith("[acp-base]\nfresh base summary")).toBe(true);
			expect(texts.some((text) => text.includes("[acp-summary"))).toBe(false);
			for (const text of expected) expect(texts.filter((line) => line === text)).toHaveLength(1);
		};

		// firstKept=m4: C covers m1..m3; the old A does not render and m4/m5 appear once.
		assertProjection("m4", ["m4 " + "x".repeat(40), "retained five"]);
		// firstKept=m3: the compression prefix is empty, C only inherits A.
		assertProjection("m3", ["m3 " + "x".repeat(40), "m4 " + "x".repeat(40), "retained five"]);
	});
});
