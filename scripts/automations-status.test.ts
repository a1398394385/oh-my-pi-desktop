// Automation status vocabulary: the UI projection of the host lifecycle and the
// run-status → i18n key table. Failure is a per-run outcome (run ledger status +
// lastError), never a lifecycle state, so the projection must only report "failed"
// from lastError; and every run status must resolve to a real label in both packs.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/automations-status.test.ts --pool=forks --poolOptions.forks.singleFork
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import type { Automation, AutomationRunStatus } from "../ui-src/lib/automations";

// ws.ts binds invoke from window.__TAURI__ at module scope, so the stub must exist
// before the store graph loads (same shape as chat-loading-status.test.ts).
(globalThis.window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke: async () => {} },
};
const i18n = await import("../ui-src/i18n");
await i18n.initI18n("zh-CN");
const { automationStatusKind, RUN_STATUS_LABEL_KEY } = await import("../ui-src/lib/automations");

function mk(patch: Partial<Automation>): Automation {
  return {
    id: "a1",
    title: "task",
    prompt: "prompt",
    cwd: "/tmp",
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe("automationStatusKind", () => {
  test("an enabled active definition is active", () => {
    expect(automationStatusKind(mk({}))).toBe("active");
  });

  test("the enable switch is the only pause source", () => {
    expect(automationStatusKind(mk({ enabled: false }))).toBe("paused");
  });

  test("a terminal definition reads completed", () => {
    expect(automationStatusKind(mk({ lifecycle: "completed" }))).toBe("completed");
  });

  test("a failed run surfaces as failed", () => {
    expect(automationStatusKind(mk({ lastError: "model timeout" }))).toBe("failed");
  });

  test("a blank lastError never reads as failed", () => {
    expect(automationStatusKind(mk({ lastError: "   " }))).toBe("active");
  });
});

const RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const satisfies readonly AutomationRunStatus[];

describe("run status labels", () => {
  test("the label table lists exactly the run statuses", () => {
    expect(Object.keys(RUN_STATUS_LABEL_KEY).sort()).toEqual([...RUN_STATUSES].sort());
  });

  for (const status of RUN_STATUSES) {
    test(`${status} resolves to a label in both languages`, async () => {
      const key = RUN_STATUS_LABEL_KEY[status];
      for (const lang of ["zh-CN", "en"] as const) {
        await i18n.default.changeLanguage(lang);
        expect(i18n.default.t(key)).not.toBe(key);
      }
      await i18n.default.changeLanguage("zh-CN");
    });
  }
});
