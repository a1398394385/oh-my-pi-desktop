// Turn-final outputs survive the loop-group seal: an assistant text whose message
// ended stopReason "stop" is a delivered output even when a mid-run wake (advisor
// note, async result, steer) kept the run going afterwards; only toolUse-turn prose
// is process narration and folds. Covers both seal paths: host reload
// (entriesToTranscript) and the live UI seal (sealRunItems).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/turn-final-lift.test.ts
import { describe, expect, test } from "bun:test";
import { entriesToTranscript } from "../host/translate-history.ts";
import { sealRunItems } from "../ui-src/store/run-seal.ts";
import type { TranscriptItem } from "../host/wire/payloads.ts";
import type { OpenSession, SessionItem } from "../ui-src/types/session";
type LoopView<T> = T & { role: "loop"; items: T[] };

const userEntry = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", timestamp: 0, content: [{ type: "text", text }] },
});
const assistantEntry = (id: string, parentId: string | null, blocks: unknown[], stopReason: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:01.000Z",
	message: { role: "assistant", stopReason, content: blocks },
});
const advisorEntry = (id: string, parentId: string) => ({
	type: "custom_message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:02.000Z",
	customType: "advisor",
	content: "",
	details: { notes: [{ note: "numbers off", severity: "concern" }] },
});
const toolResultEntry = (id: string, callId: string) => ({
	type: "message",
	id,
	parentId: callId,
	timestamp: "2026-01-01T00:00:03.000Z",
	message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "ok" }] },
});
const text = (t: string) => ({ type: "text", text: t });
const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { i: "x", command: "ls" } });

// Shape of the reported bug (session 01a168ac): narration (toolUse) → report (stop) →
// advisor note → verification rounds → errata (stop). Both delivered outputs must stay
// top-level in stream order; narration/tools/advisor fold.
const bugShapedEntries = () => [
	userEntry("u1", null, "统计字号分布"),
	assistantEntry("a1", "u1", [text("扫完 CSS，现在实测渲染"), toolCall("c1")], "toolUse"),
	toolResultEntry("r1", "c1"),
	assistantEntry("a2", "r1", [text("## 统计结果\n报告正文")], "stop"),
	advisorEntry("adv1", "a2"),
	assistantEntry("a3", "adv1", [toolCall("c2")], "toolUse"),
	toolResultEntry("r2", "c2"),
	assistantEntry("a4", "r2", [text("勘误：第二节数字修正")], "stop"),
];

describe("entriesToTranscript turn-final lift (reload path)", () => {
	test("buried stop reports surface top-level in stream order", () => {
		const items = entriesToTranscript(bugShapedEntries());
		expect(items.map((i) => i.role)).toEqual(["user", "loop", "assistant", "assistant"]);
		const loop = items[1] as LoopView<TranscriptItem>; // role asserted by the line above
		const [report, errata] = items.slice(2);
		expect(report.text).toBe("## 统计结果\n报告正文");
		expect(report.turnFinal).toBe(true);
		expect(errata.text).toBe("勘误：第二节数字修正");
		expect(errata.turnFinal).toBe(true);
		expect(loop.items!.map((i) => i.role)).toEqual(["assistant", "tool", "advisor", "tool"]);
		expect(loop.items![0].text).toBe("扫完 CSS，现在实测渲染");
		expect(loop.items![0].turnFinal).toBeUndefined();
	});

	test("single-turn classic shape unchanged: only the trailing answer surfaces", () => {
		const items = entriesToTranscript([
			userEntry("u1", null, "hi"),
			assistantEntry("a1", "u1", [text("先查一下"), toolCall("c1")], "toolUse"),
			toolResultEntry("r1", "c1"),
			assistantEntry("a2", "r1", [text("答案是 3")], "stop"),
		]);
		expect(items.map((i) => i.role)).toEqual(["user", "loop", "assistant"]);
		expect(items[2].text).toBe("答案是 3");
		expect((items[1] as LoopView<TranscriptItem>).items!.map((i) => i.role)).toEqual(["assistant", "tool"]);
	});

	test("stop report before an error tail still surfaces, error folds", () => {
		const items = entriesToTranscript([
			userEntry("u1", null, "hi"),
			assistantEntry("a1", "u1", [text("结论 X")], "stop"),
			{
				type: "message",
				id: "a2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: { role: "assistant", stopReason: "error", errorMessage: "quota exceeded", content: [] },
			},
		]);
		expect(items.map((i) => i.role)).toEqual(["user", "loop", "assistant"]);
		expect(items[2].text).toBe("结论 X");
		expect((items[1] as LoopView<TranscriptItem>).items!.map((i) => i.role)).toEqual(["error"]);
	});
});

describe("sealRunItems turn-final lift (live path)", () => {
	// Test seam: sealRunItems only reads items/turnItemStart/turnStartAt
	const makeSession = (items: SessionItem[]): OpenSession =>
		({ items, turnItemStart: 1, turnStartAt: null }) as unknown as OpenSession;

	test("marked outputs lift in stream order, narration/advisor fold", () => {
		const s = makeSession([
			{ role: "user", text: "q" },
			{ role: "assistant", text: "叙述" },
			{ role: "tool", text: "bash", name: "bash", toolCallId: "c1" },
			{ role: "assistant", text: "报告", turnFinal: true },
			{ role: "advisor", text: "", notes: [{ note: "n", severity: "concern" }] },
			{ role: "assistant", text: "勘误", turnFinal: true },
		]);
		sealRunItems(s);
		expect(s.items.map((i) => i.role)).toEqual(["user", "loop", "assistant", "assistant"]);
		const loop = s.items[1] as LoopView<SessionItem>; // role asserted by the line above
		expect(loop.items!.map((i) => i.role)).toEqual(["assistant", "tool", "advisor"]);
		expect(s.items[2].text).toBe("报告");
		expect(s.items[3].text).toBe("勘误");
	});

	test("unmarked trailing assistant still lifts (pre-mark fallback)", () => {
		const s = makeSession([
			{ role: "user", text: "q" },
			{ role: "assistant", text: "叙述" },
			{ role: "tool", text: "bash", name: "bash", toolCallId: "c1" },
			{ role: "assistant", text: "最终回答" },
		]);
		sealRunItems(s);
		expect(s.items.map((i) => i.role)).toEqual(["user", "loop", "assistant"]);
		expect(s.items[2].text).toBe("最终回答");
		expect((s.items[1] as LoopView<SessionItem>).items!.map((i) => i.role)).toEqual(["assistant", "tool"]);
	});
});
