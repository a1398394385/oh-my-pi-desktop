// Background-job rows must carry the base's four-state AsyncJob.status: collapsing
// it to a boolean showed failed and cancelled jobs as "done" in the right panel.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/bg-jobs-status.test.ts
import { describe, expect, test } from "bun:test";
import { bgJobsPayload } from "../host/async-jobs.ts";
import type { PoolEntry } from "../host/state.ts";

type Status = "running" | "completed" | "failed" | "cancelled";

const fakeSession = (statuses: Status[]): PoolEntry["session"] =>
  ({
    getAsyncJobSnapshot: () => ({
      running: [],
      recent: statuses.map((status, i) => ({
        id: `job-${i}`,
        type: "eval", // process-less row: no inspect exit code to fall back on
        status,
        label: `job ${i}`,
        startTime: 0,
      })),
    }),
    inspectAsyncJob: () => ({}),
    getRunningJobWidgets: () => [],
  }) as unknown as PoolEntry["session"];

describe("bgJobsPayload job status", () => {
  test("the four base states stay distinguishable", () => {
    const rows = bgJobsPayload(fakeSession(["running", "completed", "failed", "cancelled"]));
    expect(rows.map((r) => r.status)).toEqual(["running", "completed", "failed", "cancelled"]);
  });

  test("running stays a faithful projection of status", () => {
    const rows = bgJobsPayload(fakeSession(["running", "failed"]));
    expect(rows.map((r) => r.running)).toEqual([true, false]);
  });
});
