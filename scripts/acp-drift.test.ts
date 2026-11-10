// ACP ratio calibration (§5.2): the provider's billed message tokens and the
// local counter disagree by an encoding error rate over the content, so the
// active zone learns that scale from the last request's contextSnapshot instead
// of trusting the block sum. Learned as a ratio because the content changes
// (compression) while the encoding does not (2026-11-03: a 269,442-token local
// projection billed 229,184 — a −15% scale that an absolute offset could not
// carry across a compression).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-drift.test.ts
import { describe, expect, test } from "bun:test";
import { AcpRuntimeState } from "../host/acp-runtime.ts";
import type { AcpSummaryData } from "../host/acp-persist.ts";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

const countTokens = (t: string) => t.length;
// Whole-list basis for the fixture: only user messages carry text here.
const countMessages = (msgs: readonly AgentMessage[]) =>
	msgs.reduce((n, m) => n + ("content" in m && typeof m.content === "string" ? m.content.length : 0), 0);

function fixture() {
	const entries: SessionEntry[] = [];
	const view: AgentMessage[] = [];
	for (const id of ["e0", "e1", "e2"]) {
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
		params: { minCompress: 0 },
	});
	return { state, entries, view };
}

function statusText(state: AcpRuntimeState): string {
	const s = state.status();
	if (!s.ok) throw new Error(s.error);
	return s.text;
}

describe("ACP ratio calibration", () => {
	test("the active zone carries the provider's learned scale", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens active=300\b/);

		// The provider answers the request it just received: 850 prompt tokens,
		// of which the base counter already estimates 400 as system + tools, so
		// the message side really cost 450 — 1.5x the local 300.
		fx.entries.push({
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				timestamp: 2,
				contextSnapshot: { promptTokens: 850, nonMessageTokens: 400 },
			},
		} as never as SessionEntry);

		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens active=450\b/);
	});

	test("one anomalous report cannot swing the zone past the clamp", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		fx.entries.push({
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				timestamp: 2,
				contextSnapshot: { promptTokens: 10_000, nonMessageTokens: 400 },
			},
		} as never as SessionEntry);

		fx.state.projectView(fx.view);
		// Clamped at 1.6x the local 300, not the 32x the report implies.
		expect(statusText(fx.state)).toMatch(/tokens active=480\b/);
	});

	test("the learned scale survives a shrunken active zone (compression)", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		fx.entries.push({
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				timestamp: 2,
				contextSnapshot: { promptTokens: 850, nonMessageTokens: 400 },
			},
		} as never as SessionEntry);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens active=450\b/);

		// Compression folds two of the three blocks away: the scale still applies
		// to what is left (a learned offset would have kept charging 450).
		fx.state.projectView([fx.view[0]]);
		expect(statusText(fx.state)).toMatch(/tokens active=150\b/);
	});

	test("without a provider report the active zone stays local", () => {
		const fx = fixture();
		fx.state.projectView(fx.view);
		fx.state.projectView(fx.view);
		expect(statusText(fx.state)).toMatch(/tokens active=300\b/);
	});

	test("a base block in the zone counts once and leaves the clamp intact", () => {
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
			params: { minCompress: 0, tailTurns: 0, tailTokens: 0, tailUserMessages: 0 },
			contextWindow: 1000,
		});
		state.projectView(view);
		expect(state.degraded).toBe(false);

		// Billed 450 message tokens against a local 100+zone basis: clamped to 1.6,
		// not the 4.5x the report implies, and the zone is never double counted.
		entries.push({
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				timestamp: 2,
				contextSnapshot: { promptTokens: 850, nonMessageTokens: 400 },
			},
		} as never as SessionEntry);
		state.projectView(view);
		const rs = state.roundStatus;
		if (!rs) throw new Error("round status missing");
		expect(statusText(state)).toMatch(/tokens active=160\b/);
		expect(rs.zoneTokens).toBeGreaterThan(0);
		expect(rs.projectedTokens).toBe(rs.activeTokens + rs.zoneTokens);
		expect(state.degraded).toBe(false);

		// The floor holds too: a report far below the local basis lands on 0.7.
		entries.push({
			type: "message",
			id: "a2",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				timestamp: 3,
				contextSnapshot: { promptTokens: 450, nonMessageTokens: 400 },
			},
		} as never as SessionEntry);
		state.projectView(view);
		expect(statusText(state)).toMatch(/tokens active=70\b/);
		expect(state.degraded).toBe(false);
	});
});
