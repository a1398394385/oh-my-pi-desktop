// ACP child-session ownership smoke: the projection extension must fire ONLY for
// the session whose AcpRuntimeState it closed over.
//
// Why this exists: the ACP projection is registered as an inline extension, and the
// SDK deliberately rebinds inline factories into child sessions (sdk.ts preparedExtensions
// → task/structured-subagent.ts preloadedPreparedExtensions → bindExtension re-runs the
// same closure). The closure holds the OWNER's journal/zone/compressed set, and
// projectContext prints that zone unconditionally (acp-projection.ts:226) — so without an
// ownership check a `task` subagent receives the parent's compaction blocks as synthetic
// user turns and is told it did work it never did. Fingerprint-based detection is not a
// substitute: a child can legitimately match a parent message (same system reminder, same
// recall result), and one match is enough to re-enter the full projection path.
//
// This drives the real rebind path — a child session built with preloadedPreparedExtensions,
// exactly what task/structured-subagent.ts:609 hands its executor — so a regression in the
// SDK's rebind wiring is caught here too, not just in our handler.
//
// Layers:
//   A  parent: the owner's context event is projected (its compaction block renders)
//   B  child:  the inherited closure passes the child's view through untouched — no parent
//              block, no ACP ephemeral, no injected turn
//   C  discrimination is real: the two sessions carry different ids, so B is not passing
//      for the trivial reason that every session somehow matches
//
// All session data lands under the OMP_PROFILE=omp-desktop-test profile only; the
// smoke deletes its own session directories at the end.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-acp-child-ownership.ts
import { TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";

import { AcpRuntimeState, createAcpProjectionExtension } from "../host/acp-runtime.ts";
import type { AcpParams } from "../host/acp-plan.ts";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");
// Dynamic import exception: the coding-agent module resolves agentDir at import
// time, so the profile must be active before the module loads (same precedent as
// every other acp smoke).
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
registerMockApi();

interface MockCall {
	context: { messages: Array<{ role: string; content?: unknown }> };
}

/** Compaction-block marker no real turn contains: its presence proves the zone projected. */
const ZONE_MARKER = "OWNER-ZONE-MARKER-9f3a";

const glm5 = new Tokenizer({ tokenizer: "glm5" });
const countTokens = (s: string) => glm5.countTokens(s);

const roots: string[] = [];
function scratch(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `acp-child-${label}-`));
	roots.push(dir);
	return dir;
}

/** Bounded wait for a mock request to land (10ms poll, 10s ceiling). */
async function waitForCall(calls: MockCall[], from: number): Promise<number> {
	const start = Date.now();
	while (Date.now() - start < 10_000) {
		if (calls.length > from) return from;
		await Bun.sleep(10);
	}
	assert.fail(`timeout waiting for request #${from + 1} on the wire (got ${calls.length})`);
}

const E2E_WINDOW = 400_000;
// Tiers are absolute token counts, and this smoke only needs the zone to render —
// so keep the owner in the "none" tier: any pressure above l1 escalates toward a
// forced compress that would degrade the session (and a degraded state passes every
// view through, which is indistinguishable from the pass-through we are asserting).
const params = { l1: 1_000_000, l2: 2_000_000, l3: 3_000_000 } satisfies Partial<AcpParams>;

const calls: MockCall[] = [];
const mock = createMockModel({
	contextWindow: E2E_WINDOW,
	handler: (context: never) => {
		const messages = (context as unknown as MockCall["context"]).messages;
		calls.push({ context: { messages } });
		return { content: [{ type: "text", text: "recorded." }] };
	},
});

async function build(cwd: string, sessionManager: SessionManager, extra: Record<string, unknown> = {}) {
	const settings = Settings.isolated({}).overlay({ "compaction.enabled": false });
	const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
	authStorage.keys.setRuntime("mock", "mock-key");
	const { session } = await createAgentSession({
		cwd,
		settings,
		// Mirrors host/session-lifecycle.ts: ACP pins compaction.enabled off for the primary,
		// so the advisor must be opted back in explicitly or it loses compaction maintenance.
		advisorCompactionEnabled: true,
		model: mock,
		modelRegistry: new ModelRegistry(authStorage, join(cwd, "models.yml")),
		agentRegistry: new AgentRegistry(),
		sessionManager,
		getApiKey: async () => "mock-key",
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: true,
		...extra,
	});
	return session;
}

// ---- owner: seed a compaction block so its zone has something to render ----

const cwdOwner = scratch("owner");
const ownerMgr = SessionManager.create(cwdOwner);
const ownerFile = ownerMgr.getSessionFile()!;
assert.ok(ownerFile.startsWith(getAgentDir()), `owner session must stay inside the smoke profile agentDir, got ${ownerFile}`);
roots.push(dirname(ownerFile));

const state = new AcpRuntimeState({
	countTokens,
	sink: ownerMgr,
	getEntries: () => ownerMgr.getEntries(),
	contextWindow: E2E_WINDOW,
	params,
});
// The ownership check reads the id through this getter on EVERY event, so a fork
// (which re-mints SessionManager's id) moves both sides together — a build-time
// snapshot would freeze it here.
const projection = createAcpProjectionExtension(state, () => ownerMgr.getSessionId());

const owner = await build(cwdOwner, ownerMgr, { extensions: [projection] as never });
owner.subscribe((ev: { type: string }) => {
	if (ev.type === "turn_end") state.onTurnEnd();
});

let mark = 0;
await owner.prompt("owner first turn");
await waitForCall(calls, mark++);
await owner.prompt("owner second turn");
await waitForCall(calls, mark++);

// Seed the zone directly: projectView renders `state.zone` (acp-runtime), and a block's
// rendered text carries `summary` + the index intents (renderCompactionBlock), so the marker
// has to live there for "the zone was projected" to be observable on the wire.
state.zone = [
	{
		id: "seed-block",
		summary: ZONE_MARKER,
		index: [{ id: "b1", intent: "first block", tokens: 10 }],
		meta: {
			createdAt: Date.now(),
			depth: 0,
			method: "normal",
			keepIds: [],
			compressedIds: [],
			supersedes: [],
			tokensBefore: 100,
			tokensAfter: 10,
		},
	},
];

// ---- A: the owner's own request carries its zone ----

await owner.prompt("owner third turn");
await waitForCall(calls, mark++);
const ownerView = JSON.stringify(calls[mark - 1]!.context.messages);
assert.ok(ownerView.includes(ZONE_MARKER), "A: the owning session projects its own compaction zone");

// ---- B: the child inherits the closure and must pass through ----

const parentPrepared = (owner as unknown as { preparedExtensions?: unknown }).preparedExtensions;
assert.ok(Array.isArray(parentPrepared) && parentPrepared.length > 0, "the owner registered a prepared extension for the child to inherit");
assert.ok(
	parentPrepared.some((p: unknown) => typeof p === "object" && p !== null && "factory" in p && "path" in p),
	"the inherited entry is the inline factory itself (the shape bindExtension re-runs)",
);

const cwdChild = scratch("child");
const childMgr = SessionManager.create(cwdChild);
// preloadedPreparedExtensions is exactly what task/structured-subagent.ts:609 passes.
const child = await build(cwdChild, childMgr, { preloadedPreparedExtensions: parentPrepared as never });

await child.prompt("child first turn");
await waitForCall(calls, mark++);
const childCall = calls[mark - 1]!;
const childView = JSON.stringify(childCall.context.messages);
assert.ok(!childView.includes(ZONE_MARKER), "B: the child must NOT receive the parent's compaction zone");
assert.ok(!childView.includes("[compress-hint]"), "B: the child must not receive the owner's ACP ephemeral");
assert.ok(childView.includes("child first turn"), "B: sanity — the child's own turn is on its wire view");
assert.equal(
	childCall.context.messages.filter((m) => m.role === "user").length,
	1,
	"B: the child's view carries only its own user turn — nothing injected",
);

// ---- C: the discrimination is real ----

assert.notEqual(
	childMgr.getSessionId(),
	ownerMgr.getSessionId(),
	"C: the two sessions carry different ids, so the pass-through above is a real decision",
);

console.log("smoke-acp-child-ownership: PASS");
console.log("  A owner projects its own zone");
console.log("  B inherited closure passes a child session through untouched");
console.log("  C the two sessions carry distinct ids (the check discriminates)");

// Release the session + manager handles before removing anything: Windows keeps
// the session dir (and its lock sidecar) busy while a handle is open, so the
// cleanup below silently leaked the mapping dir into the profile.
await owner.dispose();
await child.dispose();
await ownerMgr.close();
await childMgr.close();

for (const dir of roots) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Windows lock window; the temp dirs are disposable
	}
}
