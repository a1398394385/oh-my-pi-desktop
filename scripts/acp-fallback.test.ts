// ACP fallback compaction (post-L3) and the injected-preparation patch:
// three consecutive forced failures leave the force ladder without degrading,
// the fallback threshold reads the ACP projection (never the raw stored
// history), the host drives base manual compaction with an ACP preparation,
// failures do not retry on the same history, and the patched base uses the
// injected preparation while the default path still prepares from the journal.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-fallback.test.ts --pool=forks --poolOptions.forks.singleFork
import { TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createFileOps } from "@oh-my-pi/snapcompact";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { Settings, type SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { AcpRuntimeState } from "../host/acp-runtime.ts";
import { createAcpProjectionExtension } from "../host/acp-assembly.ts";
import { acpFallbackTrigger, buildAcpPreparation, compactSessionWithAcp, createAcpFallbackSupervisor } from "../host/acp-fallback.ts";
import type { AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData } from "../host/acp-persist.ts";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");
// Dynamic import (module-load boundary): the coding-agent resolves its agentDir
// at import time, so the OMP_PROFILE=omp-desktop-test requirement above must
// hold before these modules load (same pattern as the ACP smoke scripts).
const { createAgentSession, SessionManager, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

const countTokens = (text: string) => text.length;
let seq = 0;

function tokenText(tokens: number): string {
	return "x".repeat(tokens);
}

type FixtureEntry = { type: "message"; id: string; message: AgentMessage };

interface Fixture {
	state: AcpRuntimeState;
	entries: FixtureEntry[];
	view: AgentMessage[];
	forceCalls: number;
}

function makeFixture(options: {
	blocks: number;
	blockTokens: number;
	contextWindow?: number;
	params?: Partial<AcpParams>;
}): Fixture {
	const writes: AcpSummaryData[] = [];
	const entries: FixtureEntry[] = [];
	const sink = {
		appendCustomEntry: (_customType: string, data: unknown) => {
			const id = `s${++seq}`;
			writes.push({ ...(data as Omit<AcpSummaryData, "id">), id });
			return id;
		},
	};
	const view: AgentMessage[] = [];
	for (let i = 0; i < options.blocks; i++) {
		const message = {
			role: "user",
			content: `block ${i}: ${tokenText(options.blockTokens)}`,
			timestamp: 1_700_000_000_000 + i,
		} as never as AgentMessage;
		entries.push({ type: "message", id: `e${i}`, message });
		view.push(message);
	}
	let forceCalls = 0;
	const state = new AcpRuntimeState({
		countTokens,
		sink,
		getEntries: () => entries as never as SessionEntry[],
		contextWindow: options.contextWindow ?? 100_000,
		params: { tailTurns: 0, tailTokens: 0, ...options.params },
		forceCompressTool: () => {
			forceCalls++;
		},
	});
	return {
		state,
		entries,
		view,
		get forceCalls() {
			return forceCalls;
		},
	};
}

function zoneBlock(summaryTokens: number, compressed: string[]): AcpSummaryData {
	return {
		id: `z${++seq}`,
		summary: tokenText(summaryTokens),
		index: compressed.map((id, i) => ({ id, tokens: 10, intent: `folded ${i}` })),
		meta: {
			createdAt: 0,
			depth: 0,
			method: "normal",
			keepIds: [],
			compressedIds: [...compressed],
			supersedes: [],
			tokensBefore: 0,
			tokensAfter: 0,
		},
	};
}

describe("L3 force ladder exhaustion", () => {
	test("three failed forced rounds enter fallback without degrade and never re-arm", () => {
		const fx = makeFixture({ blocks: 10, blockTokens: 100, params: { l1: 300, l2: 600, l3: 900, minCompress: 30, target: 1_000_000 } });
		fx.state.projectView(fx.view);
		assert.equal(fx.state.roundStatus!.tier, "L3");
		fx.state.onTurnEnd(); // ultimatum unanswered -> arm 1
		assert.equal(fx.forceCalls, 1);
		assert.equal(fx.state.forcedFailureCount(), 0);

		fx.state.projectView(fx.view); // forced request 1
		fx.state.onTurnEnd(); // no success -> retry 1
		assert.equal(fx.forceCalls, 2, "first forced failure re-arms");
		assert.equal(fx.state.forcedFailureCount(), 1);
		assert.equal(fx.state.degraded, false);

		fx.state.projectView(fx.view); // forced request 2
		fx.state.onTurnEnd(); // no success -> retry 2
		assert.equal(fx.forceCalls, 3, "second forced failure re-arms");
		assert.equal(fx.state.forcedFailureCount(), 2);
		assert.equal(fx.state.degraded, false);

		fx.state.projectView(fx.view); // forced request 3
		fx.state.onTurnEnd(); // third failure -> fallback
		assert.equal(fx.forceCalls, 3, "third failure does not arm a fourth force");
		assert.equal(fx.state.degraded, false, "fallback is not a degrade");
		assert.equal(fx.state.fallbackActive(), true);
		assert.match(fx.state.fallbackReason, /3 consecutive/);

		fx.state.projectView(fx.view);
		fx.state.onTurnEnd(); // fallback must not re-arm even with a fresh ultimatum
		assert.equal(fx.forceCalls, 3, "fallback never re-arms the force");
	});

	test("a successful compression clears the failure count", async () => {
		const fx = makeFixture({ blocks: 10, blockTokens: 100, params: { l1: 300, l2: 600, l3: 900, minCompress: 30, target: 1_000_000 } });
		fx.state.projectView(fx.view);
		fx.state.onTurnEnd(); // arm
		fx.state.projectView(fx.view);
		fx.state.onTurnEnd(); // failure 1 -> retry
		assert.equal(fx.state.forcedFailureCount(), 1);
		fx.state.projectView(fx.view);
		const out = await fx.state.compress({ keep: [], summary: tokenText(100) });
		assert.equal(out.ok, true);
		assert.equal(fx.state.forcedFailureCount(), 0, "success resets the forced-failure counter");
	});
});

describe("fallback threshold reads the ACP projection", () => {
	const model = { provider: "test", id: "fallback-model", contextWindow: 200_000 } as Model;

	function settings(threshold: number): Settings {
		return Settings.isolated({}).overlay({ "compaction.thresholdTokens": threshold });
	}

	test("raw journal size does not trigger when the projection is small", () => {
		const fx = makeFixture({ blocks: 6, blockTokens: 10, contextWindow: 200_000 });
		// Only the last block survives in the projection; the folded ones are
		// huge in the journal but no longer sent.
		for (let i = 0; i < 5; i++) {
			const message = fx.view[i];
			if (message.role !== "user") throw new Error("fixture block must be a user message");
			message.content = "x".repeat(10_000);
			fx.state.compressed.add(`e${i}`);
		}
		fx.state.projectView(fx.view);
		assert.ok(5 * 10_000 > 10_000, "raw journal is far above the threshold");
		const s = resolveModelCompactionSettings(settings(1_000), model);
		assert.equal(acpFallbackTrigger(fx.state, model, s), undefined, "raw stored history is never the input");
	});

	test("projected estimate above the base line triggers with strict >", () => {
		const fx = makeFixture({ blocks: 2, blockTokens: 100, contextWindow: 200_000 });
		fx.state.projectView(fx.view);
		const s = resolveModelCompactionSettings(settings(200), model);
		const projected = fx.state.projectedTokenEstimate();
		assert.ok(projected > 200, `projected ${projected}`);
		assert.equal(acpFallbackTrigger(fx.state, model, s), "threshold");
		const exact = resolveModelCompactionSettings(settings(projected), model);
		assert.equal(acpFallbackTrigger(fx.state, model, exact), undefined, "the base uses strict >");
	});

	test("real provider overflow routes to the overflow trigger", () => {
		const fx = makeFixture({ blocks: 1, blockTokens: 10, contextWindow: 200_000 });
		fx.state.projectView(fx.view);
		const assistant = {
			role: "assistant",
			provider: "test",
			model: "fallback-model",
			content: [],
			stopReason: "error",
			errorId: AIError.Flag.ContextOverflow,
			errorMessage: "context length exceeded",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			timestamp: Date.now(),
		} as never as AssistantMessage;
		const s = resolveModelCompactionSettings(settings(1_000_000), model);
		assert.equal(acpFallbackTrigger(fx.state, model, s, assistant), "overflow");
	});
});

describe("fallback preparation and supervisor", () => {
	const model = { provider: "test", id: "fallback-model", contextWindow: 200_000 } as Model;

	async function expectNoAcpCompact(fx: Fixture): Promise<void> {
		fx.state.fallback = true;
		let calls = 0;
		const session = {
			isCompacting: false,
			model,
			settings: Settings.isolated({}).overlay({ "compaction.thresholdTokens": 10 }),
			sessionManager: { getBranch: () => fx.entries as never as SessionEntry[] },
			compact: async () => {
				calls++;
			},
		};
		const supervisor = createAcpFallbackSupervisor({ state: fx.state, session });
		supervisor.check();
		await supervisor.idle();
		assert.equal(calls, 0, "no manual compaction runs without a safe ACP preparation");
		assert.equal(fx.state.fallbackActive(), true, "fallback stays active");
		assert.match(fx.state.fallbackReason, /preparation is unavailable/);
	}

	test("the preparation cut is the ACP protected tail boundary", () => {
		const fx = makeFixture({
			blocks: 6,
			blockTokens: 100,
			contextWindow: 200_000,
			params: { tailTurns: 1, tailTokens: 0, tailUserMessages: 1, l1: 1, l2: 2, l3: 3 },
		});
		fx.state.projectView(fx.view);
		const s = resolveModelCompactionSettings(Settings.isolated({}), model);
		const prep = buildAcpPreparation(fx.state, fx.entries as never as SessionEntry[], s);
		assert.ok(prep, "a safe cut exists");
		assert.equal(prep.firstKeptEntryId, "e5", "protected tail starts at the latest user block");
		assert.equal(prep.messagesToSummarize.length, 5);
		assert.equal(prep.recentEntryIds!.length, 1);
		assert.equal(prep.tokensBefore, fx.state.projectedTokenEstimate());
	});

	test("real overflow routes to manual compact with an ACP preparation", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.compressed.add("e0");
		fx.state.zone = [zoneBlock(100, ["e0"])];
		fx.state.projectView(fx.view);
		fx.state.fallback = true;
		const preparations: unknown[] = [];
		const session = {
			isCompacting: false,
			model,
			settings: Settings.isolated({}).overlay({ "compaction.thresholdTokens": 1_000_000 }),
			sessionManager: { getBranch: () => fx.entries as never as SessionEntry[] },
			messages: fx.view,
			compact: async (_instructions?: string, options?: { preparation?: unknown }) => {
				preparations.push(options?.preparation);
			},
		};
		const assistant = {
			role: "assistant",
			provider: "test",
			model: "fallback-model",
			content: [],
			stopReason: "error",
			errorId: AIError.Flag.ContextOverflow,
			errorMessage: "context length exceeded",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			timestamp: Date.now(),
		} as never as AssistantMessage;
		const supervisor = createAcpFallbackSupervisor({ state: fx.state, session });
		supervisor.check(assistant);
		await supervisor.idle();
		assert.equal(preparations.length, 1, "overflow uses the manual compact path");
		assert.ok(preparations[0], "the manual path carries the ACP preparation");
		assert.equal(fx.state.fallbackActive(), false, "a successful fallback compaction clears fallback");
	});

	test("a pseudo id anywhere in the active zone refuses the preparation (zero compact)", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		const viewOnly = { role: "user", content: "view-only synthetic reminder", timestamp: 0 } as never as AgentMessage;
		fx.state.projectView([viewOnly, ...fx.view]);
		await expectNoAcpCompact(fx);
	});

	test("an active id that is not on the branch refuses the preparation (zero compact)", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.projectView(fx.view);
		fx.state.lastSource.push({
			id: "ghost-entry",
			message: { role: "user", content: "stale branch message", timestamp: 1 } as never as AgentMessage,
		});
		fx.state.lastBlocks.push({
			id: "ghost-entry",
			kind: "user",
			sourceId: "ghost-entry",
			tokens: 10,
			intent: "ghost",
			userInput: true,
		});
		await expectNoAcpCompact(fx);
	});

	test("a zone block overlapping the retained tail refuses the preparation (zero compact)", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		// e3 is the cut/tail start: folding it would duplicate summary and source text.
		fx.state.zone = [zoneBlock(100, ["e3"])];
		fx.state.projectView(fx.view);
		await expectNoAcpCompact(fx);
	});

	test("a failure stays in fallback and never retries the same history", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.compressed.add("e0");
		fx.state.compressed.add("e1");
		fx.state.zone = [zoneBlock(2_000, ["e0", "e1"])];
		fx.state.projectView(fx.view);
		fx.state.fallback = true;
		let calls = 0;
		const session = {
			isCompacting: false,
			model,
			settings: Settings.isolated({}).overlay({ "compaction.thresholdTokens": 500 }),
			sessionManager: { getBranch: () => fx.entries as never as SessionEntry[] },
			messages: fx.view,
			compact: async () => {
				calls++;
				throw new Error("summary network down");
			},
		};
		const supervisor = createAcpFallbackSupervisor({ state: fx.state, session });
		supervisor.check();
		await supervisor.idle();
		assert.equal(calls, 1, "threshold drives one manual compact");
		assert.equal(fx.state.fallbackActive(), true, "failure keeps fallback");
		assert.match(fx.state.fallbackReason, /summary network down/);
		supervisor.check();
		await supervisor.idle();
		assert.equal(calls, 1, "same history is not retried (no tight loop)");
		fx.entries.push({
			type: "message",
			id: `e${fx.entries.length}`,
			message: { role: "user", content: "next turn", timestamp: 2 } as never as AgentMessage,
		});
		supervisor.check();
		await supervisor.idle();
		assert.equal(calls, 2, "a new branch entry re-opens one attempt");
	});

	test("success clears fallback and resyncs", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.compressed.add("e0");
		fx.state.zone = [zoneBlock(2_000, ["e0"])];
		fx.state.projectView(fx.view);
		fx.state.fallback = true;
		const preparations: unknown[] = [];
		const session = {
			isCompacting: false,
			model,
			settings: Settings.isolated({}).overlay({ "compaction.thresholdTokens": 500 }),
			sessionManager: { getBranch: () => fx.entries as never as SessionEntry[] },
			messages: fx.view,
			compact: async (_instructions?: string, options?: { preparation?: unknown }) => {
				preparations.push(options?.preparation);
			},
		};
		const supervisor = createAcpFallbackSupervisor({ state: fx.state, session });
		supervisor.check();
		await supervisor.idle();
		assert.equal(preparations.length, 1, "manual compact received the ACP preparation");
		assert.ok(preparations[0], "preparation is not empty");
		assert.equal(fx.state.fallbackActive(), false);
		assert.equal(fx.state.forcedFailureCount(), 0);
	});
});

describe("manual compaction routing", () => {
	const model = { provider: "test", id: "fallback-model", contextWindow: 200_000 } as Model;

	function fakeSession(calls: Array<{ instructions?: string; options?: unknown }>) {
		return {
			isCompacting: false,
			model,
			settings: Settings.isolated({}),
			sessionManager: { getBranch: () => [] as SessionEntry[] },
			compact: async (instructions?: string, options?: unknown) => {
				calls.push({ instructions, options });
			},
		};
	}

	test("non-ACP sessions keep the base default path", async () => {
		const calls: Array<{ instructions?: string; options?: unknown }> = [];
		await compactSessionWithAcp(undefined, fakeSession(calls), { instructions: "focus" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].instructions, "focus", "instructions reach the base unchanged");
	});

	test("ACP sessions pass internal guidance as public instructions with the preparation", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.projectView(fx.view);
		const calls: Array<{ instructions?: string; options?: unknown }> = [];
		const session = fakeSession(calls);
		session.sessionManager = { getBranch: () => fx.entries as never as SessionEntry[] };
		await compactSessionWithAcp(fx.state, session, {
			internalGuidance: "plan guidance",
			suppressContinuation: true,
		});
		assert.equal(calls.length, 1, "plan compaction is no longer rejected");
		assert.equal(calls[0].instructions, "plan guidance", "guidance rides the public instructions field");
		const options = calls[0].options as { preparation?: unknown; suppressContinuation?: boolean } | undefined;
		assert.ok(options?.preparation, "the ACP preparation travels with the guidance");
		assert.equal(options?.suppressContinuation, true, "the caller's continuation semantics survive");
	});

	test("a degraded ACP runtime rejects manual compaction", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.projectView(fx.view);
		fx.state.degrade("test degrade");
		const calls: Array<{ instructions?: string; options?: unknown }> = [];
		let error = "";
		try {
			await compactSessionWithAcp(fx.state, fakeSession(calls));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		assert.match(error, /degraded/);
		assert.equal(calls.length, 0, "no raw preparation reaches the base");
	});

	test("ACP sessions pass the built preparation to the base", async () => {
		const fx = makeFixture({ blocks: 4, blockTokens: 100, contextWindow: 200_000 });
		fx.state.projectView(fx.view);
		const calls: Array<{ instructions?: string; options?: unknown }> = [];
		const session = fakeSession(calls);
		session.sessionManager = { getBranch: () => fx.entries as never as SessionEntry[] };
		await compactSessionWithAcp(fx.state, session);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].instructions, undefined);
		const options = calls[0].options as { preparation?: unknown } | undefined;
		assert.ok(options?.preparation, "the base receives an ACP preparation");
	});
});

describe("projection failure is explicit", () => {
	test("a projection exception degrades ACP and throws instead of returning the raw view", () => {
		const fx = makeFixture({ blocks: 2, blockTokens: 100, contextWindow: 100_000 });
		fx.state.projectView = () => {
			throw new Error("projection boom");
		};
		const handlers = new Map<string, (ev: unknown, ctx: unknown) => unknown>();
		const pi = {
			on(event: string, handler: (ev: unknown, ctx: unknown) => unknown) {
				handlers.set(event, handler);
			},
		};
		createAcpProjectionExtension(fx.state, () => "owner")(pi as never);
		const context = handlers.get("context");
		assert.ok(context, "the context hook is registered");
		let caught: unknown;
		try {
			context({ messages: [] }, { sessionManager: { getSessionId: () => "owner" } });
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof Error, "the hook throws instead of returning { messages }");
		assert.match(caught.message, /projection boom/);
		assert.equal(fx.state.degraded, true);
	});
});

describe("injected preparation on the patched base", () => {
	let calls: Array<{ messages: AgentMessage[] }> = [];

	async function makeSession(cwd: string, journalTexts: string[]) {
		calls = [];
		const mock = createMockModel({
			contextWindow: 200_000,
			handler: (context: { messages: AgentMessage[] }) => {
				calls.push({ messages: context.messages });
				return { content: ["summary text"] };
			},
		});
		const sessionManager = SessionManager.create(cwd);
		for (const [index, text] of journalTexts.entries()) {
			sessionManager.appendMessage({
				role: index % 2 === 0 ? "user" : "assistant",
				content: index % 2 === 0 ? text : [{ type: "text", text }],
				timestamp: 1_700_000_000_000 + index,
			} as never);
		}
		const settings = Settings.isolated({}).overlay({
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 2_000,
		});
		const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
		authStorage.keys.setRuntime("mock", "mock-key");
		const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"));
		const { session } = await createAgentSession({
			cwd,
			settings,
			model: mock,
			modelRegistry,
			agentRegistry: new AgentRegistry(),
			sessionManager,
			getApiKey: async () => "mock-key",
			disableExtensionDiscovery: true,
			enableMCP: false,
			hasUI: true,
			autoTitle: false,
		});
		const sessionFile = sessionManager.getSessionFile()!;
		assert.ok(sessionFile.startsWith(getAgentDir()), `session file stays under the test profile: ${sessionFile}`);
		return { session, sessionManager, sessionDir: dirname(sessionFile), model: mock, settings };
	}

	test("an injected preparation bypasses prepareCompaction; the default path still uses the journal", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "acp-prep-"));
		const journalTexts = [
			"JOURNAL-ONLY-ALPHA " + tokenText(4_000),
			"JOURNAL-ONLY-BETA " + tokenText(4_000),
			"JOURNAL-ONLY-GAMMA " + tokenText(4_000),
			"JOURNAL-ONLY-DELTA " + tokenText(4_000),
		];
		const injected = await makeSession(cwd, journalTexts);
		const branch = injected.sessionManager.getBranch();
		const last = branch[branch.length - 1];
		if (last?.type !== "message") throw new Error("fixture journal must end on a message entry");
		const preparation = {
			firstKeptEntryId: last.id,
			messagesToSummarize: [
				{ role: "user", content: "ACP-PROJECTION-ONLY", timestamp: 1 } as unknown as AgentMessage,
			],
			turnPrefixMessages: [],
			recentMessages: [last.message],
			recentEntryIds: [last.id],
			lastSummarizedEntryId: branch[branch.length - 2]!.id,
			isSplitTurn: false,
			tokensBefore: 12_345,
			fileOps: createFileOps(),
			settings: resolveModelCompactionSettings(injected.settings, injected.model),
		};
		await injected.session.compact(undefined, { preparation });
		const injectedWire = JSON.stringify(calls[0]?.messages ?? []);
		assert.ok(injectedWire.includes("ACP-PROJECTION-ONLY"), "the summarizer saw the injected prefix");
		assert.ok(!injectedWire.includes("JOURNAL-ONLY-ALPHA"), "the injected pass never prepared from the raw journal");
		const committed = injected.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "compaction") as { firstKeptEntryId?: string } | undefined;
		assert.equal(committed?.firstKeptEntryId, last.id, "the injected boundary is the committed boundary");
		await injected.session.dispose();
		await injected.sessionManager.close();
		rmSync(injected.sessionDir, { recursive: true, force: true });

		const cwdDefault = mkdtempSync(join(tmpdir(), "acp-prep-default-"));
		const fallback = await makeSession(cwdDefault, journalTexts);
		await fallback.session.compact();
		const defaultWire = JSON.stringify(calls[0]?.messages ?? []);
		assert.ok(defaultWire.includes("JOURNAL-ONLY-ALPHA"), "the default path still prepares from the journal");
		await fallback.session.dispose();
		await fallback.sessionManager.close();
		rmSync(fallback.sessionDir, { recursive: true, force: true });
	});
});
