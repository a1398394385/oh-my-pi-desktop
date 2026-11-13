// Branch-scoped ACP rebuild (BUG-126 follow-up): the dual-zone state must
// follow the ACTIVE root→leaf path, not the whole journal. Two failure modes
// this pins:
//   load:    rebuildAcpState over the full journal resurrects summaries
//            written on abandoned sibling branches (session-lifecycle adopts
//            getBranch() instead of getEntries()).
//   runtime: an in-session leaf move (navigate_tree / edit_resend) used to keep
//            projecting with the pre-move zone — forking back onto a node
//            BEFORE a compression node still folded those blocks into the
//            stale summary instead of restoring the uncompressed context
//            (resyncToBranch re-derives zone/compressed from getBranch()).
//   seam:    the two RPC handlers own that resync call. The fork shares the
//            boundary fingerprint (most recent reset/compaction), so the runtime
//            cannot notice the move on its own — deleting either call keeps
//            every runtime-only test green, hence the handler cases below.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-branch-resync.test.ts
import { describe, expect, test } from "bun:test";
import { AcpRuntimeState } from "../host/acp-runtime.ts";
import { branchCompactionFingerprint, rebuildAcpState } from "../host/acp-persist.ts";
import type { AcpSummaryData } from "../host/acp-persist.ts";
import { sessionHandlers } from "../host/rpc/session.ts";
import { sessions } from "../host/state.ts";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

const countTokens = (t: string) => t.length;

// Tree: m1 → m2 → m3 → sum1(acpSummary compressing m1,m2) → m4.
// Forking back to m2 (before the compression node) makes the active path [m1, m2].
function message(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-09T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as never as SessionEntry;
}
const m1 = message("m1", null, "alpha ".repeat(50));
const m2 = message("m2", "m1", "beta ".repeat(50));
const m3 = message("m3", "m2", "gamma ".repeat(50));
const m4 = message("m4", "sum1", "delta ".repeat(50));
const meta: AcpSummaryData["meta"] = {
	createdAt: 1,
	depth: 0,
	method: "normal",
	keepIds: [],
	compressedIds: ["m1", "m2"],
	supersedes: [],
	tokensBefore: 10,
	tokensAfter: 5,
};
const sum1: SessionEntry = {
	type: "custom",
	customType: "acpSummary",
	id: "sum1",
	parentId: "m3",
	timestamp: "2026-11-09T00:00:01Z",
	data: { summary: "compressed m1+m2", meta, index: [] },
} as never as SessionEntry;
const entries = [m1, m2, m3, sum1, m4];

const viewText = (m: AgentMessage) => (typeof m.content === "string" ? m.content : "");

describe("branch-scoped ACP rebuild", () => {
	test("full-journal rebuild would keep the summary; the active-branch rebuild drops it", () => {
		// Post-compression leaf (m4): the summary is on the path, both scopes agree.
		expect(rebuildAcpState(entries).compressedBlockIds.has("m1")).toBe(true);

		// Fork back to m2 (manager.getBranch()): the summary sits on the abandoned
		// sibling path and must not compress anything on the active branch.
		const rebuilt = rebuildAcpState([m1, m2]);
		expect(rebuilt.zone).toEqual([]);
		expect(rebuilt.compressedBlockIds.size).toBe(0);
	});

	test("a leaf move before the compression node restores the uncompressed view", () => {
		// Session built while the leaf was past the compression (m4): state
		// carries the zone, exactly as the load-time rebuild would install it.
		const state = new AcpRuntimeState({
			countTokens,
			sink: { appendCustomEntry: () => "x" },
			getEntries: () => entries,
			params: { minCompress: 0 },
		});
		const rebuilt = rebuildAcpState(entries);
		state.zone = rebuilt.zone;
		for (const id of rebuilt.compressedBlockIds) state.compressed.add(id);

		// The base's context event after navigateTree(m2) hands over root→m2.
		const view = [m1.message, m2.message] as never as AgentMessage[];

		const before = state.projectView(view).map(viewText);
		expect(before.some((t) => t.includes("alpha"))).toBe(false); // bug: original folded away
		expect(before.some((t) => t.includes("compressed m1+m2"))).toBe(true); // ...summary injected instead

		// resyncToBranch: re-derive from the active branch.
		state.resyncToBranch([m1, m2]);

		const after = state.projectView(view).map(viewText);
		expect(after.some((t) => t.includes("alpha"))).toBe(true); // original restored
		expect(after.some((t) => t.includes("compressed m1+m2"))).toBe(false); // stale summary gone
	});

	test("a full-journal feed blinds view alignment and empties the manifest (BUG-131)", () => {
		// Branch A carries 80 extra messages the active leaf (branch B) never saw;
		// annotateView searches ACP_ALIGN_WINDOW (64) entries ahead of its cursor,
		// so the feed scope decides whether the tail stays addressable.
		const messages = new Map<string, AgentMessage>();
		const mk = (id: string, parentId: string | null, role: "user" | "assistant"): SessionEntry => {
			const message = {
				role,
				content: [{ type: "text", text: `${id} ${"x".repeat(120)}` }],
				timestamp: 1,
			} as never as AgentMessage;
			messages.set(id, message);
			return { type: "message", id, parentId, timestamp: "2026-11-09T00:00:00Z", message } as never as SessionEntry;
		};

		const shared = [mk("u0", null, "user"), mk("a0", "u0", "assistant")];
		const abandoned: SessionEntry[] = [];
		let parent = "a0";
		for (let i = 0; i < 80; i++) {
			const role = i % 2 === 0 ? "user" : "assistant";
			const e = mk(`x${i}`, parent, role);
			abandoned.push(e);
			parent = `x${i}`;
		}
		const active: SessionEntry[] = [];
		parent = "a0";
		for (let i = 0; i < 6; i++) {
			const role = i % 2 === 0 ? "user" : "assistant";
			const e = mk(`b${i}`, parent, role);
			active.push(e);
			parent = `b${i}`;
		}
		const fullJournal = [...shared, ...abandoned, ...active];
		const branch = [...shared, ...active];
		const view = branch.map((e) => messages.get(e.id) as AgentMessage);

		const params = { minCompress: 0, l1: 10, tailTurns: 0, tailTokens: 0, tailUserMessages: 0 };
		const manifestLines = (journal: readonly SessionEntry[]) => {
			const state = new AcpRuntimeState({
				countTokens,
				sink: { appendCustomEntry: () => "x" },
				getEntries: () => journal,
				params,
			});
			state.resyncToBranch(journal);
			state.projectView(view);
			const out = state.status();
			expect(out.ok).toBe(true);
			return out.ok ? out.text.split("\n").filter((l) => /^b\d+ \| /.test(l)).length : -1;
		};

		expect(manifestLines(branch)).toBe(branch.length);
		// Only the shared prefix stays addressable: the 6 active-branch blocks sit
		// past the 80 abandoned entries and degrade to pseudo ids.
		expect(manifestLines(fullJournal)).toBe(shared.length);
	});
});

// Fake pool entry for the RPC seam: the handlers only touch these members on
// the navigate path, so the object stays a literal instead of a SessionManager.
function seamEntry(navigate: { cancelled: boolean } = { cancelled: false }) {
	const resynced: string[][] = [];
	const frames: Array<{ type?: string; ok?: boolean }> = [];
	const entry = {
		manager: {
			getLeafId: () => "m4",
			getBranch: () => [m1, m2],
			getEntry: () => m1,
			getSessionName: () => undefined,
		},
		session: {
			isStreaming: false,
			navigateTree: async () => ({ ...navigate, editorText: null, editorImages: null }),
			prompt: async () => true,
		},
		acpRuntime: {
			resyncToBranch: (branch: readonly SessionEntry[]) => resynced.push(branch.map((e) => e.id)),
		},
		transcript: [] as unknown[],
		uiSockets: [] as unknown[],
	};
	const ws = { send: (data: string) => frames.push(JSON.parse(data)) };
	return { entry, resynced, frames, ws };
}

describe("ACP branch isolation at the RPC seam", () => {
	test("a fork keeps the boundary fingerprint, so only an explicit resync can tell", () => {
		// Forking back to m2 leaves reset/compaction ids unchanged: the runtime's
		// own #ensureBranchCurrent check cannot notice the move, which is why the
		// two RPC handlers below must resync explicitly.
		expect(branchCompactionFingerprint(entries)).toEqual(branchCompactionFingerprint([m1, m2]));
		// Same fingerprint, opposite state — the stale side still folds m1+m2.
		expect(rebuildAcpState(entries).compressedBlockIds.size).toBe(2);
		expect(rebuildAcpState([m1, m2]).compressedBlockIds.size).toBe(0);
	});

	test("navigate_tree re-derives the runtime from the new branch", async () => {
		const { entry, resynced, frames, ws } = seamEntry();
		sessions.set("acp-seam-navigate", entry as never);
		try {
			await sessionHandlers.navigate_tree(ws as never, { sessionId: "acp-seam-navigate", entryId: "m2" } as never);
		} finally {
			sessions.delete("acp-seam-navigate");
		}
		expect(resynced).toEqual([["m1", "m2"]]);
		expect(frames.some((f) => f.type === "session_navigated" && f.ok === true)).toBe(true);
	});

	test("edit_resend re-derives the runtime from the new branch", async () => {
		const { entry, resynced, frames, ws } = seamEntry();
		sessions.set("acp-seam-edit", entry as never);
		try {
			await sessionHandlers.edit_resend(ws as never, {
				sessionId: "acp-seam-edit",
				entryId: "m1",
				text: "re-ask",
			} as never);
		} finally {
			sessions.delete("acp-seam-edit");
		}
		expect(resynced).toEqual([["m1", "m2"]]);
		expect(frames.some((f) => f.type === "session_edited" && f.ok === true)).toBe(true);
	});

	test("a cancelled leaf move leaves the runtime alone", async () => {
		const { entry, resynced, frames, ws } = seamEntry({ cancelled: true });
		sessions.set("acp-seam-cancelled", entry as never);
		try {
			await sessionHandlers.navigate_tree(ws as never, { sessionId: "acp-seam-cancelled", entryId: "m2" } as never);
		} finally {
			sessions.delete("acp-seam-cancelled");
		}
		expect(resynced).toEqual([]);
		expect(frames.some((f) => f.type === "session_navigated" && f.ok === false)).toBe(true);
	});
});
