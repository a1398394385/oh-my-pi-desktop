// Live turn seal (ui-src/store/run-seal.ts) must fold an error row into the process group
// like any other event, and still lift the turn's final answer out of it. Regression for the
// layout where error rows were stripped to the very end of the run, so every failure trailed
// the agent output instead of sitting in the fold. Reload path: host/translate-history.ts,
// covered by scripts/translate-history-run-error.test.ts.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/run-seal-error.test.ts
import { describe, expect, test } from "bun:test";
import { endingErrorText, sealRunItems, turnEndedWithError } from "../ui-src/store/run-seal";
import type { LoopItem, OpenSession, SessionItem } from "../ui-src/types/session";

function session(items: SessionItem[]): OpenSession {
	return { items, turnItemStart: 1, turnStartAt: Date.now() } as unknown as OpenSession;
}

const roles = (items: SessionItem[]) => items.map((it) => it.role);
const group = (s: OpenSession): LoopItem => s.items[1] as LoopItem;

describe("sealRunItems", () => {
	test("an error row folds into the process group instead of trailing the output", () => {
		const s = session([
			{ role: "user", text: "go" },
			{ role: "thinking", text: "hmm" },
			{ role: "error", text: "socket closed" },
		]);
		sealRunItems(s, null);
		expect(roles(s.items)).toEqual(["user", "loop"]);
		expect(group(s).items.map((it) => it.role)).toEqual(["thinking", "error"]);
	});

	test("a trailing error does not hide the turn's final answer", () => {
		const s = session([
			{ role: "user", text: "go" },
			{ role: "thinking", text: "hmm" },
			{ role: "assistant", text: "done" },
			{ role: "error", text: "socket closed" },
		]);
		sealRunItems(s, null);
		expect(roles(s.items)).toEqual(["user", "loop", "assistant"]);
		expect(group(s).items.map((it) => it.role)).toEqual(["thinking", "error"]);
	});

	test("a partial-turn loop group from a mid-run attach un-nests into one flat run", () => {
		// Mid-run attach: the transcript rebuild folded the pre-attach half of the running
		// turn into its own loop group; turnItemStart anchors right after the leading user
		// message, so the seal must flatten that artifact instead of nesting a group in the
		// new one (the reload view is one flat run per turn).
		const s = session([
			{ role: "user", text: "go" },
			{ role: "loop", text: "", collapsed: true, items: [{ role: "thinking", text: "hmm" } as SessionItem] } as SessionItem,
			{ role: "tool", text: "bash", name: "bash" },
			{ role: "assistant", text: "done" },
		]);
		sealRunItems(s, null);
		expect(roles(s.items)).toEqual(["user", "loop", "assistant"]);
		expect(group(s).items.map((it) => it.role)).toEqual(["thinking", "tool"]);
	});

	test("the turn's error is still reported after it folds into the group", () => {
		const s = session([
			{ role: "user", text: "go" },
			{ role: "thinking", text: "hmm" },
			{ role: "assistant", text: "done" },
			{ role: "error", text: "socket closed" },
		]);
		sealRunItems(s, null);
		// Sidebar dot looks for the error row; it now sits inside the group.
		expect(turnEndedWithError(s.items)).toBe(true);
		expect(turnEndedWithError([{ role: "user", text: "go" }, { role: "assistant", text: "ok" }])).toBe(false);
	});
});

// Desktop alert gating (session.ts turn_end): only a failure the run actually ended on alerts.
describe("endingErrorText", () => {
	test("a failure the base retried away is not the run's verdict", () => {
		expect(
			endingErrorText([
				{ role: "user", text: "go" },
				{ role: "error", text: "400 invalid request" },
				{ role: "assistant", text: "recovered" },
			]),
		).toBeNull();
	});

	test("a trailing failure is reported with its text, past annotation rows", () => {
		expect(endingErrorText([{ role: "user", text: "go" }, { role: "error", text: "quota" }])).toBe("quota");
		expect(
			endingErrorText([
				{ role: "user", text: "go" },
				{ role: "error", text: "quota" },
				{ role: "mention", text: "", files: [] },
			]),
		).toBe("quota");
	});

	test("the last attempt's failure wins over earlier retries", () => {
		expect(
			endingErrorText([
				{ role: "user", text: "go" },
				{ role: "error", text: "attempt 1" },
				{ role: "error", text: "attempt 2" },
			]),
		).toBe("attempt 2");
	});

	test("a completed turn and a previous turn's sealed error both stay silent", () => {
		expect(endingErrorText([])).toBeNull();
		expect(endingErrorText([{ role: "user", text: "go" }, { role: "assistant", text: "ok" }])).toBeNull();
		expect(
			endingErrorText([
				{ role: "user", text: "go" },
				{ role: "loop", text: "", collapsed: true, items: [{ role: "error", text: "old" } as SessionItem] } as SessionItem,
			]),
		).toBeNull();
	});
});
