// Regression for continuous session-title refresh + per-branch title entries:
// every gate (switch off, own user title, inherited user title before the fork,
// branch moved mid-generation, empty context, superseded call) must skip or drop
// the LLM write, and removing any gate turns the corresponding test red.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/session-titles.test.ts
import { mock, afterEach, describe, expect, test } from "bun:test";
import type { PoolEntry } from "../host/state.ts";

// The host never initializes the profile in a bare test run, so the on-disk
// section is unreachable; mock the module the unit under test reads.
let switchOn = false;
let branchOn = false;
mock.module("../host/desktop-json.ts", () => ({
	readDesktopSection: (section: string) =>
		section === "sessionTitles" ? { refresh: switchOn, branchTitles: branchOn } : {},
	// Same-process suites also load host/auto-review.ts, which imports this
	// writer; an incomplete module mock would strip it and crash the other file.
	writeDesktopSection: () => {},
}));

const { maybeRefreshSessionTitle } = await import("../host/session-titles.ts");

const userMsg = (text: string) => ({
	role: "user",
	attribution: "user",
	content: [{ type: "text", text }],
});

interface TitleGenMock {
	(..._args: unknown[]): Promise<string>;
	readonly calls: number;
}

interface BranchEntry {
	id: string;
	parentId: string | null;
	type: string;
	customType?: string;
	data?: unknown;
}

interface Ctx {
	entry: PoolEntry;
	generateTitle: TitleGenMock;
	writes: Array<[string, string]>;
	appended: Array<{ customType: string; data: unknown }>;
	leaf: () => string | null;
}

interface FakeNode {
	entry: BranchEntry;
	children: FakeNode[];
}

/** Promise-shaped generator that rejects on abort, like the base's real one. */
function mockGenerateTitle(resolved: string | (() => Promise<string>)): TitleGenMock {
	const fn: () => Promise<string> = typeof resolved === "string" ? async () => resolved : resolved;
	let calls = 0;
	const mock = ((...args: unknown[]) =>
		new Promise<string>((resolve, reject) => {
			calls++;
			const signal = args[2] as AbortSignal | undefined;
			signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			fn().then(resolve, reject);
		})) as TitleGenMock;
	Object.defineProperty(mock, "calls", { get: () => calls });
	return mock;
}

const textEntry = (id: string, parentId: string | null): BranchEntry => ({ id, parentId, type: "message" });
const titleBranchEntry = (
	id: string,
	parentId: string | null,
	title: string,
	source: "auto" | "user",
): BranchEntry => ({ id, parentId, type: "custom", customType: "branchTitle", data: { title, source } });

function makeEntry(opts: {
	title?: string;
	titleSource?: string;
	generate: string | (() => Promise<string>);
	messages?: unknown[];
	/** root→leaf path; defaults to a single untitled user turn */
	branch?: BranchEntry[];
	/** parentId → number of extra sibling children (creates a fork at that parent) */
	siblings?: Record<string, number>;
	/** Overrides the leaf the generator sees when it settles (simulates a branch switch) */
	leafAfterGenerate?: string | null;
}): Ctx {
	const generateTitle = mockGenerateTitle(opts.generate);
	const writes: Array<[string, string]> = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const branch = opts.branch ?? [textEntry("u1", null)];
	let leafId: string | null = branch.at(-1)?.id ?? null;
	let leafReads = 0;
	let name = opts.title;

	const byId = new Map<string, FakeNode>();
	const roots: FakeNode[] = [];
	for (const e of branch) {
		const node: FakeNode = { entry: e, children: [] };
		byId.set(e.id, node);
		const parent = e.parentId ? byId.get(e.parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	for (const [parentId, count] of Object.entries(opts.siblings ?? {})) {
		const parent = byId.get(parentId);
		if (!parent) continue;
		for (let i = 0; i < count; i++) {
			parent.children.push({ entry: textEntry(`sib-${parentId}-${i}`, parentId), children: [] });
		}
	}

	const manager = {
		titleSource: opts.titleSource,
		getSessionName: () => name,
		setSessionName: (next: string, source: string) => {
			writes.push([next, source]);
			name = next;
		},
		getBranch: () => branch,
		getTree: () => roots,
		getLeafId: () => {
			// Read 1 is the pre-generation snapshot; later reads see the moved branch.
			leafReads++;
			if (opts.leafAfterGenerate !== undefined && leafReads > 1) return opts.leafAfterGenerate;
			return leafId;
		},
		appendCustomEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
			leafId = `appended-${appended.length}`;
			return leafId;
		},
	};

	const entry = {
		session: {
			messages: opts.messages ?? [userMsg("Fix the login timeout bug in auth.ts")],
			generateTitle,
			titleGenerationSignal: new AbortController().signal,
		},
		manager,
	} as unknown as PoolEntry;
	return { entry, generateTitle, writes, appended, leaf: () => leafId };
}

// Long enough for the generate→write chain (several awaits) to settle.
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

afterEach(() => {
	switchOn = false;
	branchOn = false;
});

describe("maybeRefreshSessionTitle", () => {
	test("switch off skips generation", async () => {
		const ctx = makeEntry({ generate: "New title" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("branch titles off: user-pinned header still gates generation", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "New title", title: "Old", titleSource: "user" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("branch titles off: writes header with auto source and journals nothing", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "Fresh title", title: "Old auto title", titleSource: "auto" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.writes).toEqual([["Fresh title", "auto"]]);
		expect(ctx.appended).toEqual([]);
	});

	test("branch titles on: journals the title and unlocks the header with user", async () => {
		switchOn = true;
		branchOn = true;
		const ctx = makeEntry({ generate: "Fresh title", title: "Old auto title", titleSource: "auto" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.appended).toEqual([{ customType: "branchTitle", data: { title: "Fresh title", source: "auto" } }]);
		expect(ctx.writes).toEqual([["Fresh title", "user"]]);
	});

	test("branch titles on: own hand-written title freezes generation", async () => {
		switchOn = true;
		branchOn = true;
		const ctx = makeEntry({
			generate: "New title",
			title: "Mine",
			titleSource: "user",
			branch: [textEntry("u1", null), titleBranchEntry("t1", "u1", "Mine", "user"), textEntry("a1", "t1")],
		});
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("branch titles on: a title inherited from before the fork does not freeze", async () => {
		switchOn = true;
		branchOn = true;
		// Fork lives at a1 (it has a sibling); the user title sits before it.
		const ctx = makeEntry({
			generate: "New title",
			title: "Mine",
			titleSource: "user",
			branch: [
				textEntry("u1", null),
				titleBranchEntry("t1", "u1", "Mine", "user"),
				textEntry("a1", "t1"),
				textEntry("b1", "a1"),
			],
			siblings: { a1: 1 },
		});
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(1);
	});

	test("branch titles on: branch moved during generation drops the result", async () => {
		switchOn = true;
		branchOn = true;
		const ctx = makeEntry({
			generate: "Fresh title",
			title: "Old",
			branch: [textEntry("u1", null), textEntry("a1", "u1")],
			leafAfterGenerate: "other-branch-leaf",
		});
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(1);
		expect(ctx.appended).toEqual([]);
		expect(ctx.writes).toEqual([]);
	});

	test("branch titles on: unchanged branch title skips both writes", async () => {
		switchOn = true;
		branchOn = true;
		const ctx = makeEntry({
			generate: "Same title",
			title: "Same title",
			branch: [textEntry("u1", null), titleBranchEntry("t1", "u1", "Same title", "auto")],
		});
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(1);
		expect(ctx.appended).toEqual([]);
		expect(ctx.writes).toEqual([]);
	});

	test("superseded call is aborted and never writes", async () => {
		switchOn = true;
		let release!: (v: string) => void;
		const ctx = makeEntry({ generate: () => new Promise<string>(r => (release = r)) });
		maybeRefreshSessionTitle(ctx.entry);
		maybeRefreshSessionTitle(ctx.entry);
		expect(ctx.generateTitle.calls).toBe(2);
		release("Fresh title");
		await settle();
		// Only the surviving call lands: one header write, no duplicate journal rows.
		expect(ctx.writes).toEqual([["Fresh title", "auto"]]);
		expect(ctx.appended).toEqual([]);
	});

	test("empty context skips generation", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "New title", messages: [] });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("generation failure warns and never throws", async () => {
		switchOn = true;
		const warns: unknown[][] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warns.push(args);
		const ctx = makeEntry({ generate: () => Promise.reject(new Error("boom")) });
		try {
			expect(() => maybeRefreshSessionTitle(ctx.entry)).not.toThrow();
			await settle();
		} finally {
			console.warn = origWarn;
		}
		expect(ctx.generateTitle.calls).toBe(1);
		expect(warns.length).toBe(1);
	});
});
