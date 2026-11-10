// ACP base-compaction guard (spec §5.3): the base chain must not fold the stored
// journal out from under the ACP zone, but it must only be blocked on the owning
// session and only for automatic runs. Overflow/incomplete recoveries degrade ACP
// first and are then allowed through, and a manual /compact is the operator asking
// for the base chain — never cancelled.
//
// Why the pin was replaced (2026-11-09): `compaction.enabled` is a settings-tree
// read, and a `task` child is a derived overlay of the parent's settings, so pinning
// it off on the ACP session also disabled base compaction inside every subagent of
// that session — which ACP does not cover at all.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/acp-compaction-guard.test.ts
import { describe, expect, test } from "bun:test";
import { createAcpProjectionExtension } from "../host/acp-assembly.ts";
import type { AcpRuntimeState } from "../host/acp-runtime.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const OWNER = "owner-session";

function harness() {
	const handlers = new Map<string, Handler>();
	const degraded: string[] = [];
	const state = {
		degrade: (reason: string) => {
			degraded.push(reason);
		},
		projectView: (view: unknown[]) => view,
	} as unknown as AcpRuntimeState;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	createAcpProjectionExtension(state, () => OWNER)(pi as never);
	const fire = (event: string, payload: unknown = {}, sessionId = OWNER) =>
		handlers.get(event)?.(payload, { sessionManager: { getSessionId: () => sessionId } });
	return { fire, degraded };
}

describe("ACP base-compaction guard", () => {
	test("cancels an automatic threshold run", () => {
		const { fire } = harness();
		fire("auto_compaction_start", { reason: "threshold" });
		expect(fire("session_before_compact")).toEqual({ cancel: true });
	});

	test("cancels an idle run", () => {
		const { fire } = harness();
		fire("auto_compaction_start", { reason: "idle" });
		expect(fire("session_before_compact")).toEqual({ cancel: true });
	});

	test("lets overflow through after degrading ACP first", () => {
		const { fire, degraded } = harness();
		fire("auto_compaction_start", { reason: "overflow" });
		expect(degraded).toHaveLength(1);
		expect(degraded[0]).toContain("overflow");
		expect(fire("session_before_compact")).toBeUndefined();
	});

	test("lets an incomplete recovery through after degrading ACP", () => {
		const { fire, degraded } = harness();
		fire("auto_compaction_start", { reason: "incomplete" });
		expect(degraded).toHaveLength(1);
		expect(fire("session_before_compact")).toBeUndefined();
	});

	test("never touches a child session's compaction", () => {
		const { fire, degraded } = harness();
		fire("auto_compaction_start", { reason: "threshold" }, "child-session");
		fire("auto_compaction_start", { reason: "overflow" }, "child-session");
		expect(degraded).toHaveLength(0);
		expect(fire("session_before_compact", {}, "child-session")).toBeUndefined();
	});

	test("a cancelled run does not leak onto the next manual compaction", () => {
		const { fire } = harness();
		fire("auto_compaction_start", { reason: "threshold" });
		expect(fire("session_before_compact")).toEqual({ cancel: true });
		// Manual compaction emits no auto_compaction_start; the flag was consumed.
		expect(fire("session_before_compact")).toBeUndefined();
	});

	test("auto_compaction_end clears a run that never reached the hook", () => {
		const { fire } = harness();
		fire("auto_compaction_start", { reason: "threshold" });
		fire("auto_compaction_end", { aborted: true });
		expect(fire("session_before_compact")).toBeUndefined();
	});
});
