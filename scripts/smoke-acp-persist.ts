// ACP T2 smoke: acpSummary persistence + restart rebuild (spec §9, acceptance 10).
// Single-process bun run. All session data lands under the OMP_PROFILE=acp-probe
// profile only (asserted against the active agentDir), and the smoke deletes its
// own session files at the end. Exercises the real SDK channel end to end:
// appendCustomEntry -> JSONL -> SessionManager.open -> rebuildAcpState.
// Usage: OMP_PROFILE=acp-probe bun run scripts/smoke-acp-persist.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, setProfile } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { projectContext, renderCompactionBlock, splitBlocks } from "../host/acp-projection.ts";
import { appendAcpSummary, rebuildAcpState, type AcpSummaryDraft } from "../host/acp-persist.ts";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

assert.equal(process.env.OMP_PROFILE, "acp-probe", "run with OMP_PROFILE=acp-probe (never the default profile)");
// Static import cannot work here: the coding-agent module resolves agentDir at
// import time, so the profile must be active first (probe-acp-live.ts precedent).
setProfile("acp-probe");
const { SessionManager, buildSessionContext } = await import("@oh-my-pi/pi-coding-agent");

// --- real tokenizer (spec §8): native encoding, not the byte-estimate fallback ---
const tokenizer = new Tokenizer({ tokenizer: "glm5" });
assert.ok(tokenizer.encoding !== null, "glm5 must resolve a native encoding for this smoke");
const countTokens = (s: string) => tokenizer.countTokens(s);
assert.ok(countTokens("detailed journal text about the parser bug") > 0);

// --- fixtures -------------------------------------------------------------------
let clock = Date.parse("2026-10-12T10:00:00Z");
const summaryDraft = (
	n: number,
	compressedIds: string[],
	supersedes: string[],
	depth: number,
	method: "normal" | "strong",
): AcpSummaryDraft => ({
	summary: `covered work ${n}`,
	index: compressedIds.map((id) => ({ id, tokens: countTokens(`payload of block ${id}`), intent: `task ${id}` })),
	meta: {
		createdAt: (clock += 60_000),
		depth,
		method,
		keepIds: [],
		compressedIds,
		supersedes,
		tokensBefore: 1000 * n,
		tokensAfter: 100,
	},
});

const cwd = mkdtempSync(join(tmpdir(), "acp-t2-smoke-"));
// Complete usage keeps the journaling path quiet (base warns on incomplete usage).
const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// --- acceptance 10 (first half): persist -> restart -> rebuild -------------------
const session = SessionManager.create(cwd);
const user = (text: string) => session.appendMessage({ role: "user", content: text } as never);
const say = (text: string) =>
	session.appendMessage({ role: "assistant", content: [{ type: "text", text }], usage } as never);

// Three turns; assistant text blocks get their `entryId#x` ids at split time (spec §3).
const a = user("investigate the parser bug");
const ax = `${say("reading the parser now")}#x`;
const b = user("write the failing test");
const bx = `${say("test added, fails as expected")}#x`;
const c = user("fix the off-by-one");
const cx = `${say("fixed")}#x`;

// Two normal compactions S1{a}, S2{b}; then strong M supersedes both and newly
// compresses c — per spec §6 M inherits the full set at write time.
const s1 = appendAcpSummary(session, summaryDraft(1, [a, ax], [], 0, "normal"));
const s2 = appendAcpSummary(session, summaryDraft(2, [b, bx], [], 0, "normal"));
const m = appendAcpSummary(session, { ...summaryDraft(3, [a, ax, b, bx, c, cx], [s1.id, s2.id], 1, "strong"), shortSummary: "zone reset" });

// The session file materializes on the first assistant turn; assert profile isolation.
const sessionFile = session.getSessionFile()!;
assert.ok(
	sessionFile.startsWith(getAgentDir()),
	`session file must stay inside the acp-probe profile agentDir (${getAgentDir()}), got ${sessionFile}`,
);

// JSONL on disk carries exactly the acpSummary custom entries (official channel)
const raw = readFileSync(sessionFile, "utf8");
assert.equal(raw.split('"customType":"acpSummary"').length - 1, 3, "three acpSummary entries persisted");

// Restart: reopen from disk and rebuild from the loaded entries
const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
const entries = reopened.getEntries();
const state = rebuildAcpState(entries);
assert.equal(state.degraded, false);
assert.deepEqual(state.zone.map((z) => z.id), [m.id], "zone collapses to the single strong block");
assert.equal(state.zone[0].meta.depth, 1);
assert.equal(state.zone[0].meta.method, "strong");
assert.equal(state.zone[0].index.length, 6, "strong index holds the inherited full set");
assert.equal(state.zone[0].summary, m.summary);
assert.deepEqual(
	[...state.compressedBlockIds].sort(),
	[a, ax, b, bx, c, cx].sort(),
	"all six blocks compressed via M alone — rebuild never walks the supersedes chain",
);

// Rebuilt state feeds the T1 projection: active zone empty (all compressed), rendered zone first
const source = entries
	.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
	.map((e) => ({ id: e.id, message: e.message }));
const blocks = splitBlocks(source, countTokens);
assert.deepEqual(blocks.map((bl) => bl.id), [a, ax, b, bx, c, cx]);
const kept = new Set(blocks.filter((bl) => !state.compressedBlockIds.has(bl.id)).map((bl) => bl.id));
const out = projectContext(source, kept, state.zone, countTokens);
assert.equal(out.length, 1, "nothing active — only the rendered compaction zone survives");
assert.equal(out[0].role, "user");
assert.equal(out[0].content, renderCompactionBlock(m, countTokens));
assert.match(out[0].content as string, /method=strong/);
console.log("ok: persist -> restart -> rebuild — zone/active split correct, feeds projection (native tokenizer)");

// --- acpSummary stays out of the base LLM context (spec §4/§9) -------------------
const ctx = buildSessionContext(entries);
assert.equal(ctx.messages.length, 6, "base context counts only the journaled messages");
assert.ok(!JSON.stringify(ctx.messages).includes("covered work"), "summary text must not leak into base context");
console.log("ok: buildSessionContext ignores acpSummary — no LLM context, no message count");

// --- acceptance 10 (second half): base compaction entry degrades rebuild ---------
const degradedSession = SessionManager.create(cwd);
const d1 = degradedSession.appendMessage({ role: "user", content: "start" } as never);
degradedSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "working" }], usage } as never);
appendAcpSummary(degradedSession, summaryDraft(9, [d1], [], 0, "normal"));
// Base compaction entries only ever appear through the §5.3 degrade path; use
// the official appendCompaction channel to journal one.
degradedSession.appendCompaction("omp default chain took over", undefined, d1, 4096);
const degradedFile = degradedSession.getSessionFile()!;
assert.ok(degradedFile.startsWith(getAgentDir()), `degraded session file must stay in the profile agentDir, got ${degradedFile}`);

const reopened2 = await SessionManager.open(degradedFile, undefined, undefined, { suppressBreadcrumb: true });
const state2 = rebuildAcpState(reopened2.getEntries());
assert.equal(state2.degraded, true, "base compaction entry ⇒ degraded, ACP state does not advance");
assert.equal(state2.zone.length, 0);
assert.equal(state2.compressedBlockIds.size, 0);
console.log("ok: session containing a base compaction entry rebuilds into degraded mode");

// --- malformed payload fails loudly ----------------------------------------------
assert.throws(
	() => rebuildAcpState([{ type: "custom", id: "x1", customType: "acpSummary", data: { summary: 42 } }] as never as SessionEntry[]),
	/malformed acpSummary entry x1/,
);
console.log("ok: malformed acpSummary entry rejected loudly");

// Delete each session's whole directory: rmSync(file) leaves the session dir
// plus its .lock.os sidecar behind (T3 cleanup fix). Directory names may start
// with "-", which is harmless for joined paths.
rmSync(dirname(sessionFile), { recursive: true, force: true });
rmSync(dirname(degradedFile), { recursive: true, force: true });
assert.ok(!existsSync(dirname(sessionFile)) && !existsSync(dirname(degradedFile)), "session dirs fully removed");
console.log("\nALL ACP T2 PERSIST SMOKE CHECKS PASSED");
