// Automations smoke test: pure-module coverage of the scheduling domain — no WS, no
// real sessions. Exercises the store (read/write/corrupt-file tolerance/run trimming),
// the cron math (five rule units, raw cron, dual-track dispatch), and the scheduler
// state machine (due dispatch, misfire grace, maxRuns/endAt completion, disabled
// claim, manual runs, spawn/prompt failure paths) through tickAutomations with an
// injected fake spawn and a temp agentDir, so the real profile files are never touched.
// Also covers the two create entry points that sit in front of that domain: the
// agent-facing create_automation tool (param translation, rejection surfaces, the
// automations_list push) and the session_list automation badge backfill.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-automations.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { H, activeWs } from "../host/state.ts";
import { SessionManager } from "../host/bootstrap.ts";
import { createAutomationTool } from "../host/automations-tool.ts";
import { handleListSessions } from "../host/rpc/session.ts";
import {
  AUTOMATION_CREATE_LIMIT,
  RUNS_PER_AUTOMATION_KEEP,
  type Automation,
  type AutomationRun,
} from "../host/automations/types.ts";
import { readAutomations, trimRuns, writeAutomations } from "../host/automations/store.ts";
import {
  computeAutomationNextRunAt,
  computeCronNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShot,
  isValidCronExpr,
} from "../host/automations/cron.ts";
import { runAutomationNow, tickAutomations } from "../host/automations/scheduler.ts";

// ---------- isolation: point the store at a throwaway agentDir ----------
const agentDir = mkdtempSync(path.join(tmpdir(), "omp-automations-smoke-"));
H.agentDir = agentDir;

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    console.error(`FAIL ${name}`, detail ?? "");
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, { actual, expected });
}

// settleRun write-backs hang off void sendPrompt().then(...); a macrotask tick
// lets those microtask chains finish before the assertions read the file.
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

// ---------- fixtures ----------
let seq = 0;
function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  seq += 1;
  const createdAt = Date.parse("2026-01-05T08:00:00");
  return {
    id: `automation-smoke-${seq}`,
    title: `smoke-${seq}`,
    prompt: "do the thing",
    cwd: agentDir,
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycle: "active",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function minuteRule(anchorAt: number, interval = 1) {
  return { unit: "minute" as const, interval, hour: 0, minute: 0, anchorAt };
}

function persist(a: Automation, runs: Record<string, AutomationRun[]> = {}): void {
  writeAutomations({ automations: [a], runs });
}

function readOne(id: string): Automation | undefined {
  return readAutomations().automations.find((x) => x.id === id);
}

function runsOf(id: string): AutomationRun[] {
  return readAutomations().runs[id] ?? [];
}

const spawnCalls: Automation[] = [];
function goodSpawn(): (a: Automation) => Promise<{ sessionId: string; sendPrompt: () => Promise<void> }> {
  spawnCalls.length = 0;
  return async (a) => {
    spawnCalls.push(a);
    return { sessionId: "sess-fake-1", sendPrompt: async () => {} };
  };
}

async function main(): Promise<void> {
  // ================= 1. store =================
  const roundtrip = makeAutomation();
  const runRow: AutomationRun = {
    runId: `${roundtrip.id}:1000`,
    automationId: roundtrip.id,
    scheduledAt: 1000,
    trigger: "schedule",
    status: "succeeded",
    createdAt: 1000,
    updatedAt: 1000,
  };
  writeAutomations({ automations: [roundtrip], runs: { [roundtrip.id]: [runRow] } });
  const back = readAutomations();
  eq("store: roundtrip automation count", back.automations.length, 1);
  ok("store: roundtrip automation deep-equal", JSON.stringify(back.automations[0]) === JSON.stringify(roundtrip));
  ok("store: roundtrip runs deep-equal", JSON.stringify(back.runs[roundtrip.id]) === JSON.stringify([runRow]));

  writeFileSync(path.join(agentDir, "automations.json"), "{ this is not json");
  const corrupt = readAutomations();
  eq("store: corrupt file -> empty automations", corrupt.automations.length, 0);
  eq("store: corrupt file -> empty runs", Object.keys(corrupt.runs).length, 0);

  eq("store: create limit constant is 20", AUTOMATION_CREATE_LIMIT, 20);
  const nineteen = Array.from({ length: AUTOMATION_CREATE_LIMIT - 1 }, () => makeAutomation());
  ok("store: create allowed below limit", nineteen.length < AUTOMATION_CREATE_LIMIT);
  nineteen.push(makeAutomation(), makeAutomation());
  ok("store: 21st create would be rejected", !(nineteen.length < AUTOMATION_CREATE_LIMIT));

  const trimId = "automation-trim";
  const trimRunsState: Record<string, AutomationRun[]> = {
    [trimId]: Array.from({ length: 14 }, (_, i) => ({
      runId: `${trimId}:${i}`,
      automationId: trimId,
      trigger: "schedule" as const,
      status: "succeeded" as const,
      createdAt: i + 1,
      updatedAt: i + 1,
    })),
  };
  trimRuns(trimRunsState, trimId);
  eq("store: trimRuns keeps newest 10", trimRunsState[trimId].length, RUNS_PER_AUTOMATION_KEEP);
  eq("store: trimRuns keeps the newest row", trimRunsState[trimId][0].runId, `${trimId}:13`);
  eq("store: trimRuns drops the oldest row", trimRunsState[trimId][9].runId, `${trimId}:4`);
  trimRuns(trimRunsState, "automation-unknown");
  ok("store: trimRuns no-op for unknown id", trimRunsState["automation-unknown"] === undefined);

  // ================= 2. cron math =================
  const T0 = Date.parse("2026-01-05T08:00:00"); // a Monday, local time

  // minute interval=90: fixed phase from the anchor, no wall-clock snapping
  const m90 = minuteRule(T0, 90);
  eq("cron: minute i90 from anchor", computeScheduleRuleNextRunAt(m90, T0), T0 + 90 * 60_000);
  eq("cron: minute i90 mid-cycle", computeScheduleRuleNextRunAt(m90, T0 + 200 * 60_000), T0 + 270 * 60_000);
  eq("cron: minute i90 strictly advances at slot", computeScheduleRuleNextRunAt(m90, T0 + 90 * 60_000), T0 + 180 * 60_000);

  // hourly interval=3 at :17
  const hRule = { unit: "hourly" as const, interval: 3, hour: 8, minute: 17, anchorAt: T0 };
  const base = new Date(2026, 0, 5, 8, 17).getTime();
  eq("cron: hourly i3 from base", computeScheduleRuleNextRunAt(hRule, base), base + 3 * 3_600_000);
  eq("cron: hourly i3 one step in", computeScheduleRuleNextRunAt(hRule, base + 3_600_000), base + 3 * 3_600_000);
  eq("cron: hourly i3 at slot", computeScheduleRuleNextRunAt(hRule, base + 3 * 3_600_000), base + 6 * 3_600_000);

  // daily 14:30
  const dRule = { unit: "daily" as const, interval: 1, hour: 14, minute: 30, anchorAt: T0 };
  const morning = new Date(2026, 0, 5, 9, 0).getTime();
  eq("cron: daily same day", computeScheduleRuleNextRunAt(dRule, morning), new Date(2026, 0, 5, 14, 30).getTime());
  eq("cron: daily after slot -> next day", computeScheduleRuleNextRunAt(dRule, new Date(2026, 0, 5, 15, 0).getTime()), new Date(2026, 0, 6, 14, 30).getTime());
  const d2 = { ...dRule, interval: 2 };
  eq("cron: daily interval 2", computeScheduleRuleNextRunAt(d2, new Date(2026, 0, 5, 15, 0).getTime()), new Date(2026, 0, 7, 14, 30).getTime());

  // weekly [Mon, Wed] 09:00
  const wRule = { unit: "weekly" as const, interval: 1, hour: 9, minute: 0, anchorAt: T0, weekdays: [1, 3] };
  eq("cron: weekly mon->wed", computeScheduleRuleNextRunAt(wRule, new Date(2026, 0, 5, 10, 0).getTime()), new Date(2026, 0, 7, 9, 0).getTime());
  eq("cron: weekly wed->next mon", computeScheduleRuleNextRunAt(wRule, new Date(2026, 0, 7, 10, 0).getTime()), new Date(2026, 0, 12, 9, 0).getTime());

  // monthly [1, 15] 12:00
  const moRule = { unit: "monthly" as const, interval: 1, hour: 12, minute: 0, anchorAt: T0, monthDays: [1, 15] };
  eq("cron: monthly jan2->jan15", computeScheduleRuleNextRunAt(moRule, new Date(2026, 0, 2, 0, 0).getTime()), new Date(2026, 0, 15, 12, 0).getTime());
  eq("cron: monthly jan16->feb1", computeScheduleRuleNextRunAt(moRule, new Date(2026, 0, 16, 0, 0).getTime()), new Date(2026, 1, 1, 12, 0).getTime());
  eq("cron: monthly invalid day skipped", computeScheduleRuleNextRunAt({ ...moRule, monthDays: [30, 31] }, new Date(2026, 1, 28, 13, 0).getTime()), new Date(2026, 2, 30, 12, 0).getTime());

  // raw cron: both same-day boundaries
  const cronExpr = "30 14 * * *";
  eq("cron: expr same day", computeCronNextRunAt(cronExpr, morning), new Date(2026, 0, 5, 14, 30).getTime());
  eq("cron: expr after slot -> next day", computeCronNextRunAt(cronExpr, new Date(2026, 0, 5, 15, 0).getTime()), new Date(2026, 0, 6, 14, 30).getTime());

  // dual-track dispatch: rule wins, cron is the fallback, neither -> null
  eq("cron: dual-track rule wins", computeAutomationNextRunAt({ scheduleRule: dRule, cronExpr }, morning), new Date(2026, 0, 5, 14, 30).getTime());
  eq("cron: dual-track cron fallback", computeAutomationNextRunAt({ cronExpr }, morning), new Date(2026, 0, 5, 14, 30).getTime());
  eq("cron: dual-track nothing -> null", computeAutomationNextRunAt({}), null);

  ok("cron: valid expr accepted", isValidCronExpr("*/5 * * * *"));
  ok("cron: valid ranges accepted", isValidCronExpr("30 14 * * 1-5"));
  ok("cron: garbage rejected", !isValidCronExpr("not a cron"));
  ok("cron: four fields rejected", !isValidCronExpr("30 14 * *"));

  // one-shot helper
  ok("cron: isOneShot default", isOneShot({ recurring: false }));
  ok("cron: isOneShot maxRuns 1", isOneShot({ recurring: false, maxRuns: 1 }));
  ok("cron: recurring not one-shot", !isOneShot({ recurring: true, maxRuns: 1 }));
  ok("cron: maxRuns 2 not one-shot", !isOneShot({ recurring: false, maxRuns: 2 }));

  // ================= 3. scheduler state machine =================
  // 3a. due dispatch advances state, run settles running -> succeeded
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({ now: T0 + 60_000, spawn: goodSpawn() });
    const after = readOne(a.id)!;
    eq("tick: dispatched once", spawnCalls.length, 1);
    eq("tick: runCount advanced", after.runCount, 1);
    eq("tick: lastRunAt = now", after.lastRunAt, T0 + 60_000);
    eq("tick: nextRunAt advanced one step", after.nextRunAt, T0 + 120_000);
    eq("tick: lifecycle still active", after.lifecycle, "active");
    const [row] = runsOf(a.id);
    eq("tick: run trigger schedule", row?.trigger, "schedule");
    eq("tick: runId embeds scheduledAt", row?.runId, `${a.id}:${T0 + 60_000}`);
    await flushAsync();
    eq("tick: run settled succeeded", runsOf(a.id)[0]?.status, "succeeded");
    ok("tick: no lastError on success", readOne(a.id)?.lastError === undefined);
  }

  // 3b. misfire beyond grace: recurring rolls forward, run skipped, nothing spawned
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0, 30), nextRunAt: T0 + 30 * 60_000 });
    persist(a);
    const now = a.nextRunAt! + 6 * 60_000; // 6 min late > 5 min grace
    await tickAutomations({ now, spawn: goodSpawn() });
    eq("misfire: nothing spawned", spawnCalls.length, 0);
    eq("misfire: runCount untouched", readOne(a.id)!.runCount, 0);
    eq("misfire: run skipped", runsOf(a.id)[0]?.status, "skipped");
    eq("misfire: skip reason", runsOf(a.id)[0]?.error, "missed window");
    const rolled = readOne(a.id)!.nextRunAt!;
    ok("misfire: recurring rolls past now", rolled > now, { rolled, now });
  }

  // 3c. misfire on a one-shot: completed, no nextRunAt
  {
    const a = makeAutomation({ recurring: false, scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({ now: a.nextRunAt! + 6 * 60_000, spawn: goodSpawn() });
    const after = readOne(a.id)!;
    eq("misfire one-shot: completed", after.lifecycle, "completed");
    ok("misfire one-shot: nextRunAt cleared", after.nextRunAt === undefined);
    eq("misfire one-shot: skipped run recorded", runsOf(a.id)[0]?.status, "skipped");
  }

  // 3d. within grace: still dispatched (late but not skipped)
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({ now: a.nextRunAt! + 4 * 60_000, spawn: goodSpawn() });
    eq("grace: dispatched within 5min", spawnCalls.length, 1);
  }

  // 3e. maxRuns reached: second run completes the task and clears nextRunAt
  {
    const a = makeAutomation({ recurring: false, maxRuns: 2, scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({ now: T0 + 60_000, spawn: goodSpawn() });
    const mid = readOne(a.id)!;
    eq("maxRuns: first run stays active", mid.lifecycle, "active");
    eq("maxRuns: first run advances nextRunAt", mid.nextRunAt, T0 + 120_000);
    await tickAutomations({ now: T0 + 120_000, spawn: goodSpawn() });
    const done = readOne(a.id)!;
    eq("maxRuns: runCount 2", done.runCount, 2);
    eq("maxRuns: completed", done.lifecycle, "completed");
    ok("maxRuns: nextRunAt cleared", done.nextRunAt === undefined);
    eq("maxRuns: two runs in ledger", runsOf(a.id).length, 2);
  }

  // 3f. enabled=false is never claimed
  {
    const a = makeAutomation({ enabled: false, scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({ now: T0 + 60_000, spawn: goodSpawn() });
    eq("disabled: nothing spawned", spawnCalls.length, 0);
    eq("disabled: runCount untouched", readOne(a.id)!.runCount, 0);
    eq("disabled: no runs", runsOf(a.id).length, 0);
  }

  // 3g. manual run: ledger entry only, no progression
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000, runCount: 3 });
    persist(a);
    const before = readOne(a.id)!;
    const res = await runAutomationNow(a.id, goodSpawn());
    ok("manual: runId is manual-shaped", res.runId.startsWith(`${a.id}:manual:`), res.runId);
    eq("manual: sessionId returned", res.sessionId, "sess-fake-1");
    const row = runsOf(a.id).find((r) => r.runId === res.runId);
    eq("manual: trigger manual", row?.trigger, "manual");
    await flushAsync();
    eq("manual: run settled succeeded", runsOf(a.id).find((r) => r.runId === res.runId)?.status, "succeeded");
    const after = readOne(a.id)!;
    eq("manual: runCount untouched", after.runCount, before.runCount);
    eq("manual: nextRunAt untouched", after.nextRunAt, before.nextRunAt);
    eq("manual: lifecycle untouched", after.lifecycle, "active");
    eq("manual: no schedule run appended", runsOf(a.id).filter((r) => r.trigger === "schedule").length, 0);
  }

  // 3h. manual run on a disabled automation is rejected
  {
    const a = makeAutomation({ enabled: false });
    persist(a);
    let threw = false;
    try {
      await runAutomationNow(a.id, goodSpawn());
    } catch {
      threw = true;
    }
    ok("manual disabled: throws", threw);
  }

  // 3i. endAt exceeded: next slot would be past the deadline -> completes on dispatch
  {
    const a = makeAutomation({
      scheduleRule: minuteRule(T0),
      nextRunAt: T0 + 60_000,
      endAt: T0 + 90_000, // next slot T0+2min > endAt
    });
    persist(a);
    await tickAutomations({ now: T0 + 60_000, spawn: goodSpawn() });
    const after = readOne(a.id)!;
    eq("endAt: final run dispatched", after.runCount, 1);
    eq("endAt: completed", after.lifecycle, "completed");
    ok("endAt: nextRunAt cleared", after.nextRunAt === undefined);
    eq("endAt: run settled succeeded", (await flushAsync(), runsOf(a.id)[0]?.status), "succeeded");
  }

  // 3j. not-yet-due tasks are left alone
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({ now: T0 + 59_999, spawn: goodSpawn() });
    eq("future: nothing spawned", spawnCalls.length, 0);
    eq("future: runCount untouched", readOne(a.id)!.runCount, 0);
  }

  // ================= 4. failure paths =================
  // 4a. spawn throws: run failed + lastError, lifecycle stays active
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({
      now: T0 + 60_000,
      spawn: async () => {
        throw new Error("spawn boom");
      },
    });
    await flushAsync();
    const after = readOne(a.id)!;
    eq("spawn-fail: runCount still advanced", after.runCount, 1);
    eq("spawn-fail: lifecycle stays active", after.lifecycle, "active");
    ok("spawn-fail: nextRunAt kept", after.nextRunAt === T0 + 120_000);
    eq("spawn-fail: run failed", runsOf(a.id)[0]?.status, "failed");
    eq("spawn-fail: run error text", runsOf(a.id)[0]?.error, "Error: spawn boom");
    ok("spawn-fail: lastError recorded", after.lastError === "Error: spawn boom");
  }

  // 4b. sendPrompt rejects: same ledger outcome
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000 });
    persist(a);
    await tickAutomations({
      now: T0 + 60_000,
      spawn: async () => ({
        sessionId: "sess-fake-2",
        sendPrompt: async () => {
          throw new Error("prompt boom");
        },
      }),
    });
    await flushAsync();
    const after = readOne(a.id)!;
    eq("prompt-fail: run failed", runsOf(a.id)[0]?.status, "failed");
    ok("prompt-fail: lastError recorded", after.lastError === "Error: prompt boom");
    eq("prompt-fail: lifecycle stays active", after.lifecycle, "active");
  }

  // 4c. a later success clears lastError
  {
    const a = makeAutomation({ scheduleRule: minuteRule(T0), nextRunAt: T0 + 60_000, lastError: "stale" });
    persist(a);
    await tickAutomations({ now: T0 + 60_000, spawn: goodSpawn() });
    await flushAsync();
    ok("recovery: lastError cleared on success", readOne(a.id)?.lastError === undefined);
  }

  // ================= 5. session_list badge backfill from the runs ledger =================
  // handleListSessions must keep the automation badge after pool eviction/restart:
  // run rows persist sessionPath at dispatch time, so the ledger backfills what
  // the live pool no longer knows.
  {
    H.desktopProjectsPath = path.join(agentDir, "omp-desktop.json");
    const badge = makeAutomation({ id: "automation-badge", title: "badge run" });
    const sessionFile = path.join(agentDir, "badge-session.jsonl");
    writeFileSync(
      sessionFile,
      `{"type":"session","version":3}\n{"type":"message","role":"user","timestamp":"2026-10-11T08:00:00.000Z","content":[{"type":"text","text":"hi"}]}\n`,
    );
    writeAutomations({
      automations: [badge],
      runs: {
        [badge.id]: [
          {
            runId: `${badge.id}:manual:x`,
            automationId: badge.id,
            trigger: "manual",
            status: "succeeded",
            sessionPath: sessionFile,
            createdAt: 1,
            updatedAt: 1,
          },
          // No sessionPath (pre-attach failure shape): must not mark anything
          { runId: `${badge.id}:manual:y`, automationId: badge.id, trigger: "manual", status: "succeeded", createdAt: 2, updatedAt: 2 },
        ],
      },
    });
    // Pool is empty here (sessions Map untouched): only the ledger can badge the row.
    const info = {
      id: "disk-1",
      path: sessionFile,
      title: "badge session",
      firstMessage: "hi",
      modified: new Date(1),
      messageCount: 1,
      cwd: agentDir,
      size: 160,
    };
    const realListAll = SessionManager.listAll;
    // Test-only stub of the disk scan: SessionManager is a final static surface, replace the method wholesale and restore after.
    const listAllStub = SessionManager as unknown as { listAll: () => Promise<unknown[]> };
    listAllStub.listAll = async () => [info];
    try {
      // handleListSessions pushes more than session_list (pool_sessions rides along), so pick the frame by type instead of keeping the last one.
      const frames: { type?: string; projects?: { sessions: { path: string; automation?: { id: string; title: string } }[] }[] }[] = [];
      const ws = { send: (d: string) => frames.push(JSON.parse(d)) };
      await handleListSessions(ws);
      const sent = frames.find((f) => f.type === "session_list") ?? null;
      const rows = sent?.projects?.flatMap((p) => p.sessions) ?? [];
      const hit = rows.find((r) => r.path === sessionFile);
      ok("list: ledger backfills automation badge", hit !== undefined && hit.automation?.id === badge.id && hit.automation?.title === badge.title, hit);
      eq("list: run without sessionPath marks nothing", rows.filter((r) => r !== hit && r.automation).length, 0);
    } finally {
      listAllStub.listAll = realListAll;
    }
  }

  // ================= 6. create_automation tool (agent-facing create path) =================
  // The agent-facing tool translates flat params into the same domain create the
  // RPC calls, persists, and pushes automations_list to the connected UI.
  {
    const frames: { type?: string; automations?: unknown[] }[] = [];
    activeWs.value = { send: (d: string) => frames.push(JSON.parse(d)) };
    const tool = createAutomationTool("/repo/session-cwd");
    const call = async (params: Record<string, unknown>) =>
      (await tool.execute("tool-call-1", params)) as { content: { text: string }[]; isError?: boolean };
    const base = readAutomations().automations.length;

    const daily = await call({ title: "Standup brief", prompt: "summarize yesterday" });
    ok("tool: daily create ok", !daily.isError, daily.content[0].text);
    const d = readAutomations().automations[base];
    ok("tool: daily persisted", d?.title === "Standup brief" && d?.prompt === "summarize yesterday", d);
    ok("tool: cwd falls back to session cwd", d?.cwd === "/repo/session-cwd", d?.cwd);
    ok("tool: recurring by default", d?.recurring === true, d?.recurring);
    ok("tool: default time 09:00", d?.scheduleRule?.hour === 9 && d?.scheduleRule?.minute === 0, d?.scheduleRule);
    ok("tool: nextRunAt computed", typeof d?.nextRunAt === "number", d?.nextRunAt);
    ok("tool: automations_list pushed", frames.some((f) => f.type === "automations_list"), frames.length);

    const weekly = await call({
      title: "Monday review",
      prompt: "review the board",
      every: "weekly",
      at: "18:45",
      weekdays: [1],
      cwd: "/repo/other",
    });
    ok("tool: weekly create ok", !weekly.isError, weekly.content[0].text);
    const w = readAutomations().automations[base + 1];
    ok("tool: at parsed into hour/minute", w?.scheduleRule?.hour === 18 && w?.scheduleRule?.minute === 45, w?.scheduleRule);
    ok("tool: weekdays passed through", JSON.stringify(w?.scheduleRule?.weekdays) === "[1]", w?.scheduleRule?.weekdays);
    ok("tool: explicit cwd wins", w?.cwd === "/repo/other", w?.cwd);

    const oneShot = await call({ title: "One off", prompt: "check deploy", every: "daily", at: "07:00", recurring: false });
    ok("tool: one-shot create ok", !oneShot.isError, oneShot.content[0].text);
    ok("tool: recurring false stored", readAutomations().automations[base + 2]?.recurring === false);

    const cron = await call({ title: "Cron job", prompt: "poll", cron: "*/15 * * * *" });
    ok("tool: cron create ok", !cron.isError, cron.content[0].text);
    const c = readAutomations().automations[base + 3];
    ok("tool: cron replaces rule fields", c?.cronExpr === "*/15 * * * *" && c?.scheduleRule === undefined, c);

    const before = readAutomations().automations.length;
    const badCron = await call({ title: "Bad cron", prompt: "x", cron: "not a cron" });
    ok("tool: invalid cron is a tool error", badCron.isError === true, badCron.content[0].text);
    const badAt = await call({ title: "Bad at", prompt: "x", at: "9am" });
    ok("tool: malformed at is a tool error", badAt.isError === true, badAt.content[0].text);
    const noTitle = await call({ title: "   ", prompt: "x" });
    ok("tool: empty title is a tool error", noTitle.isError === true, noTitle.content[0].text);
    eq("tool: rejected calls persist nothing", readAutomations().automations.length, before);

    // No UI attached: the frame push is advisory, persistence still succeeds.
    activeWs.value = null;
    const headless = await call({ title: "Headless", prompt: "x" });
    ok("tool: headless create ok", !headless.isError, headless.content[0].text);
    ok("tool: headless persisted", readAutomations().automations.some((a) => a.title === "Headless"));

    // Subagent refusal: live task-spawned subagents inherit the parent's custom
    // tools, so the entry rejects on taskDepth (depth 0 = main session).
    const depthBefore = readAutomations().automations.length;
    const asSubagent = (await tool.execute("tool-call-2", { title: "From subagent", prompt: "x" }, undefined, undefined, {
      taskDepth: 1,
    })) as { content: { text: string }[]; isError?: boolean };
    ok("tool: subagent call refused", asSubagent.isError === true, asSubagent.content[0].text);
    eq("tool: refused subagent persists nothing", readAutomations().automations.length, depthBefore);
    const mainDepth = (await tool.execute("tool-call-3", { title: "Main depth", prompt: "x" }, undefined, undefined, {
      taskDepth: 0,
    })) as { isError?: boolean };
    ok("tool: taskDepth 0 still creates", mainDepth.isError !== true, mainDepth);

    // Second gate: the on-disk transcript shape (a child transcript lives inside
    // <parent>.jsonl/). Exercised without taskDepth, the way a reloaded session reaches it.
    const mainFile = path.join(agentDir, "main-session.jsonl");
    writeFileSync(mainFile, "{}\n");
    // Real layout: parent transcript is <X>.jsonl, the child transcript lives in the
    // sibling <X>/ directory — so dirname(child) + ".jsonl" is the parent file.
    writeFileSync(path.join(agentDir, "parent-session.jsonl"), "{}\n");
    const childDir = path.join(agentDir, "parent-session");
    mkdirSync(childDir, { recursive: true });
    const childFile = path.join(childDir, "Child.jsonl");
    writeFileSync(childFile, "{}\n");
    const withCtx = (sessionFile: string) => ({ sessionManager: { getSessionFile: () => sessionFile } });
    const childCall = (await tool.execute("tool-call-4", { title: "Child", prompt: "x" }, undefined, undefined, withCtx(childFile))) as {
      isError?: boolean;
    };
    ok("tool: child transcript refused without taskDepth", childCall.isError === true, childCall);
    eq("tool: refused child persists nothing", readAutomations().automations.length, depthBefore + 1);
    const mainCall = (await tool.execute("tool-call-5", { title: "Main file", prompt: "x" }, undefined, undefined, withCtx(mainFile))) as {
      isError?: boolean;
    };
    ok("tool: main-session transcript still creates", mainCall.isError !== true, mainCall);
  }
}

main()
  .then(() => {
    rmSync(agentDir, { recursive: true, force: true });
    if (failures.length > 0) {
      console.error(`\nSMOKE FAIL: ${failures.length} failed, ${passed} passed`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`SMOKE PASS: ${passed} assertions`);
    process.exit(0);
  })
  .catch((err) => {
    rmSync(agentDir, { recursive: true, force: true });
    console.error("SMOKE CRASH:", err);
    process.exit(1);
  });
