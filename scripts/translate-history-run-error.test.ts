// A provider failure that lands mid-turn must not split the turn's process group.
// The journal keeps the same run going after a failed attempt (attempt 1 dies, the
// agent retries / continues), and closing the run at the error row flattened every
// later thinking/tool row to the top level — the reloaded turn looked "cut in half"
// exactly where the live turn shows one folded group. Errors stay outside the group
// (a run's failure must never fold away), the process rows stay folded as one group.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/translate-history-run-error.test.ts
import { describe, expect, test } from "bun:test";
import { entriesToTranscript } from "../host/translate-history.ts";
import type { TranscriptItem } from "../host/wire/payloads.ts";

const at = (sec: number) => `2026-01-01T00:00:${String(sec).padStart(2, "0")}.000Z`;
const userEntry = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: at(0),
	message: { role: "user", timestamp: 0, content: [{ type: "text", text }] },
});
const thinkingEntry = (id: string, parentId: string, sec: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: at(sec),
	message: { role: "assistant", timestamp: 0, content: [{ type: "thinking", thinking: "hmm" }] },
});
const textEntry = (id: string, parentId: string, sec: number, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: at(sec),
	message: { role: "assistant", timestamp: 0, content: [{ type: "text", text }] },
});
const failedEntry = (id: string, parentId: string, sec: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: at(sec),
	message: {
		role: "assistant",
		timestamp: 0,
		stopReason: "error",
		errorMessage: "The socket connection was closed unexpectedly.",
		content: [],
	},
});

const roles = (items: TranscriptItem[]) => items.map((it) => it.role);

describe("entriesToTranscript run grouping around provider errors", () => {
	test("a mid-run failure folds into the turn's process group like any other event", () => {
		const items = entriesToTranscript([
			userEntry("u1", null, "do work"),
			thinkingEntry("a1", "u1", 1),
			failedEntry("a2", "a1", 2),
			thinkingEntry("a3", "a2", 3),
			userEntry("u2", "a3", "next"),
		]);
		// One process group for the whole turn, the failure row folded inside it — no flat rows
		// and no error row parked after the agent output.
		expect(roles(items)).toEqual(["user", "loop", "user"]);
		const group = items.find((it) => it.role === "loop");
		expect(group?.items?.map((it) => it.role)).toEqual(["thinking", "error", "thinking"]);
	});

	test("a tail failure folds into the group instead of trailing the agent output", () => {
		const items = entriesToTranscript([
			userEntry("u1", null, "do work"),
			thinkingEntry("a1", "u1", 1),
			textEntry("a2", "a1", 2, "done"),
			failedEntry("a3", "a2", 3),
		]);
		expect(roles(items)).toEqual(["user", "loop", "assistant"]);
		expect(items.find((it) => it.role === "loop")?.items?.map((it) => it.role)).toEqual(["thinking", "error"]);
	});

	test("an error with no open turn stays a standalone top-level row", () => {
		const items = entriesToTranscript([failedEntry("a1", "", 1)]);
		expect(roles(items)).toEqual(["error"]);
	});
});
