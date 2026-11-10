// ACP base-compaction takeover smoke (spec §2/§3, acceptance 1/24/25). Single-process bun run.
//
// One real mock-model session drives the whole path:
//   1. Three normal turns build the ACP request projection and a same-branch
//      assistant reply lands after the last projection (the cache is now a
//      strict entry-id prefix of the branch, not a leaf match).
//   2. session.compact() emits session_before_compact. ACP must answer with
//      its own compaction: exactly one model call (the takeover prompt), no
//      base summarizer call, entry.method undefined, firstKeptEntryId copied
//      from preparation, and the retained tail absent from the summary body.
//   3. The hook result is persisted as a plain compaction entry (no
//      acpSummary double-write) and the next request re-projects the branch as
//      one [acp-base] block plus the retained tail — each message once.
//
// All session data lands under the OMP_PROFILE=omp-desktop-test profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directory at the end.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-acp-takeover.ts
import { TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import { AcpRuntimeState, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import type { AcpParams } from "../host/acp-plan.ts";
import { assertToolPairing } from "../host/acp-projection.ts";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");
// Dynamic import exception: the coding-agent module resolves agentDir at import
// time, so the profile must be active before the module loads (T2/probe precedent).
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

// Real tokenizer (spec §8): native encoding, not the byte-estimate fallback.
const glm5 = new Tokenizer({ tokenizer: "glm5" });
const countTokens = (s: string) => glm5.countTokens(s);

/** Prompt marker the takeover adds to the summary request (host/acp-base-takeover.ts). */
const TAKEOVER_PROMPT = "Update the conversation summary for future work.";
/** The takeover summary body; it must reach the compaction entry verbatim. */
const BASE_SUMMARY = "BASE-SUMMARY-MARKER: the retired prefix is folded; the retained turns stay verbatim.";

/** Text of a wire message regardless of content shape (string or blocks). */
function textOf(m: { role: string; content?: unknown }): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: string }).text) : ""))
		.join("");
}

/** Turn text of at least `target` tokens carrying a unique label. */
function turnText(label: string, target: number): string {
	let text = `${label}: `;
	while (countTokens(text) < target) text += "detailed journal text about the parser bug and the failing test. ";
	return text;
}

const cwd = mkdtempSync(join(tmpdir(), "acp-takeover-"));
{
	let takeoverCalls = 0;
	const mock = createMockModel({
		contextWindow: 200_000,
		handler: (context: { messages: Array<{ role: string; content: unknown }> }) => {
			const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
			const text = textOf(lastUser ?? { role: "user", content: "" });
			if (text.includes(TAKEOVER_PROMPT)) {
				takeoverCalls++;
				return { content: [BASE_SUMMARY] as const };
			}
			// Normal turns answer with a labelled reply so the smoke can tell
			// retained-tail text from folded text on the wire.
			const label = /^(TURN-[A-Z]+|FOLLOW-UP)/.exec(text)?.[1] ?? "turn";
			return { content: [`REPLY-${label.slice(5) || "TURN"}: acknowledged.`] as const };
		},
	});
	// Keep only the newest turns verbatim, so the base cut lands inside the
	// branch and both the compressed prefix and the retained tail are non-empty.
	const settings = Settings.isolated({ "compaction.keepRecentTokens": 400 });
	const sessionManager = SessionManager.create(cwd);
	const state = new AcpRuntimeState({
		countTokens,
		countMessages: (messages) => glm5.countMessages(messages),
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		getBranch: () => sessionManager.getBranch(),
		contextWindow: mock.contextWindow,
		// ACP tiers stay dormant: this smoke exercises the base boundary only.
		params: { l1: 100_000, l2: 200_000, l3: 300_000, minCompress: 0, target: 1_000_000, tailTurns: 0, tailTokens: 0 } as Partial<AcpParams>,
	});
	// Record the preparation the base computed, so the persisted cut can be
	// compared against it rather than against a re-derived guess.
	const preparations: Array<{ firstKeptEntryId: string }> = [];
	const recordPreparation = (pi: { on(event: string, handler: (ev: { preparation: { firstKeptEntryId: string } }) => void): void }) => {
		pi.on("session_before_compact", (ev) => {
			preparations.push({ firstKeptEntryId: ev.preparation.firstKeptEntryId });
		});
	};
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
		extensions: [
			recordPreparation,
			createAcpProjectionExtension(state, () => sessionManager.getSessionId(), {
				settings,
				getModel: () => session.model,
				getApiKey: () => "mock-key",
				getNonMessageTokens: () => 0,
			}),
		] as never,
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: true,
	});

	const assistantCount = () =>
		sessionManager
			.getEntries()
			.filter(
				(e): e is Extract<SessionEntry, { type: "message" }> =>
					e.type === "message" && e.message.role === "assistant",
			).length;
	const ask = async (text: string, expectAssistants: number) => {
		await session.prompt(text);
		for (let i = 0; i < 1_000 && assistantCount() < expectAssistants; i++) await Bun.sleep(10);
		assert.ok(assistantCount() >= expectAssistants, `turn for "${text.slice(0, 24)}" did not complete`);
	};

	// Three turns: each request captures a projection snapshot; every reply is
	// appended after the projection, so the branch outruns the cached prefix.
	await ask(turnText("TURN-ONE", 250), 1);
	await ask(turnText("TURN-TWO", 250), 2);
	await ask(turnText("TURN-THREE", 250), 3);
	assert.ok(state.lastProjected.length > 0, "the ACP projection ran during the normal turns");
	assert.ok(state.roundStatus, "round status exists before the base boundary");

	const callsBefore = mock.calls.length;
	const result = await session.compact();
	const compactCalls = mock.calls.slice(callsBefore);
	assert.equal(takeoverCalls, 1, "the takeover prompt was served exactly once");
	assert.equal(compactCalls.length, 1, "one ACP takeover call — the base summarizer never ran");
	assert.ok(
		!compactCalls.some((call) => JSON.stringify(call.context.messages).includes("structured handoff summary")),
		"no base fold request on the wire",
	);
	const takeoverRequest = compactCalls[0].context.messages;
	assert.match(textOf(takeoverRequest.at(-1)!), /Update the conversation summary/, "the sole call is the takeover prompt");
	assert.equal(preparations.length, 1, "session_before_compact fired once");
	const { firstKeptEntryId } = preparations[0];

	const branch = sessionManager.getBranch();
	const compactionEntry = branch.find((e): e is Extract<SessionEntry, { type: "compaction" }> => e.type === "compaction");
	assert.ok(compactionEntry, "the hook result was persisted as a compaction entry");
	assert.equal(compactionEntry.method, undefined, "hook compaction carries no base method field");
	assert.equal(compactionEntry.fromExtension, true, "the entry is marked as extension-provided");
	assert.equal(compactionEntry.firstKeptEntryId, firstKeptEntryId, "the cut is preparation.firstKeptEntryId, not ACP's own");
	assert.equal(result.firstKeptEntryId, firstKeptEntryId, "the reported CompactionResult keeps the same cut");
	assert.equal(result.summary, BASE_SUMMARY, "the takeover summary reaches the entry verbatim");

	const cut = branch.findIndex((e) => e.id === firstKeptEntryId);
	assert.ok(cut >= 0, "the preparation cut is on the branch");
	const prefixEntries = branch.slice(0, cut);
	const retainedEntries = branch.slice(cut);
	const prefixMessages = prefixEntries.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message");
	const retainedMessages = retainedEntries.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message");
	assert.ok(prefixMessages.length > 0, "the compressed prefix is non-empty");
	assert.ok(retainedMessages.length >= 2, "the retained tail covers the last turn and its appended reply");
	const labelsOf = (entries: readonly SessionEntry[]) =>
		entries.flatMap((e) => {
			if (e.type !== "message") return [];
			const label = /(TURN-[A-Z]+|REPLY-[A-Z]+)/.exec(textOf(e.message))?.[1];
			return label ? [label] : [];
		});
	const prefixLabels = labelsOf(prefixEntries);
	const retainedLabels = labelsOf(retainedEntries);
	assert.ok(prefixLabels.length > 0, "the compressed prefix carries labelled turns");
	assert.ok(
		retainedLabels.includes("REPLY-THREE"),
		"the reply appended after the last projection sits in the retained tail (cache continuation)",
	);

	// W2: the summary model sees the active prefix only — no retained-tail text,
	// and exactly the prefix messages (the cache extended past the last request,
	// which is what let the takeover run at all).
	assert.equal(takeoverRequest.length, prefixMessages.length + 1, "takeover input = active prefix + the summary prompt");
	const prefixWire = JSON.stringify(takeoverRequest.slice(0, -1));
	for (const label of prefixLabels) assert.ok(prefixWire.includes(label), `the compressed prefix reached the summarizer (${label})`);
	for (const label of retainedLabels) {
		assert.ok(!prefixWire.includes(label), `retained-tail text must not reach the summarizer (${label})`);
		assert.ok(!result.summary.includes(label), `retained-tail text must not reach the summary body (${label})`);
	}

	// W6: the compaction entry is the only artifact — no acpSummary double write.
	const sessionFile = sessionManager.getSessionFile()!;
	assert.ok(sessionFile.startsWith(getAgentDir()), `session file must stay inside the smoke profile agentDir, got ${sessionFile}`);
	// Cleanup registers BEFORE the remaining asserts (a failed run must not leak
	// probe session dirs: the SDK journals session_exit at process exit).
	const sessionDir = dirname(sessionFile);
	process.on("exit", () => {
		rmSync(sessionDir, { recursive: true, force: true });
		// Windows can still hold the throwaway cwd when a session handle outlives
		// the test; the temp dir is disposable.
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			// Windows lock window; the temp dir is disposable
		}
	});
	const rawBefore = await Bun.file(sessionFile).text();
	assert.equal(rawBefore.split('"customType":"acpSummary"').length - 1, 0, "no acpSummary double write on disk");
	assert.equal(rawBefore.split('"type":"compaction"').length - 1, 1, "exactly one compaction entry on disk");

	// Read side: the branch rebuilds one base block and folds every id before
	// the cut into it; the retained tail stays ordinary messages.
	assert.equal(state.degraded, false, "the takeover boundary does not degrade");
	assert.deepEqual(state.zone.map((z) => z.id), [compactionEntry.id], "the zone collapses to the synthesized base block");
	assert.equal(state.zone[0].meta.method, "base");
	for (const entry of prefixEntries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		assert.ok(state.compressed.has(entry.id), `prefix user turn ${entry.id} folded into the base block`);
	}

	// Next request: one [acp-base] render, no compactionSummary passthrough, and
	// every retained message exactly once (no summary/original duplication).
	await ask(turnText("FOLLOW-UP", 100), 4);
	const wire = mock.calls.at(-1)!.context.messages;
	const wireText = JSON.stringify(wire);
	assert.equal(wireText.split("[acp-base]").length - 1, 1, "exactly one base render on the wire");
	assert.ok(!wireText.includes("compactionSummary"), "the base summary message is dropped, not duplicated");
	assert.ok(!wireText.includes("[acp-summary"), "no compaction block was written for the boundary");
	assert.equal(wireText.split("BASE-SUMMARY-MARKER").length - 1, 1, "the base body renders once");
	for (const label of retainedLabels) {
		assert.equal(wireText.split(label).length - 1, 1, `retained message appears once on the wire (${label})`);
	}
	for (const label of prefixLabels) assert.ok(!wireText.includes(label), `the folded prefix left the request (${label})`);
	assert.equal(wireText.split("FOLLOW-UP").length - 1, 1, "the new turn rides the projection once");
	assert.doesNotThrow(() => assertToolPairing(wire), "pairing invariant holds after the base boundary");

	const rawAfter = await Bun.file(sessionFile).text();
	assert.equal(rawAfter.split('"type":"compaction"').length - 1, 1, "the follow-up request wrote no extra compaction entry");
	assert.ok(!rawAfter.includes('"customType":"acpSummary"'), "still no acpSummary entries");

	await sessionManager.close();
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "session dir fully removed (incl. lock files)");
	// Windows can still hold the throwaway cwd when a session handle outlives the
	// test; the temp dir is disposable.
	try {
		rmSync(cwd, { recursive: true, force: true });
	} catch {
		// Windows lock window; the temp dir is disposable
	}
	console.log("ok: base takeover — one ACP call, no base fold, preparation cut, clean journal, single re-projection");
}

console.log("\nALL ACP BASE-TAKEOVER SMOKE CHECKS PASSED");
