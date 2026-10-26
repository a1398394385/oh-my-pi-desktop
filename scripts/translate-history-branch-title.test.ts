// Rename phase rows after per-branch titles: once a session carries branchTitle
// entries, the base's header-global title_change must stop rendering (every
// settled turn writes one with source "user" as the header unlock) and the
// branchTitle entries stay header metadata — no row at all. Sessions without
// branch titles keep the original title_change rendering.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/translate-history-branch-title.test.ts
import { describe, expect, test } from "bun:test";
import { entriesToTranscript } from "../host/translate-history.ts";

const userEntry = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", timestamp: 0, content: [{ type: "text", text }] },
});
const titleChange = (id: string, parentId: string | null, source: "auto" | "user") => ({
	type: "title_change",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	title: "renamed",
	source,
});
const branchTitle = (id: string, parentId: string | null, title: string, source: "auto" | "user") => ({
	type: "custom",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	customType: "branchTitle",
	data: { title, source },
});

const renameRows = (entries: unknown[]) =>
	entriesToTranscript(entries).filter((item) => item.role === "phase" && item.command === "rename").length;

describe("entriesToTranscript rename rows", () => {
	test("without branch titles the header title_change still renders", () => {
		const entries = [userEntry("u1", null, "hi"), titleChange("t1", "u1", "user")];
		expect(renameRows(entries)).toBe(1);
	});

	test("auto title_change never renders", () => {
		const entries = [userEntry("u1", null, "hi"), titleChange("t1", "u1", "auto")];
		expect(renameRows(entries)).toBe(0);
	});

	test("with branch titles: neither title_change nor branchTitle renders a row", () => {
		const entries = [
			userEntry("u1", null, "hi"),
			titleChange("t1", "u1", "user"), // per-turn header unlock, must stay hidden
			branchTitle("b1", "t1", "Auto title", "auto"),
			titleChange("t2", "b1", "user"),
			branchTitle("b2", "t2", "Hand written", "user"),
		];
		expect(renameRows(entries)).toBe(0);
	});

	test("without branch titles the same title_change stream still renders once", () => {
		const entries = [userEntry("u1", null, "hi"), titleChange("t1", "u1", "user"), titleChange("t2", "t1", "user")];
		expect(renameRows(entries)).toBe(2);
	});
});
