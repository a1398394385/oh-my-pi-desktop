// Automations scheduler: single-process polling driver over the automations
// store (ZCodium scheduler parity: croner only parses/computes, the poll loop
// dispatches). Semantics: misfire beyond the 5-minute grace marks the run
// skipped (one-shots complete); due dispatches use an advance-first protocol —
// runCount/nextRunAt/terminal lifecycle and the running ledger entry are
// persisted BEFORE the session is spawned, so a host crash between the steps
// can never re-execute a slot after restart. Dispatch failures never move the
// lifecycle (recorded as run failed + a.lastError; recurring tasks simply
// retry at the advanced slot). Manual runs bypass all progression.
import { randomUUID } from "node:crypto";
import { ensureSessionLoaded, spawnSession } from "../session-lifecycle.ts";
import { H, eachUiWs, stampEvent } from "../state.ts";
import { readAutomationDialogTimeouts } from "../profile.ts";
import { safeStderr } from "../stderr.ts";
import { computeAutomationNextRunAt, isOneShot } from "./cron.ts";
import { readAutomations, trimRuns, writeAutomations } from "./store.ts";
import {
  type Automation,
  type AutomationRun,
  type AutomationsFile,
  type SpawnFn,
  type SpawnOutcome,
  type TickOpts,
} from "./types.ts";
import { appendDeliveryMarker } from "./delivery.ts";

/** Poll cadence for the tick loop (ZCodium scheduler parity). */
const POLL_INTERVAL_MS = 20_000;
/** Scheduled slots older than this are never executed, only recorded as skipped. */
const MISFIRE_GRACE_MS = 5 * 60_000;

let timer: Timer | null = null;
// Re-entrancy guard: a slow dispatch must not stack overlapping ticks.
let ticking = false;
// Injected UI notification (set by main.ts); the scheduler never imports rpc/.
let notify: (() => void) | null = null;

/** Arm the poll loop; idempotent (already running -> no-op). */
export function startAutomationScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tickAutomations(), POLL_INTERVAL_MS);
  timer.unref?.(); // never hold the host process open for the poll loop alone
}

/**
 * Re-arm after a profile hot-switch: the store path derives from H.agentDir on
 * every read, so cancelling + restarting is enough; one immediate tick picks up
 * the new profile's file without waiting a poll interval. applyProfile is also
 * the boot path (profileReady awaits the first applyProfile), so this doubles
 * as the initial start — the single scheduler hook lives in profile.ts.
 */
export function reloadAutomationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  startAutomationScheduler(); // idempotent; boot-time applyProfile arms it first
  void tickAutomations().catch((err) => safeStderr(`[automations] reload tick failed: ${err}\n`));
}

/** Inject the UI notification callback (run created + run settled); null detaches. */
export function setAutomationNotify(fn: (() => void) | null): void {
  notify = fn;
}

/** Fire the notification best-effort; a broken callback must never kill a tick. */
function notifyUi(): void {
  try {
    notify?.();
  } catch {
    // notification is advisory only
  }
}

/** Append a run to the ledger and trim that automation's history in place. */
function pushRun(state: AutomationsFile, run: AutomationRun): void {
  const list = state.runs[run.automationId] ?? (state.runs[run.automationId] = []);
  list.push(run);
  trimRuns(state.runs, run.automationId);
}

/**
 * Read-modify-write one run's terminal state (and the automation's lastError).
 * Re-reads the document so concurrent write-backs (tick loop vs. finishing
 * turns) cannot clobber each other. No-op when the automation or the run was
 * deleted mid-flight.
 */
function settleRun(
  automationId: string,
  run: AutomationRun,
  status: "succeeded" | "failed",
  error: string | undefined,
  flags: { setLastError?: boolean; clearLastError?: boolean } = {},
): void {
  const state = readAutomations();
  const a = state.automations.find((x) => x.id === automationId);
  const list = state.runs[automationId];
  const index = list ? list.findIndex((r) => r.runId === run.runId) : -1;
  if (!a || index < 0) return;
  // Merge onto the stored row (not the caller's snapshot): attachRunSession may
  // have written sessionId/sessionPath between dispatch and this settle.
  const base = list[index] ?? run;
  base.status = status;
  base.updatedAt = Date.now();
  if (error !== undefined) base.error = error;
  else delete base.error;
  list[index] = { ...base };
  trimRuns(state.runs, automationId);
  a.updatedAt = run.updatedAt;
  if (flags.setLastError && error !== undefined) a.lastError = error;
  if (flags.clearLastError && status === "succeeded") delete a.lastError;
  writeAutomations(state);
  notifyUi();
}

/** Attach the spawned session to the ledger row (history "open session" jumps
 * read it): same fresh read-modify-write discipline as settleRun. */
function attachRunSession(automationId: string, runId: string, outcome: SpawnOutcome): void {
  const state = readAutomations();
  const list = state.runs[automationId];
  const index = list ? list.findIndex((r) => r.runId === runId) : -1;
  if (index < 0) return;
  list[index] = {
    ...list[index],
    sessionId: outcome.sessionId,
    sessionPath: outcome.sessionPath,
    updatedAt: Date.now(),
  };
  writeAutomations(state);
}

/** Record a missed slot without executing it; recurring rolls forward, one-shots complete. */
function handleMisfire(state: AutomationsFile, a: Automation, scheduledAt: number, now: number): void {
  const run: AutomationRun = {
    runId: `${a.id}:${scheduledAt}`,
    automationId: a.id,
    scheduledAt,
    trigger: "schedule",
    status: "skipped",
    error: "missed window",
    createdAt: now,
    updatedAt: now,
  };
  pushRun(state, run);
  // One-shots never re-fire; recurring tasks roll forward from now (ZCodium
  // misfire parity), so every slot missed while the host was down is skipped.
  const next = isOneShot(a) ? null : computeAutomationNextRunAt(a, now);
  if (next === null) {
    a.lifecycle = "completed";
    delete a.nextRunAt;
  } else {
    a.nextRunAt = next;
  }
  a.updatedAt = now;
  writeAutomations(state);
  notifyUi();
}

/** Dispatch one due slot: advance scheduling state first, persist, then spawn. */
async function dispatchDue(state: AutomationsFile, a: Automation, scheduledAt: number, now: number, spawn: SpawnFn): Promise<void> {
  const next = computeAutomationNextRunAt(a, scheduledAt);
  const reachedMax = !a.recurring && a.runCount + 1 >= (a.maxRuns ?? 1);
  const pastEnd = next !== null && typeof a.endAt === "number" && next > a.endAt;
  const terminal = reachedMax || pastEnd || next === null;
  a.runCount += 1;
  a.lastRunAt = now;
  if (terminal) {
    a.lifecycle = "completed";
    delete a.nextRunAt;
  } else {
    a.nextRunAt = next as number;
  }
  const run: AutomationRun = {
    runId: `${a.id}:${scheduledAt}`,
    automationId: a.id,
    scheduledAt,
    trigger: "schedule",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  pushRun(state, run);
  a.updatedAt = now;
  // Crash-safety barrier: the advanced pointer + running ledger entry are on
  // disk before any dispatch attempt.
  writeAutomations(state);
  notifyUi();
  let outcome: SpawnOutcome;
  try {
    outcome = await spawn(a);
  } catch (err) {
    // Scheduling progress above stays committed; lifecycle is untouched by
    // dispatch failures (recurring tasks retry at the advanced slot).
    settleRun(a.id, run, "failed", String(err), { setLastError: true });
    return;
  }
  // The turn can run for a long time: settle asynchronously, never block the tick.
  const automationId = a.id;
  attachRunSession(automationId, run.runId, outcome);
  void outcome.sendPrompt().then(
    () => settleRun(automationId, run, "succeeded", undefined, { clearLastError: true }),
    (err: unknown) => settleRun(automationId, run, "failed", String(err), { setLastError: true }),
  );
}

/**
 * One scheduler pass: claim due automations (enabled + active + nextRunAt due),
 * record misfires, dispatch the rest. `now` and `spawn` are injectable for
 * smoke tests; production uses the wall clock and the real spawnSession path.
 */
export async function tickAutomations(opts?: TickOpts): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = opts?.now ?? Date.now();
    const spawn = opts?.spawn ?? defaultSpawn;
    const state = readAutomations();
    const due = state.automations.filter(
      (a) => a.enabled && a.lifecycle === "active" && typeof a.nextRunAt === "number" && a.nextRunAt <= now,
    );
    for (const claimed of due) {
      // Re-read per claim: dispatch awaits below interleave with run write-backs,
      // so a loop-held snapshot would clobber concurrent terminal updates.
      const fresh = readAutomations();
      const a = fresh.automations.find((x) => x.id === claimed.id);
      if (!a || !a.enabled || a.lifecycle !== "active") continue;
      const scheduledAt = a.nextRunAt;
      if (typeof scheduledAt !== "number" || scheduledAt > now) continue;
      if (scheduledAt <= now - MISFIRE_GRACE_MS) {
        handleMisfire(fresh, a, scheduledAt, now);
        continue;
      }
      await dispatchDue(fresh, a, scheduledAt, now, spawn);
    }
  } finally {
    ticking = false;
  }
}

/**
 * Manual dispatch (run_now RPC): ledger a manual run and spawn, but never touch
 * runCount/nextRunAt/lifecycle (ZCodium run_now parity). Resolves once the
 * session exists; the prompt turn settles asynchronously. Throws when the
 * automation is missing or disabled, and rethrows spawn failures after the run
 * is settled as failed.
 */
export async function runAutomationNow(id: string, spawn: SpawnFn = defaultSpawn): Promise<{ runId: string; sessionId?: string }> {
  const state = readAutomations();
  const a = state.automations.find((x) => x.id === id);
  if (!a) throw new Error(`automation not found: ${id}`);
  if (!a.enabled) throw new Error(`automation is disabled: ${id}`);
  const now = Date.now();
  const run: AutomationRun = {
    runId: `${id}:manual:${randomUUID()}`,
    automationId: id,
    trigger: "manual",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  pushRun(state, run);
  a.updatedAt = now;
  writeAutomations(state);
  notifyUi();
  let outcome: SpawnOutcome;
  try {
    outcome = await spawn(a);
  } catch (err) {
    settleRun(id, run, "failed", String(err), { setLastError: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
  attachRunSession(id, run.runId, outcome);
  void outcome.sendPrompt().then(
    () => settleRun(id, run, "succeeded", undefined, { clearLastError: true }),
    (err: unknown) => settleRun(id, run, "failed", String(err), { setLastError: true }),
  );
  return { runId: run.runId, sessionId: outcome.sessionId };
}

/**
 * Session-targeted dispatch: wake an existing session with the automation prompt
 * instead of spawning one. The target is resolved from the pool or reopened from
 * its transcript, so a delivery still lands after the user closed the session.
 */
async function deliverToSession(a: Automation): Promise<SpawnOutcome> {
  const target = a.deliverTo;
  if (!target) throw new Error(`automation has no delivery target: ${a.id}`);
  const { sessionId, entry } = await ensureSessionLoaded(target.sessionPath);
  notifyUi();
  return {
    sessionId,
    sessionPath: entry.path,
    sendPrompt: async () => {
      const automation = { id: a.id, title: a.title };
      // Durable marker first: the message entry the base writes below cannot carry it, so
      // an evicted-then-reopened session reads it back from this record.
      appendDeliveryMarker(entry.session.sessionManager, automation);
      entry.transcript.push({ role: "user", text: a.prompt, automation });
      // No composer sent this prompt: draw the same user bubble on every UI.
      const echo = JSON.stringify(stampEvent({ type: "event", sessionId, kind: "user_message", text: a.prompt, automation }));
      eachUiWs((w) => w.send(echo));
      const agentInvoked = await entry.session.prompt(a.prompt, { streamingBehavior: "followUp" });
      if (agentInvoked === false) throw new Error("prompt consumed locally, no agent turn started");
      // Settle on the turn, not on admission: a delivery queued behind a live turn
      // keeps the run "running" until the session works through it.
      await entry.session.waitForIdle();
      if (entry.session.getLastAssistantMessage()?.stopReason === "aborted") throw new Error("run aborted by the user");
    },
  };
}

/**
 * Production dispatch: a delivery wakes the automation's target session; every
 * other automation creates a pooled session on its cwd (+pinned model) through
 * the same spawnSession path the UI uses. Instead of the old sink websocket,
 * events ride a broadcast wrapper that forwards every frame to the currently
 * connected UI client (activeWs): the prompt bubble, streaming events and
 * session_created arrive in real time, no reload needed (the transcript still
 * persists on disk). The session is titled with the automation name via the
 * same SessionManager entry the rename_session RPC uses, so CLI-side listings
 * see it too. sendPrompt resolves when the prompt turn finishes; a
 * locally-consumed prompt (extension/custom command, no agent turn) is a
 * failure.
 */
const defaultSpawn: SpawnFn = async (a) => {
  if (a.deliverTo) return deliverToSession(a);
  const dialogTimeouts = readAutomationDialogTimeouts();
  // Broadcast to every connected UI (local + remote); null while none is
  // connected — frames drop.
  const uiWs = {
    send(data: string) {
      eachUiWs((w) => w.send(data));
    },
  };
  const targetModel = a.model ? H.scopedModels.find((m) => `${m.provider}/${m.id}` === a.model) : undefined;
  const { sessionId, entry } = await spawnSession(uiWs, a.cwd, targetModel, undefined, {
    automation: { id: a.id, title: a.title, computer: a.computer === true },
    // Unattended run: nobody is at the machine, so dialogs answer themselves at
    // the automation settings page's deadlines (read per dispatch).
    askTimeoutSec: dialogTimeouts.askSec,
    approvalTimeoutSec: dialogTimeouts.approvalSec,
  });
  try {
    if (await entry.manager.setSessionName(a.title, "user")) {
      entry.title = a.title;
    } else {
      safeStderr(`[automations] session naming rejected ${sessionId.slice(0, 8)}: ${a.title}\n`);
    }
  } catch (err) {
    // Naming is cosmetic: never fail the dispatch over it.
    safeStderr(`[automations] session naming failed ${sessionId.slice(0, 8)}: ${err}\n`);
  }
  // The sidebar row (carrying the automation marker) appears without waiting
  // for the run to settle; the settle notification pushes another one.
  notifyUi();
  return {
    sessionId,
    sessionPath: entry.path,
    sendPrompt: async () => {
      // No local composer send exists for automation sessions: echo the prompt
      // as a live user-message event so the UI draws the bubble in real time.
      uiWs.send(
        JSON.stringify(
          stampEvent({ type: "event", sessionId, kind: "user_message", text: a.prompt, automation: { id: a.id, title: a.title } }),
        ),
      );
      const agentInvoked = await entry.session.prompt(a.prompt, { streamingBehavior: "followUp" });
      if (agentInvoked === false) throw new Error("prompt consumed locally, no agent turn started");
    },
  };
};
