// Regression for continuous session-title refresh: every gate (switch off,
// user-pinned title, in-flight dedupe, empty context) must skip the LLM call,
// unchanged titles must skip the write-back, and generation failures must only
// warn. Removing any gate turns the corresponding test red.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/session-titles.test.ts
import { mock, afterEach, describe, expect, test } from "bun:test";
import type { PoolEntry } from "../host/state.ts";

// The host never initializes the profile in a bare test run, so the on-disk
// section is unreachable; mock the module the unit under test reads.
let switchOn = false;
mock.module("../host/desktop-json.ts", () => ({
	readDesktopSection: (section: string) => (section === "sessionTitles" ? { refresh: switchOn } : {}),
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

type Ctx = {
	entry: PoolEntry;
	generateTitle: TitleGenMock;
	writes: Array<[string, string]>;
};

function mockGenerateTitle(resolved: string | (() => Promise<string>)): TitleGenMock {
	const fn = typeof resolved === "string" ? () => resolved : resolved;
	let calls = 0;
	const mock: TitleGenMock = async (..._args: unknown[]) => {
		calls++;
		return fn();
	};
	Object.defineProperty(mock, "calls", { get: () => calls });
	return mock;
}

function makeEntry(opts: {
	title?: string;
	titleSource?: string;
	generate: string | Promise<string>;
	messages?: unknown[];
}): Ctx {
	const generateTitle = mockGenerateTitle(opts.generate);
	const setCalls: Array<[string, string]> = [];
	const entry = {
		session: {
			messages: opts.messages ?? [userMsg("Fix the login timeout bug in auth.ts")],
			generateTitle,
			titleGenerationSignal: undefined,
		},
		manager: {
			titleSource: opts.titleSource,
			getSessionName: () => opts.title,
			setSessionName: (name: string, source: string) => setCalls.push([name, source]),
		},
	} as unknown as PoolEntry;
	return { entry, generateTitle, writes: setCalls };
}

// Static import cannot be used for the unit under test: mock.module must patch
// its dependency before module evaluation (test seam, see comment above).
afterEach(() => { switchOn = false; });

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe("maybeRefreshSessionTitle", () => {
	test("switch off skips generation", async () => {
		switchOn = false;
		const ctx = makeEntry({ generate: "New title" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("user-pinned title skips generation", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "New title", title: "Old", titleSource: "user" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("in-flight flag dedupes concurrent turns", async () => {
		switchOn = true;
		let release!: (v: string) => void;
		const ctx = makeEntry({ generate: () => new Promise<string>(r => (release = r)) });
		maybeRefreshSessionTitle(ctx.entry);
		maybeRefreshSessionTitle(ctx.entry);
		expect(ctx.generateTitle.calls).toBe(1);
		release("Fresh title");
		await settle();
		// flag cleared after completion: a later turn regenerates again
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(2);
	});

	test("empty context skips generation", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "New title", messages: [] });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(0);
	});

	test("unchanged title skips write-back", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "Same title", title: "Same title" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(1);
		expect(ctx.writes).toEqual([]);
	});

	test("new title writes back with auto source", async () => {
		switchOn = true;
		const ctx = makeEntry({ generate: "Fresh title", title: "Old auto title", titleSource: "auto" });
		maybeRefreshSessionTitle(ctx.entry);
		await settle();
		expect(ctx.generateTitle.calls).toBe(1);
		expect(ctx.writes).toEqual([["Fresh title", "auto"]]);
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
