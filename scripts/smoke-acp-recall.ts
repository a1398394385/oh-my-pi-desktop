// ACP T5 smoke: recall_block history retrieval (spec §6, acceptance 8/17).
// Single-process bun run.
//
// Layers:
//   A  fixture dispatch (acceptance 17 second half): normal block renders the
//      original journal content (tool pair = call + result together); a live
//      compaction block returns its FULL index; a superseded compaction block
//      redirects along the supersedes chain to the newest strong block with the
//      chain annotated; an unknown id returns a tool error (not silent)
//   B  degrade: a degraded session rejects recall at the entry (same stance
//      as compress_context, spec §5.3)
//   C  large results ride the base truncation pipeline (acceptance 17 first
//      half): the base agent loop applies NO automatic cap to tool results —
//      the pipeline is opt-in per tool via ctx.allocateOutputArtifact — so
//      recall_block itself calls the shared enforceInlineByteCap (head+tail
//      elision + full text spilled to an artifact the model reads back with
//      read in segments). Asserted at tool level with a stub ctx and e2e on
//      the wire through a mock-model session
//   D  e2e (acceptance 8): the recalled content lands as a normal new
//      tool-result block and enters the NEXT round's compression manifest
//      (no exemption)
//   E  one-time residue cleanup: SessionManager.create(<tmp cwd>) materializes
//      the cwd-derived mapping dir under <agentDir>/sessions even for
//      throwaway /tmp cwds; the T7 smoke's G section leaked those (40 dirs),
//      plus 4 older probe leftovers — all swept here, then the sessions dir
//      must be empty
//
// All session data lands under the OMP_PROFILE=acp-probe profile only
// (asserted against the active agentDir); the smoke deletes its own session
// directories at the end.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-recall.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import { AcpRuntimeState, createCompressContextTool, createRecallBlockTool, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import type { AcpParams } from "../host/acp-plan.ts";
import type { AcpSummaryData } from "../host/acp-runtime.ts";
import { AcpRuntimeState, createCompressContextTool, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import { createRecallBlockTool } from "../host/acp-recall-tool.ts";

assert.equal(process.env.OMP_PROFILE, "acp-probe", "run with OMP_PROFILE=acp-probe (never the default profile)");
// Dynamic import exception: the coding-agent module resolves agentDir at import
// time, so the profile must be active before the module loads (T2/probe precedent).
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { cfgCompactionEnabled } = await import("@oh-my-pi/pi-coding-agent/session/context-settings");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

const glm5 = new Tokenizer({ tokenizer: "glm5" });
const countTokens = (s: string) => glm5.countTokens(s);

const NO_TAIL: Partial<AcpParams> = { tailTurns: 0, tailTokens: 0 };
const FIXTURE_PARAMS: Partial<AcpParams> = { l1: 300, l2: 600, l3: 900, minCompress: 30, target: 1_000_000, ...NO_TAIL };
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Journal-backed fixture: a fake sink journals acpSummary writes like the real manager. */
function makeFixture(): { state: AcpRuntimeState; journal: SessionEntry[] } {
	const journal: SessionEntry[] = [];
	let seq = 0;
	const state = new AcpRuntimeState({
		countTokens,
		sink: {
			// Shape-only stand-in for SessionManager's id-minting append channel.
			appendCustomEntry: (customType: string, data?: unknown) => {
				const id = `fx${String(++seq).padStart(3, "0")}`;
				journal.push({ type: "custom", id, customType, data } as never as SessionEntry);
				return id;
			},
		},
		getEntries: () => journal,
		contextWindow: 100_000,
		params: FIXTURE_PARAMS,
	});
	return { state, journal };
}

function pushMessage(journal: SessionEntry[], message: AgentMessage): string {
	const id = `m${String(journal.length).padStart(3, "0")}`;
	journal.push({ type: "message", id, message } as never as SessionEntry);
	return id;
}

/** acpSummary custom entry pushed straight into the journal (spec §9 shape). */
function pushSummary(
	journal: SessionEntry[],
	id: string,
	index: Array<{ id: string; tokens: number; intent: string }>,
	meta: Partial<AcpSummaryData["meta"]> & Pick<AcpSummaryData["meta"], "method" | "compressedIds" | "supersedes">,
): string {
	journal.push({
		type: "custom",
		id,
		customType: "acpSummary",
		data: { summary: `summary of ${id}`, index, meta: { createdAt: 0, depth: 0, keepIds: [], tokensBefore: 0, tokensAfter: 0, ...meta } },
	} as never as SessionEntry);
	return id;
}

// --- A: fixture dispatch (acceptance 17 second half) ----------------------------------------

{
	const { state, journal } = makeFixture();
	const u1 = pushMessage(journal, { role: "user", content: "unique payload alpha", timestamp: 0 });
	pushMessage(journal, {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "grep -r unique ." } }],
		usage: USAGE,
		timestamp: 0,
	} as never as AgentMessage);
	const r1 = pushMessage(journal, {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "unique payload beta" }],
		isError: false,
		timestamp: 0,
	} as never as AgentMessage);
	const a2 = pushMessage(journal, { role: "assistant", content: [{ type: "text", text: "assistant prose gamma" }], usage: USAGE, timestamp: 0 } as never as AgentMessage);

	// Normal blocks: original journal content, tool pair = call + result together.
	// v10: the tool entry speaks bN short refs (shortRef syncs the registry).
	const ru = state.recall(state.shortRef(u1));
	assert.equal(ru.ok, true);
	assert.match((ru as { text: string }).text, /\[acp-recall id=b\d+ kind=user/);
	assert.ok((ru as { text: string }).text.includes("unique payload alpha"), "user block content verbatim");

	const rr = state.recall(state.shortRef(r1));
	assert.equal(rr.ok, true);
	const rrText = (rr as { text: string }).text;
	assert.ok(rrText.includes("tool call: bash("), "the pair renders the tool call");
	assert.ok(rrText.includes("grep -r unique"), "the call arguments render");
	assert.ok(rrText.includes("unique payload beta"), "the pair renders the tool result");
	assert.ok(rrText.includes("tool result:"), "call and result are annotated separately");

	const rx = state.recall(state.shortRef(`${a2}#x`));
	assert.equal(rx.ok, true);
	assert.ok((rx as { text: string }).text.includes("assistant prose gamma"), "assistant text block renders");

	// Compaction blocks: full index, redirect, unknown id.
	const S1 = pushSummary(journal, "S1", [{ id: u1, tokens: 10, intent: "alpha record" }], { method: "normal", compressedIds: [u1], supersedes: [] });
	const S2 = pushSummary(journal, "S2", [{ id: r1, tokens: 10, intent: "beta record" }], { method: "normal", compressedIds: [r1], supersedes: [] });
	const M = pushSummary(
		journal,
		"M",
		[
			{ id: u1, tokens: 10, intent: "alpha record" },
			{ id: r1, tokens: 10, intent: "beta record" },
			{ id: a2, tokens: 10, intent: "gamma record" },
		],
		{ method: "strong", compressedIds: [u1, r1, a2], supersedes: [S1, S2], depth: 1 },
	);

	const rm = state.recall(state.shortRef(M));
	assert.equal(rm.ok, true);
	const rmText = (rm as { text: string }).text;
	for (const intent of ["alpha record", "beta record", "gamma record"]) assert.ok(rmText.includes(intent), `full index line present: ${intent}`);
	assert.ok(!rmText.includes("recall_block("), "no render-truncation trailer in a recall");

	const rs1 = state.recall(state.shortRef(S1));
	assert.equal(rs1.ok, true);
	const rs1Text = (rs1 as { text: string }).text;
	assert.ok(rs1Text.includes(`[acp-recall id=${state.shortRef(M)}`), "superseded block redirects to the newest strong block");
	assert.ok(rs1Text.includes(`${state.shortRef(S1)} -> ${state.shortRef(M)}`), "the supersedes chain is annotated (short refs)");
	assert.ok(rs1Text.includes("gamma record"), "the redirect carries the inherited full index");

	// Multi-layer chain: M2 supersedes M; recall(S1) walks S1 -> M -> M2.
	const M2 = pushSummary(journal, "M2", [{ id: u1, tokens: 10, intent: "folded again" }], { method: "strong", compressedIds: [u1], supersedes: [M], depth: 2 });
	const rs1b = state.recall(state.shortRef(S1));
	assert.ok((rs1b as { text: string }).text.includes(`${state.shortRef(S1)} -> ${state.shortRef(M)} -> ${state.shortRef(M2)}`), "multi-layer supersedes chain annotated");
	assert.ok((rs1b as { text: string }).text.includes("folded again"), "redirect lands on the newest strong block");

	const bad = state.recall("no-such-block");
	assert.equal(bad.ok, false, "unknown id is a tool error, not silence");
	assert.match((bad as { error: string }).error, /No block with id "no-such-block"/);
	assert.ok((bad as { error: string }).error.includes(state.shortRef(M2)!), "the error lists the live compaction blocks (short refs)");
	assert.equal(state.recall("").ok, false, "empty id rejects");

	// Degraded sessions reject at the entry (same stance as compress, §5.3).
	state.degrade("fixture degrade");
	const rd = state.recall(M);
	assert.equal(rd.ok, false);
	assert.match((rd as { error: string }).error, /degraded/);
	console.log("ok: A fixture — normal/pair/full-index/redirect/unknown/degrade dispatch all correct");
}

// --- B: tool-level truncation pipeline (acceptance 17 first half) ---------------------------

{
	const { state, journal } = makeFixture();
	// Giant index: ~1200 lines x ~60 chars ≈ 72KB, past the 50KB base cap.
	const lines = Array.from({ length: 1200 }, (_, i) => ({ id: `b${i}`, tokens: 20, intent: `investigation record ${i} with exact values and file paths` }));
	const G = pushSummary(journal, "G", lines, { method: "normal", compressedIds: [], supersedes: [] });

	const tool = createRecallBlockTool(state);

	// No ctx (pipeline unreachable): the original text returns untruncated.
	const bare = (await tool.execute("t0", { id: state.shortRef(G) }, undefined, undefined, undefined)) as { content: Array<{ type: string; text: string }> };
	assert.ok(bare.content[0].text.includes("investigation record 1199"), "without a ctx the full text returns as-is");

	// Real pipeline shape: a stub ctx standing in for the SDK ToolSession.
	const spillPath = join(tmpdir(), `acp-t5-spill-${process.pid}.txt`);
	const stubCtx = {
		allocateOutputArtifact: async (toolType: string) => {
			assert.equal(toolType, "recall_block");
			return { id: "spill1", path: spillPath };
		},
	};
	const res = (await tool.execute("t1", { id: state.shortRef(G) }, undefined, undefined, stubCtx)) as { content: Array<{ type: string; text: string }> };
	const text = res.content[0].text;
	assert.ok(text.includes("artifact://spill1"), "the inline result points at the spilled artifact");
	assert.match(text, /elided/, "the inline result carries the elision marker");
	assert.ok(Buffer.byteLength(text, "utf8") < 60_000, "the inline result stays under the base cap");
	assert.ok(existsSync(spillPath), "the full version landed on disk");
	const spilled = await Bun.file(spillPath).text();
	assert.ok(spilled.includes("investigation record 0") && spilled.includes("investigation record 1199"), "the spill is complete (read fetches it back in segments)");
	assert.ok(!spilled.includes("elided"), "the spill is the untouched full text");
	rmSync(spillPath, { force: true });

	// Errors carry isError (not silent) and never spill.
	const err = (await tool.execute("t2", { id: "nope" }, undefined, undefined, {
		allocateOutputArtifact: async () => {
			throw new Error("must not allocate for an error");
		},
	})) as { content: Array<{ type: string; text: string }>; isError?: boolean };
	assert.equal(err.isError, true, "unknown id surfaces as a tool error");
	assert.match(err.content[0].text, /No block with id/);
	console.log("ok: B truncation — inline capped + elision marker + artifact spill complete, errors non-silent");
}

// --- C/D: e2e on the wire (acceptance 8 + 17 wire half) --------------------------------------

interface MockCall {
	context: { messages: Array<{ role: string; content?: unknown }> };
}

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 1_000 && !predicate(); i++) await Bun.sleep(10);
	assert.ok(predicate(), `timed out waiting for: ${what}`);
}

/** Recursive search for the one file under `dir` containing `needle`. */
function findFileContaining(dir: string, needle: string): string | null {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			const hit = findFileContaining(p, needle);
			if (hit) return hit;
		} else if (readFileSync(p, "utf8").includes(needle)) {
			return p;
		}
	}
	return null;
}

{
	const cwd = mkdtempSync(join(tmpdir(), "acp-t5-recall-"));
	const sessionManager = SessionManager.create(cwd);
	const settings = Settings.isolated({}).overlay({ "compaction.enabled": false });
	assert.equal(cfgCompactionEnabled.get(settings), false);
	const state = new AcpRuntimeState({
		countTokens,
		sink: sessionManager,
		getEntries: () => sessionManager.getEntries(),
		contextWindow: 100_000,
		params: { ...FIXTURE_PARAMS },
	});

	// Seed the journal with a real tool pair before any request (journal-backed view).
	sessionManager.appendMessage({ role: "user", content: "unique payload alpha", timestamp: 0 } as never);
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-e2e", name: "bash", arguments: { command: "grep -r unique ." } }],
		usage: USAGE,
		timestamp: 0,
	} as never);
	const r1 = sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-e2e",
		toolName: "bash",
		content: [{ type: "text", text: "unique payload beta" }],
		isError: false,
		timestamp: 0,
	} as never);
	// A giant-index compaction block straight in the journal (spec §9 shape),
	// adopted into the live zone like a restart rebuild would.
	const bigLines = Array.from({ length: 1200 }, (_, i) => ({ id: `g${i}`, tokens: 20, intent: `investigation record ${i} with exact values and file paths` }));
	const bigData: AcpSummaryData = {
		id: "",
		summary: "giant index summary",
		index: bigLines,
		meta: { createdAt: 0, depth: 0, method: "normal", keepIds: [], compressedIds: [], supersedes: [], tokensBefore: 0, tokensAfter: 0 },
	};
	bigData.id = sessionManager.appendCustomEntry("acpSummary", bigData);
	state.zone = [bigData];

	// Turn script: 1 recall the pair, 2 plain answer, 3 recall the giant index.
	let turn = 0;
	const mockModel = createMockModel({
		contextWindow: 100_000,
		handler: () => {
			const step = turn++;
		if (step === 0) return { content: [{ type: "toolCall", name: "recall_block", arguments: { id: state.shortRef(r1) } }] };
		if (step === 1) return { content: ["noted."] };
		if (step === 2) return { content: [{ type: "toolCall", name: "recall_block", arguments: { id: state.shortRef(bigData.id) } }] };
			return { content: ["done."] };
		},
	});
	const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"));
	const { session } = await createAgentSession({
		cwd,
		settings,
		// Mirrors host/session-lifecycle.ts: ACP pins compaction.enabled off for the primary,
		// so the advisor must be opted back in explicitly or it loses compaction maintenance.
		advisorCompactionEnabled: true,
		model: mockModel,
		modelRegistry,
		agentRegistry: new AgentRegistry(),
		sessionManager,
		customTools: [createCompressContextTool(state), createRecallBlockTool(state)] as never,
		getApiKey: async () => "mock-key",
		extensions: [createAcpProjectionExtension(state, () => sessionManager.getSessionId())] as never,
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: true,
	});
	const calls = (mockModel as unknown as { calls: MockCall[] }).calls;
	const recallResults = () =>
		sessionManager
			.getEntries()
			.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
			.filter((e) => e.message.role === "toolResult" && e.message.toolName === "recall_block");

	// Turn 1: recall the tool pair — full call + result on the wire.
	await session.prompt("recall the pair please");
	await waitFor("recall tool result journaled", () => recallResults().length >= 1);
	const pairText = JSON.stringify(recallResults()[0].message);
	assert.ok(pairText.includes("tool call: bash(") && pairText.includes("grep -r unique"), "the recalled pair includes the call");
	assert.ok(pairText.includes("unique payload beta"), "the recalled pair includes the result");
	const recallBlockId = recallResults()[0].id;

	// Turn 2: the recalled block is a plain new block — next round's manifest lists it.
	await session.prompt("continue");
	await waitFor("second request projected", () => calls.length >= 2);
	assert.ok(
		(state.roundStatus?.manifestIds ?? []).includes(recallBlockId),
		"the recall product enters the next round's compression manifest (no exemption)",
	);

	// Turn 3: recall the giant index — the wire result is capped + artifact-pointing.
	await session.prompt("recall the big index");
	await waitFor("giant recall journaled", () => recallResults().length >= 2);
	const bigMessage = recallResults()[1].message as { content: Array<{ type: string; text: string }> };
	const bigText = bigMessage.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.ok(bigText.includes("artifact://"), "the giant recall spills to an artifact (base pipeline active e2e)");
	assert.ok(bigText.includes("elided"), "the giant recall is capped inline");
	assert.ok(!bigText.includes("investigation record 600"), "the inline giant recall elides the middle (head+tail kept; full text lives in the artifact)");
	// The spilled artifact exists under the session's artifacts dir and is complete
	// (the model reads it back in segments with read).
	const artifactsDir = sessionManager.getArtifactsDir?.();
	assert.ok(artifactsDir, "the session exposes its artifacts dir");
	const spilledFile = findFileContaining(artifactsDir!, "investigation record 1199");
	assert.ok(spilledFile, "the complete spill is on disk under the artifacts dir");
	assert.ok(readFileSync(spilledFile!, "utf8").includes("investigation record 0"), "the spill spans the whole index");

	// dispose() records the session-exit diagnostic NOW and detaches the
	// process-exit hook — without it the exit marker re-creates the session
	// file (and its mapping dir) after our cleanup, leaking into the profile.
	await session.dispose();
	// The mock's retry/artifact machinery can flush a beat after close; let it
	// settle before removing the session dir (a re-created file would leak the
	// mapping dir into the profile and fail the empty-dir assertion below).
	await Bun.sleep(200);
	const sessionDir = dirname(sessionManager.getSessionFile()!);
	rmSync(sessionDir, { recursive: true, force: true });
	assert.ok(!existsSync(sessionDir), "e2e session dir fully removed (incl. lock files)");
	rmSync(cwd, { recursive: true, force: true });
	console.log("ok: C e2e — pair recalled on the wire; recall product re-enters the manifest; giant recall capped + spilled");
}

// --- E: one-time residue cleanup (T7 leftovers + older probe residue) -----------------------

{
	const sessionsRoot = join(getAgentDir(), "sessions");
	const before = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
	// Only cwd-encoded mapping dirs from our throwaway smoke cwds: T7's
	// (/tmp/acp-t7-* plus the /var/folders/.../T/acp-t7-g-* pairs from the G
	// section), this smoke's (acp-t5-*), and a handful of older probe/debug
	// leftovers (tmp-dbg-*, tmp-probe-*) — all under temp cwds, all disposable
	// probe residue, nothing user-facing.
	const targets = before.filter((name) => name.startsWith("-tmp-") || name.includes("acp-t7-") || name.includes("acp-t5-"));
	console.log(`residue sweep: ${targets.length} mapping dirs under ${sessionsRoot}: ${targets.join(", ")}`);
	for (const name of targets) rmSync(join(sessionsRoot, name), { recursive: true, force: true });
	const after = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
	assert.equal(after.length, 0, `sessions dir must end empty, still holds: ${after.join(", ")}`);
}

console.log("\nALL ACP T5 RECALL BLOCK SMOKE CHECKS PASSED");
