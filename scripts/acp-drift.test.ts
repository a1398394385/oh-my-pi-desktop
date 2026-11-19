// ACP total arithmetic (§5.1): every "context total" consumer reads the last
// provider-reported input size anchored to the local count of the request it
// answered — P_anchor + (L_current − L_anchor). A projection that did not
// change therefore reports exactly P_anchor; new messages add their local
// delta, a compression subtracts its local delta, and the anchor is dropped
// on model/branch changes. `promptTokens` is the provider's input size, never
// `usage.totalTokens` (which adds the output side).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-drift.test.ts
import { describe, expect, test } from "bun:test";
import { AcpRuntimeState } from "../host/acp-runtime.ts";
import type { AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData } from "../host/acp-persist.ts";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

const countTokens = (t: string) => t.length;
// Local side for the fixture: string content plus text parts and tool-call
// arguments, so the injected synthetic pair and ephemerals are really counted.
function messageText(m: AgentMessage): string {
	if (!("content" in m)) return "";
	const content = m.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ("text" in part && typeof part.text === "string") text += part.text;
		else if ("type" in part && part.type === "toolCall" && "arguments" in part) text += JSON.stringify(part.arguments);
	}
	return text;
}
const countMessages = (msgs: readonly AgentMessage[]) => msgs.reduce((n, m) => n + messageText(m).length, 0);

function fixture(options: { blocks?: number; params?: Partial<AcpParams>; contextWindow?: number } = {}) {
	const blocks = options.blocks ?? 3;
	const entries: SessionEntry[] = [];
	const view: AgentMessage[] = [];
	for (let i = 0; i < blocks; i++) {
		const id = `e${i}`;
		const message = { role: "user", content: "x".repeat(100), timestamp: 1 } as never as AgentMessage;
		entries.push({ type: "message", id, message } as never as SessionEntry);
		view.push(message);
	}
	const sink = { appendCustomEntry: (_type: string, _data: AcpSummaryData) => "s1" };
	const state = new AcpRuntimeState({
		countTokens,
		countMessages,
		sink,
		getEntries: () => entries,
		// v11: the L1 floor gates both tools; keep the tiny fixture past it.
		// No protected tail: the compression case keeps the newest journal block,
		// which the default tail would otherwise reject as protected.
		params: { minCompress: 0, tailTurns: 0, tailTokens: 0, tailUserMessages: 0, l1: 10, l2: 100_000, l3: 200_000, ...options.params },
		contextWindow: options.contextWindow,
	});
	return { state, entries, view };
}

/** The provider answered the request it just received. `usage.totalTokens` is
 * deliberately huge: the anchor must read `contextSnapshot.promptTokens`. */
function answer(entries: SessionEntry[], promptTokens: number): void {
	entries.push({
		type: "message",
		id: `a${entries.length}`,
		message: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			timestamp: 2,
			usage: {
				input: 450,
				output: 9_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: promptTokens + 9_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens, nonMessageTokens: 400 },
		},
	} as never as SessionEntry);
}

function statusText(state: AcpRuntimeState): string {
	const s = state.status();
	if (!s.ok) throw new Error(s.error);
	return s.text;
}

describe("ACP provider anchor", () => {
	test("an unchanged projection reports exactly the provider prompt size", () => {
		const fx = fixture();
		fx.state.projectView(fx.view); // no report yet: the local completeness estimate
		expect(statusText(fx.state)).toMatch(/tokens projected=300\b/);
		expect(statusText(fx.state)).toMatch(/tokens active=300\b/);

		answer(fx.entries, 850); // 850 input tokens; 450 of them messages, 9_000 are output
		fx.state.projectView(fx.view); // same projection as the request the report describes
		expect(statusText(fx.state)).toMatch(/tokens projected=850\b/);
		expect(statusText(fx.state)).toMatch(/tokens active=300\b/);
	});

	test("new messages add their local delta to the anchor", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		answer(fx.entries, 850);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens projected=850\b/);

		const message = { role: "user", content: "y".repeat(50), timestamp: 3 } as never as AgentMessage;
		fx.entries.push({ type: "message", id: "e3", message } as never as SessionEntry);
		fx.view.push(message);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens projected=900\b/);
		expect(statusText(fx.state)).toMatch(/tokens active=350\b/);
	});

	test("a compression subtracts its local delta from the anchor", async () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		answer(fx.entries, 850);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens projected=850\b/);

		fx.state.setManifest(["e0", "e1"]);
		const out = await fx.state.compress({ keep: [fx.state.shortRef("e2")!], summary: "folded early turns" });
		if (!out.ok) throw new Error(out.error);
		// A same-turn context_status read must see the post-write total at once.
		expect(fx.state.projectedTokenEstimate()).toBe(out.projectedTokensAfter);
		expect(statusText(fx.state)).toMatch(new RegExp(`tokens projected=${out.projectedTokensAfter}\\b`));
		fx.state.clearManifestOverride();
		fx.state.projectView(fx.view);
		const rs = fx.state.roundStatus;
		if (!rs) throw new Error("round status missing");
		// Zone render + the surviving block replace the folded pair; the total
		// moves by exactly that local delta.
		expect(rs.projectedTokens).toBe(850 + countMessages(fx.state.lastProjected) - 300);
		expect(rs.projectedTokens).toBeLessThan(850);
	});

	test("without a provider report the total stays local", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens projected=300\b/);
	});

	test("a projection with repeated injections reports exactly the provider prompt size", () => {
		// 40 blocks (~4000 tokens) over the guard line of a 20k window: every
		// request carries the forced ephemeral + the L3 synthetic status pair, so
		// the projection repeats byte-for-byte while the round state is unchanged.
		const fx = fixture({
			blocks: 40,
			contextWindow: 20_000,
			params: { l1: 10, l2: 20, l3: 100 },
		});
		fx.state.projectView(fx.view);
		const pinned = JSON.stringify(fx.state.lastProjected);
		expect(pinned).toContain("[compress-hint]");
		expect(pinned).toContain("[context-status]");
		expect(fx.state.roundStatus?.tier).toBe("L3");
		// No anchor yet: the local side really covers both injections.
		const local = countMessages(fx.state.lastProjected);
		expect(fx.state.roundStatus?.projectedTokens).toBe(local);

		// The same state injects again (per-request forced ephemeral) at the same
		// local size; this is the request the provider reports on.
		fx.state.projectView(fx.view);
		expect(countMessages(fx.state.lastProjected)).toBe(local);

		answer(fx.entries, 9_000);
		fx.state.projectView(fx.view);
		// Repeated injections, same projection size: the anchored total is the
		// report itself, not a block sum and not a scaled estimate.
		expect(countMessages(fx.state.lastProjected)).toBe(local);
		expect(fx.state.roundStatus?.projectedTokens).toBe(9_000);
		expect(statusText(fx.state)).toMatch(/tokens projected=9000\b/);
	});

	test("a base block in the zone counts once and is anchored afterwards", () => {
		// [m1,m2,m3, compaction(firstKept=m3)]: the base renders inside the zone,
		// while m3 stays the only active block (acceptance 16).
		const entries: SessionEntry[] = [];
		const view: AgentMessage[] = [];
		for (const id of ["m1", "m2", "m3"]) {
			const message = { role: "user", content: "x".repeat(100), timestamp: 1 } as never as AgentMessage;
			entries.push({ type: "message", id, message } as never as SessionEntry);
			if (id === "m3") view.push(message);
		}
		entries.push({
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "1970-01-01T00:00:01.000Z",
			firstKeptEntryId: "m3",
			summary: "base",
			tokensBefore: 300,
			tokensAfter: 4,
		} as never as SessionEntry);
		const state = new AcpRuntimeState({
			countTokens,
			countMessages,
			sink: { appendCustomEntry: () => "s1" },
			getEntries: () => entries,
			getBranch: () => entries,
			params: { minCompress: 0, l1: 10, l2: 100_000, l3: 200_000, tailTurns: 0, tailTokens: 0, tailUserMessages: 0 },
			contextWindow: 1000,
		});
		state.projectView(view);
		expect(state.degraded).toBe(false);
		const rs = state.roundStatus;
		if (!rs) throw new Error("round status missing");
		// One local count over the complete projection: the zone render is not
		// added on top of it.
		expect(rs.zoneTokens).toBeGreaterThan(0);
		expect(rs.projectedTokens).toBe(countMessages(state.lastProjected));

		answer(entries, 850);
		state.projectView(view);
		expect(state.roundStatus?.projectedTokens).toBe(850);
		expect(state.degraded).toBe(false);
	});

	test("a branch resync drops the pairing; the next total is local", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		answer(fx.entries, 850);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens projected=850\b/);

		fx.state.resyncToBranch(fx.entries);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens projected=300\b/);
	});
});
