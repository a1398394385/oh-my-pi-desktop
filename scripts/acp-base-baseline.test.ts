// ACP × base compaction boundaries (spec v3.6, acceptance 6-16/22/23/28):
// the base compaction entry is a zone root block derived from the CURRENT
// branch only, its retained tail keeps real journal ids, resets/rewinds drop
// stale eras, native-replay boundaries degrade per era, and strong chains
// carry the baseline identity while the newest rewrite time invalidates old
// bound-thinking signatures.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-base-baseline.test.ts
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { CompactionEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { AcpRuntimeState } from "../host/acp-runtime.ts";
import {
	ACP_SUMMARY_CUSTOM_TYPE,
	baselineBlock,
	branchCompactionFingerprint,
	rebuildAcpState,
	type AcpSummaryData,
} from "../host/acp-persist.ts";
import { annotateView } from "../host/acp-refs.ts";
import { assertToolPairing, projectContext, splitBlocks } from "../host/acp-projection.ts";

const countTokens = (t: string) => t.length;
const ISO = (ms: number) => new Date(ms).toISOString();

// thinking.prefixBinding target: bound signatures older than the newest rewrite
// are dropped by transformMessages, which is what historyRewriteAt must drive.
const boundModel = {
	id: "test-bound",
	name: "Test Bound",
	api: "anthropic-messages",
	provider: "anthropic",
	reasoning: true,
	thinking: { prefixBinding: true },
	compat: {},
} as never as Model;

// ---- journal fixtures -----------------------------------------------------------

let clock = 1;

function userEntry(id: string, text: string, ts = clock++): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: ISO(ts),
		message: { role: "user", content: text, timestamp: ts },
	} as never as SessionEntry;
}

function assistantEntry(id: string, text: string, ts = clock++, thinking?: string): SessionEntry {
	const content: unknown[] = [];
	if (thinking) content.push({ type: "thinking", thinking, thinkingSignature: `sig-${id}` });
	if (text) content.push({ type: "text", text });
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: ISO(ts),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-bound",
			timestamp: ts,
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		},
	} as never as SessionEntry;
}

function messageView(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries
		.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
		.map((e) => e.message);
}

function compactionEntry(
	id: string,
	firstKeptEntryId: string,
	summary: string,
	ts: number,
	extra: Partial<CompactionEntry> = {},
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: ISO(ts),
		firstKeptEntryId,
		summary,
		tokensBefore: 100,
		tokensAfter: 10,
		...extra,
	} as never as SessionEntry;
}

function resetEntry(id: string, ts = clock++): SessionEntry {
	return { type: "reset_boundary", id, parentId: null, timestamp: ISO(ts) } as never as SessionEntry;
}

function summaryEntry(
	id: string,
	createdAt: number,
	summary: string,
	meta: Partial<AcpSummaryData["meta"]> = {},
): SessionEntry {
	const data: AcpSummaryData = {
		id,
		summary,
		index: [],
		meta: {
			createdAt,
			depth: 0,
			method: "normal",
			keepIds: [],
			compressedIds: [],
			supersedes: [],
			tokensBefore: 10,
			tokensAfter: 5,
			...meta,
		} as AcpSummaryData["meta"],
	};
	return {
		type: "custom",
		customType: ACP_SUMMARY_CUSTOM_TYPE,
		id,
		parentId: null,
		timestamp: ISO(createdAt),
		data,
	} as never as SessionEntry;
}

// ---- projection helpers ---------------------------------------------------------

function projectRebuilt(branch: readonly SessionEntry[], view: AgentMessage[]): AgentMessage[] {
	const rebuilt = rebuildAcpState(branch);
	const source = annotateView(view, branch, rebuilt.alignFrom);
	const kept = new Set(
		splitBlocks(source, countTokens)
			.map((b) => b.id)
			.filter((id) => !rebuilt.compressedBlockIds.has(id)),
	);
	return projectContext(source, kept, rebuilt.zone, countTokens);
}

/** Actual provider transform: true when the bound thinking block was stripped. */
function thinkingStripped(messages: readonly AgentMessage[]): boolean {
	const out = transformMessages(messages as never as Message[], boundModel);
	const assistant = out.find((m) => m.role === "assistant") as AssistantMessage | undefined;
	if (!assistant) throw new Error("assistant tail missing from projection");
	return !assistant.content.some((c) => c.type === "thinking");
}

function rewriteTimes(messages: readonly AgentMessage[]): number[] {
	const times: number[] = [];
	for (const m of messages) if (m.role === "user" && m.historyRewriteAt !== undefined) times.push(m.historyRewriteAt);
	return times;
}

function runtime(branch: SessionEntry[], params: Record<string, number> = {}, window = 0) {
	return new AcpRuntimeState({
		countTokens,
		countMessages: (msgs) => msgs.length,
		sink: { appendCustomEntry: () => "sink" },
		getEntries: () => branch,
		getBranch: () => branch,
		params: { minCompress: 0, tailTurns: 0, tailTokens: 0, tailUserMessages: 0, ...params },
		contextWindow: window,
	});
}

// ---- 6/7: base block at the boundary, real ids, active accounting ---------------

describe("acceptance 6: base boundary becomes the zone root", () => {
	// [m1..m70, compaction(firstKept=m65), m71]: the retained tail starts at m65.
	const history = [
		...Array.from({ length: 70 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10))),
		compactionEntry("c1", "m65", "base summary", 1000),
		userEntry("m71", "y".repeat(13), 2000),
	];
	const view = messageView(history.slice(64));

	test("zone is the base block and compression stops before the kept entry", () => {
		const base = baselineBlock(history);
		expect(base.kind).toBe("block");
		if (base.kind !== "block") return;
		expect(base.boundaryEntryId).toBe("m65");

		const rebuilt = rebuildAcpState(history);
		expect(rebuilt.degraded).toBe(false);
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["c1"]);
		expect(rebuilt.zone[0].meta.method).toBe("base");
		for (let i = 1; i <= 64; i++) expect(rebuilt.compressedBlockIds.has(`m${i}`)).toBe(true);
		expect(rebuilt.compressedBlockIds.has("m65")).toBe(false);
		expect(rebuilt.alignFrom).toBe("m65");
	});

	test("alignment starts at the kept entry instead of re-scanning the branch head", () => {
		const aligned = annotateView(view, history, rebuildAcpState(history).alignFrom);
		expect(aligned.map((s) => s.id)).toEqual(["m65", "m66", "m67", "m68", "m69", "m70", "m71"]);
	});
});

describe("acceptance 7: projection ids, active tokens and manifest candidacy", () => {
	const prefix = Array.from({ length: 64 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10)));
	const tail = Array.from({ length: 6 }, (_, i) => userEntry(`m${65 + i}`, "x".repeat(10)));
	const history = [
		...prefix,
		...tail,
		compactionEntry("c1", "m65", "base summary", 1000),
		userEntry("m71", "z".repeat(9), 2000),
		summaryEntry("n1", 2000, "folded", { compressedIds: ["m71"] }),
	];
	// A view-only synthetic turn: active, counted, never a manifest candidate.
	const pseudo = { role: "user", content: "cont", synthetic: true, timestamp: 3000 } as never as AgentMessage;
	const view = [...messageView(tail), pseudo];

	test("retained messages keep real journal ids and all count as active", () => {
		const state = runtime(history);
		state.projectView(view);
		expect(state.lastSource.map((s) => s.id)).toEqual([...tail.map((e) => e.id), "view:6"]);
		// 6 x 10 plus the 4-token view-only message; the compressed m71 is not active.
		expect(state.roundStatus?.activeTokens).toBe(64);
		// candidates: the six retained blocks, never the positional pseudo id.
		expect(state.roundStatus?.manifestIds).toEqual(["m65", "m66", "m67", "m68", "m69", "m70"]);
	});

	test("tail-protected messages still count as active without entering the manifest", () => {
		const state = runtime(history, { tailUserMessages: 6 });
		state.projectView(view);
		expect(state.roundStatus?.activeTokens).toBe(64);
		expect(state.roundStatus?.manifestIds).toEqual([]);
	});
});

// ---- 8/9/10: zone composition, rewind, latest compaction ------------------------

describe("acceptance 8-10: zone composition across compaction generations", () => {
	test("8: a summary after the boundary joins the zone; one before it does not", () => {
		const history = [
			...Array.from({ length: 64 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10))),
			summaryEntry("a1", 500, "pre-boundary", { compressedIds: ["m1", "m2"] }),
			...Array.from({ length: 7 }, (_, i) => userEntry(`m${65 + i}`, "x".repeat(10))),
			compactionEntry("c1", "m65", "base summary", 1000),
			summaryEntry("s1", 2000, "post-boundary", { compressedIds: ["m65"] }),
		];
		const rebuilt = rebuildAcpState(history);
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["c1", "s1"]);
		expect(rebuilt.zone.some((z) => z.id === "a1")).toBe(false);
	});

	test("9: rewinding before the boundary restores the live summary, not degraded", () => {
		const full = [
			userEntry("m1", "a".repeat(10)),
			userEntry("m2", "b".repeat(10)),
			summaryEntry("a1", 500, "pre-boundary", { compressedIds: ["m1", "m2"] }),
			userEntry("m3", "c".repeat(10)),
			compactionEntry("c1", "m3", "base summary", 1000),
			userEntry("m4", "d".repeat(10)),
		];
		const rebuilt = rebuildAcpState(full.slice(0, 4));
		expect(rebuilt.degraded).toBe(false);
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["a1"]);
		expect(rebuilt.compactionId).toBeNull();
		expect(rebuilt.compressedBlockIds.has("m1")).toBe(true);
	});

	test("10: two base compactions — only the newest is the root", () => {
		const history = [
			...Array.from({ length: 10 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10))),
			compactionEntry("c1", "m5", "first base", 1000),
			...Array.from({ length: 54 }, (_, i) => userEntry(`m${i + 11}`, "x".repeat(10))),
			...Array.from({ length: 6 }, (_, i) => userEntry(`m${65 + i}`, "x".repeat(10))),
			compactionEntry("c2", "m65", "second base", 2000),
			userEntry("m71", "y".repeat(10), 3000),
		];
		const rebuilt = rebuildAcpState(history);
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["c2"]);
		expect(rebuilt.zone[0].summary).toBe("second base");
		for (let i = 1; i <= 64; i++) expect(rebuilt.compressedBlockIds.has(`m${i}`)).toBe(true);
	});
});

// ---- 11: reset eras -------------------------------------------------------------

describe("acceptance 11: /clear starts a fresh zone era", () => {
	const post = Array.from({ length: 70 }, (_, i) => userEntry(`r${i + 1}`, "r".repeat(10)));
	const older = Array.from({ length: 64 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10)));
	const oldTail = Array.from({ length: 6 }, (_, i) => userEntry(`m${65 + i}`, "x".repeat(10)));

	test("compaction before the reset leaves no base and no compressed ids", () => {
		const history = [
			...older,
			...oldTail,
			compactionEntry("c1", "m65", "base summary", 1000),
			resetEntry("reset1", 2000),
			...post,
		];
		const rebuilt = rebuildAcpState(history);
		expect(rebuilt.degraded).toBe(false);
		expect(rebuilt.zone).toEqual([]);
		expect(rebuilt.compressedBlockIds.size).toBe(0);
		expect(rebuilt.compactionId).toBeNull();
		expect(rebuilt.alignFrom).toBe("reset1");

		const view = messageView(post);
		const aligned = annotateView(view, history, rebuilt.alignFrom);
		expect(aligned.every((s) => !s.id.startsWith("view:"))).toBe(true);
		expect(aligned.map((s) => s.id)).toEqual(post.map((e) => e.id));

		const projected = projectRebuilt(history, view);
		expect(projected).toHaveLength(post.length);
		expect(projected.every((m) => m.role === "user")).toBe(true);
	});

	test("a summary before the reset neither lives in the zone nor compresses", () => {
		const history = [
			older[0],
			older[1],
			summaryEntry("a1", 500, "pre-reset", { compressedIds: ["m1", "m2"] }),
			resetEntry("reset1", 2000),
			...post,
		];
		const rebuilt = rebuildAcpState(history);
		expect(rebuilt.zone).toEqual([]);
		expect(rebuilt.compressedBlockIds.size).toBe(0);

		const view = messageView(post);
		const aligned = annotateView(view, history, rebuilt.alignFrom);
		expect(aligned.map((s) => s.id)).toEqual(post.map((e) => e.id));
		expect(projectRebuilt(history, view)).toHaveLength(post.length);
	});

	test("a second reset rebuilds even without a compaction, and the old summary stays dead", () => {
		const history = [
			resetEntry("reset1", 100),
			userEntry("r1", "r".repeat(10), 200),
			userEntry("r2", "r".repeat(10), 300),
			summaryEntry("a1", 400, "era one", { compressedIds: ["r1"] }),
		];
		const view = messageView(history);
		const state = runtime(history);
		state.projectView(view);
		expect(state.zone.map((z) => z.id)).toEqual(["a1"]);
		expect(state.compressed.has("r1")).toBe(true);

		history.push(resetEntry("reset2", 500));
		state.projectView(view);
		expect(state.zone).toEqual([]);
		expect(state.compressed.size).toBe(0);
	});
});

// ---- 12: native replay forms degrade per era ------------------------------------

describe("acceptance 12: native boundaries degrade only inside their era", () => {
	const forms: Array<[string, Partial<CompactionEntry>]> = [
		["anthropic payload", { preserveData: { anthropicCompaction: { provider: "anthropic", content: "native" } } }],
		["openai remote compaction", { preserveData: { openaiRemoteCompaction: { version: "v2" } } }],
		["snapcompact archive", { method: "snapcompact", preserveData: { snapcompact: { images: [] } } }],
	];

	for (const [label, extra] of forms) {
		test(`${label}: degraded on its branch era, recovered by rewind and reset`, () => {
			const history = [
				userEntry("m1", "a".repeat(10)),
				userEntry("m2", "b".repeat(10)),
				compactionEntry("c1", "m2", "native summary", 1000, extra),
			];
			const view = messageView(history.slice(1));

			const rebuilt = rebuildAcpState(history);
			expect(baselineBlock(history).kind).toBe("native");
			expect(rebuilt.degraded).toBe(true);
			expect(rebuilt.zone).toEqual([]);

			const state = runtime(history);
			const passed = state.projectView(view);
			expect(state.degraded).toBe(true);
			expect(passed).toHaveLength(view.length);
			expect(
				passed.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[acp-base]")),
			).toBe(false);

			// Rewind before the boundary: a restart derives a healthy era.
			expect(rebuildAcpState(history.slice(0, 2)).degraded).toBe(false);
			// Reset leaves the era: running and restarted states both recover.
			history.push(resetEntry("reset1", 2000));
			state.projectView(view);
			expect(state.degraded).toBe(false);
			expect(rebuildAcpState(history).degraded).toBe(false);
			const restarted = runtime(history);
			restarted.projectView(view);
			expect(restarted.degraded).toBe(false);
		});
	}
});

// ---- 13/14/23: strong chain over the base --------------------------------------

describe("acceptance 13/14/23: strong generations carry baseline identity and rewrite time", () => {
	// [m1..m64, c1(firstKept=m65), m65(assistant, ts 2000), m66..m70, s1(2000), s2(3000)]
	function chain() {
		const entries: SessionEntry[] = [];
		for (let i = 1; i <= 64; i++) entries.push(userEntry(`m${i}`, "x".repeat(10)));
		entries.push(assistantEntry("m65", "retained answer", 2000, "old bound reasoning"));
		for (let i = 66; i <= 70; i++) entries.push(userEntry(`m${i}`, "x".repeat(10)));
		entries.push(compactionEntry("c1", "m65", "base summary", 1000));
		const base = baselineBlock(entries);
		if (base.kind !== "block") throw new Error("fixture: base block missing");
		const swallowed = base.block.meta.compressedIds;
		entries.push(
			summaryEntry("s1", 2000, "base summary\n\nstrong one", {
				method: "strong",
				supersedesBase: "c1",
				compressedIds: swallowed,
			}),
			summaryEntry("s2", 3000, "base summary\n\nstrong one\n\nstrong two", {
				method: "strong",
				supersedes: ["s1"],
				supersedesBase: "c1",
				compressedIds: swallowed,
			}),
		);
		return { entries, s1At: entries.length - 2, tail: messageView(entries.slice(64, 70)) };
	}

	test("13: the strong summary swallows the base and rewrites at its own time", () => {
		const { entries, tail } = chain();
		const rebuilt = rebuildAcpState(entries);
		expect(rebuilt.degraded).toBe(false);
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["s2"]);
		expect(rebuilt.zone[0].meta.supersedesBase).toBe("c1");
		expect(baselineBlock(entries).kind).toBe("none");
		for (let i = 1; i <= 64; i++) expect(rebuilt.compressedBlockIds.has(`m${i}`)).toBe(true);

		const projected = projectRebuilt(entries, tail);
		const first = projected[0];
		if (first.role !== "user" || typeof first.content !== "string") throw new Error("fixture: base render missing");
		expect(first.content).toContain("base summary");
		expect(first.content.startsWith("[acp-base]")).toBe(false);
		expect(first.historyRewriteAt).toBe(3000);
		expect(first.timestamp).toBe(3000);
		expect(rewriteTimes(projected)).toEqual([3000]);

		// A tail message older than 3000 loses its binding.
		expect(thinkingStripped(projected)).toBe(true);
	});

	test("14: rewinding before the strong generation revives the base", () => {
		const { entries, s1At } = chain();
		const beforeStrong = entries.slice(0, s1At);
		const rebuilt = rebuildAcpState(beforeStrong);
		expect(baselineBlock(beforeStrong).kind).toBe("block");
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["c1"]);
		const projected = projectRebuilt(beforeStrong, messageView(beforeStrong.slice(64, 70)));
		const first = projected[0];
		if (first.role !== "user" || typeof first.content !== "string") throw new Error("fixture: base render missing");
		expect(first.content.startsWith("[acp-base]\n")).toBe(true);
		expect(rewriteTimes(projected)).toEqual([1000]);
	});

	test("23: generations inherit the baseline id and each keeps its own rewrite time", () => {
		const { entries, s1At, tail } = chain();
		const onlyS1 = entries.slice(0, s1At + 1);

		const s2state = rebuildAcpState(entries);
		expect(s2state.zone[0].meta.supersedesBase).toBe("c1");
		const s2projected = projectRebuilt(entries, tail);
		expect(rewriteTimes(s2projected)).toEqual([3000]);
		expect(thinkingStripped(s2projected)).toBe(true);

		const s1state = rebuildAcpState(onlyS1);
		expect(s1state.zone.map((z) => z.id)).toEqual(["s1"]);
		expect(s1state.zone[0].meta.supersedesBase).toBe("c1");
		const s1projected = projectRebuilt(onlyS1, tail);
		expect(rewriteTimes(s1projected)).toEqual([2000]);
		// The 2000-time tail assistant is exactly at the rewrite: stripped.
		expect(thinkingStripped(s1projected)).toBe(true);

		const baseBranch = entries.slice(0, s1At);
		const baseProjected = projectRebuilt(baseBranch, tail);
		expect(rewriteTimes(baseProjected)).toEqual([1000]);
		expect(thinkingStripped(baseProjected)).toBe(false);
	});
});

// ---- 15: projection output shape ------------------------------------------------

describe("acceptance 15: projected base block shape", () => {
	const history = [
		...Array.from({ length: 64 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10))),
		assistantEntry("m65", "retained answer", 500, "old bound reasoning"),
		userEntry("m66", "next", 600),
		compactionEntry("c1", "m65", "base summary", 1000),
	];
	const base = messageView(history.slice(64));
	const summary = { role: "compactionSummary", summary: "base wrote this", timestamp: 900 } as never as AgentMessage;

	test("no compactionSummary, fixed header, millisecond rewrite time, pairing intact", () => {
		const state = runtime(history);
		const projected = state.projectView([summary, ...base]);
		expect(projected.map((m) => String(m.role))).not.toContain("compactionSummary");
		const first = projected[0];
		if (first.role !== "user" || typeof first.content !== "string") throw new Error("fixture: base render missing");
		expect(first.content.split("\n")[0]).toBe("[acp-base]");
		expect(first.content).toBe("[acp-base]\nbase summary");
		expect(Number.isFinite(first.timestamp)).toBe(true);
		expect(Number.isFinite(first.historyRewriteAt)).toBe(true);
		expect(first.timestamp).toBe(Date.parse("1970-01-01T00:00:01.000Z"));
		expect(first.historyRewriteAt).toBe(first.timestamp);
		// The dropped summary is still annotated (positionally), the tail keeps real ids.
		expect(state.lastSource.map((s) => s.id)).toEqual(["view:0", "m65", "m66"]);
		assertToolPairing(projected);
	});

	test("the base rewrite time strips retained bound thinking", () => {
		expect(thinkingStripped(projectRebuilt(history, base))).toBe(true);
	});
});

// ---- 22: sibling branch cache and journal tail ---------------------------------

describe("acceptance 22: sibling branches never feed the takeover", () => {
	test("a cache from another branch is refused and sibling boundaries are ignored", () => {
		const branchA = [
			userEntry("a1", "a".repeat(10)),
			userEntry("a2", "a".repeat(10)),
			userEntry("a3", "a".repeat(10)),
			userEntry("a4", "a".repeat(10)),
			compactionEntry("ca", "a2", "base A", 1000),
		];
		const journal = [...branchA, compactionEntry("cs", "a2", "base sibling", 1500)];
		const branchB = [userEntry("b1", "b".repeat(10)), userEntry("b2", "b".repeat(10))];

		const state = new AcpRuntimeState({
			countTokens,
			sink: { appendCustomEntry: () => "sink" },
			getEntries: () => journal,
			getBranch: () => branchA,
			params: { minCompress: 0 },
		});
		state.projectView(messageView(branchA.slice(2)));
		expect(state.activeZoneMessages(branchA)).not.toBeNull();

		// Branch B is not a same-branch append: the cached A projection must not be summarized.
		expect(state.activeZoneMessages(branchB)).toBeNull();
		// Journal entries outside the branch cannot become B's baseline.
		expect(branchCompactionFingerprint(branchB).compactionId).toBeNull();
		expect(baselineBlock(branchB).kind).toBe("none");
		expect(rebuildAcpState(branchB).zone).toEqual([]);
	});
});

// ---- 28: a later normal rewrite invalidates the retained signature ---------------

describe("acceptance 28: normal compression after the base rewrites the prefix", () => {
	const history = [
		...Array.from({ length: 64 }, (_, i) => userEntry(`m${i + 1}`, "x".repeat(10))),
		assistantEntry("m65", "retained answer", 2000, "old bound reasoning"),
		userEntry("m66", "folded", 2500),
		compactionEntry("c1", "m65", "base summary", 1000),
		summaryEntry("n1", 5000, "normal rewrite", { compressedIds: ["m66"] }),
	];
	const view = messageView(history.slice(64, 66));

	test("runtime and restart agree on the normal summary's rewrite time", () => {
		const rebuilt = rebuildAcpState(history);
		expect(rebuilt.zone.map((z) => z.id)).toEqual(["c1", "n1"]);
		const restarted = projectRebuilt(history, view);
		expect(rewriteTimes(restarted)).toEqual([1000, 5000]);
		expect(thinkingStripped(restarted)).toBe(true);

		const running = runtime(history).projectView(view);
		expect(rewriteTimes(running)).toEqual([1000, 5000]);
		expect(thinkingStripped(running)).toBe(true);
	});
});
