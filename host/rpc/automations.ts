// Automations domain RPC: list/create/update/delete/toggle/run-now/preview for
// the scheduled-task system. The wire protocol here is a fixed contract (the
// frontend is developed against it verbatim): every mutating handler replies
// with a fresh automations_list frame built from an authoritative store
// re-read, so the UI state always reconciles against what actually persisted.
import {
  type Automation,
  type AutomationsFile,
  type AutomationUpdateInput,
  type AutomationUpsertInput,
} from "../automations/types.ts";
import { computeAutomationNextRunAt } from "../automations/cron.ts";
import { createAutomation, optCount, optSeconds, reqString, resolveSchedule } from "../automations/create.ts";
import { readAutomations, writeAutomations } from "../automations/store.ts";
import { runAutomationNow } from "../automations/scheduler.ts";
import { hostI18n } from "../i18n/host.ts";
import type { RpcHandler } from "./types";

/** Manual-dispatch result reported back to the UI (runId correlates with the runs history). */
interface ManualRunOutcome {
  runId: string;
  sessionId?: string;
}

/** Look up one automation by id or throw notFound. */
function requireAutomation(id: string): { state: AutomationsFile; automation: Automation } {
  const state = readAutomations();
  const automation = state.automations.find((a) => a.id === id);
  if (!automation) throw new Error(hostI18n.t("errors.automations.notFound", { id }));
  return { state, automation };
}

/** Push a fresh automations_list frame built from the persisted state. */
function replyList(ws: { send: (data: string) => void }): void {
  const state = readAutomations();
  ws.send(JSON.stringify({ type: "automations_list", automations: state.automations, runs: state.runs }));
}

export const automationsHandlers: Record<string, RpcHandler> = {
  automations_list(ws) {
    replyList(ws);
  },

  async automations_create(ws, msg) {
    // Delivery mode is agent-only (the tool passes it): the wire create RPC always
    // creates new-session automations, so a payload cannot redirect runs into a
    // conversation the user did not hand over.
    const input = { ...(msg?.automation ?? {}) } as Partial<AutomationUpsertInput>;
    delete input.deliverTo;
    await createAutomation(input);
    replyList(ws);
  },

  async automations_update(ws, msg) {
    const id = String(msg?.id ?? "");
    const { state, automation: a } = requireAutomation(id);
    // Session-delivery automations are agent-owned and immutable: re-aiming the
    // schedule here would resurrect a completed one whose target may be archived
    // or deleted, and the delivery mode itself is never editable.
    if (a.deliverTo) throw new Error(hostI18n.t("errors.automations.deliveryUpdateUnsupported"));
    const patch = (msg ?? {}) as AutomationUpdateInput;
    // Required-text fields: same non-empty rule as create, applied only when present.
    const title = reqString(patch.title);
    if (patch.title !== undefined && !title) throw new Error(hostI18n.t("errors.automations.fieldRequired"));
    if (title) a.title = title;
    const prompt = reqString(patch.prompt);
    if (patch.prompt !== undefined && !prompt) throw new Error(hostI18n.t("errors.automations.fieldRequired"));
    if (prompt) a.prompt = prompt;
    const cwd = reqString(patch.cwd);
    if (patch.cwd !== undefined && !cwd) throw new Error(hostI18n.t("errors.automations.fieldRequired"));
    if (cwd) a.cwd = cwd;
    // Optional fields: present-but-null (or junk) clears; a valid value overwrites.
    if (patch.model !== undefined) {
      const model = typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : undefined;
      if (model) a.model = model;
      else delete a.model;
    }
    if (patch.computer !== undefined) {
      if (patch.computer === true) a.computer = true;
      else delete a.computer;
    }
    if (patch.maxRuns !== undefined) {
      const maxRuns = optCount(patch.maxRuns);
      if (maxRuns !== undefined) a.maxRuns = maxRuns;
      else delete a.maxRuns;
    }
    // Dialog deadlines: a number >= 0 is stored; null/junk resets to the default
    // (absent field), never to an accidental 0 = wait forever.
    for (const key of ["askTimeoutSec", "approvalTimeoutSec"] as const) {
      const secs = optSeconds(patch[key]);
      if (secs !== undefined) a[key] = secs;
      else if (patch[key] !== undefined) delete a[key];
    }
    if (patch.endAt !== undefined) {
      if (typeof patch.endAt === "number" && Number.isFinite(patch.endAt)) a.endAt = patch.endAt;
      else delete a.endAt;
    }
    if (patch.recurring !== undefined) a.recurring = patch.recurring === true;
    // Schedule change swaps the scheduling source; the two sources are mutually exclusive.
    let scheduleChanged = false;
    if (patch.schedule !== undefined) {
      const schedule = await resolveSchedule(patch.schedule);
      delete a.cronExpr;
      delete a.scheduleRule;
      if (schedule.cronExpr !== undefined) a.cronExpr = schedule.cronExpr;
      if (schedule.scheduleRule !== undefined) a.scheduleRule = schedule.scheduleRule;
      scheduleChanged = true;
    }
    // Recurrence-shape changes re-aim the schedule from now; a completed task
    // edited back into a runnable state reactivates.
    const shapeChanged = scheduleChanged || patch.recurring !== undefined || patch.maxRuns !== undefined || patch.endAt !== undefined;
    if (shapeChanged) {
      const next = computeAutomationNextRunAt(a, Date.now());
      if (next !== null) {
        a.nextRunAt = next;
        if (a.lifecycle === "completed") a.lifecycle = "active";
      } else {
        delete a.nextRunAt;
        a.lifecycle = "completed";
      }
    }
    a.updatedAt = Date.now();
    writeAutomations(state);
    replyList(ws);
  },

  automations_delete(ws, msg) {
    const id = String(msg?.id ?? "");
    const { state } = requireAutomation(id);
    state.automations = state.automations.filter((a) => a.id !== id);
    delete state.runs[id];
    writeAutomations(state);
    replyList(ws);
  },

  automations_toggle(ws, msg) {
    const id = String(msg?.id ?? "");
    const { state, automation: a } = requireAutomation(id);
    // Master switch only: lifecycle and runCount are intentionally untouched
    // (a stale nextRunAt after re-enabling is handled by tick's misfire grace).
    a.enabled = msg?.enabled === true;
    a.updatedAt = Date.now();
    writeAutomations(state);
    replyList(ws);
  },

  async automations_run_now(ws, msg) {
    const id = String(msg?.id ?? "");
    const { automation: a } = requireAutomation(id);
    if (!a.enabled) throw new Error(hostI18n.t("errors.automations.disabled", { title: a.title }));
    // Scheduler owns the ledger write and dispatch; resolving the promise means
    // the session was created (the prompt turn itself keeps running async).
    const started = (await runAutomationNow(id)) as ManualRunOutcome;
    ws.send(JSON.stringify({ type: "automation_run_started", runId: started.runId, sessionId: started.sessionId }));
  },

  async automations_preview(ws, msg) {
    const schedule = await resolveSchedule(msg?.schedule);
    const from = typeof msg?.from === "number" && Number.isFinite(msg.from) ? msg.from : Date.now();
    // Walk the schedule forward three times from the cursor; stop early when
    // the source has no further triggers (empty array means "never fires").
    const probe: Pick<Automation, "cronExpr" | "scheduleRule"> = { cronExpr: schedule.cronExpr, scheduleRule: schedule.scheduleRule };
    const nextRunsAt: number[] = [];
    let cursor = from;
    for (let i = 0; i < 3; i++) {
      const next = computeAutomationNextRunAt(probe, cursor);
      if (next === null) break;
      nextRunsAt.push(next);
      cursor = next;
    }
    ws.send(JSON.stringify({ type: "automation_preview", nextRunsAt }));
  },
};
