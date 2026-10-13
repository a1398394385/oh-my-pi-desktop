// Automations domain RPC: list/create/update/delete/toggle/run-now/preview for
// the scheduled-task system. The wire protocol here is a fixed contract (the
// frontend is developed against it verbatim): every mutating handler replies
// with a fresh automations_list frame built from an authoritative store
// re-read, so the UI state always reconciles against what actually persisted.
import {
  AUTOMATION_CREATE_LIMIT,
  newAutomationId,
  type Automation,
  type AutomationsFile,
  type AutomationScheduleInput,
  type AutomationUpdateInput,
  type AutomationUpsertInput,
} from "../automations/types.ts";
import { isValidCronExpr, isOneShot, normalizeScheduleInput, computeAutomationNextRunAt } from "../automations/cron.ts";
import { readAutomations, writeAutomations } from "../automations/store.ts";
import { runAutomationNow } from "../automations/scheduler.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

/** Normalized scheduling source ready to spread into an Automation record. */
type ResolvedSchedule = Pick<Automation, "cronExpr" | "scheduleRule">;

/** Manual-dispatch result reported back to the UI (runId correlates with the runs history). */
interface ManualRunOutcome {
  runId: string;
  sessionId?: string;
}

/**
 * Normalize a wire schedule input into the persisted scheduling source.
 * Missing/unknown shapes throw scheduleRequired; raw cron that croner rejects
 * throws invalidCron (pre-validated here because the domain normalizer throws
 * a plain English message). Structured rules delegate to the domain layer,
 * which clamps interval bounds (1-200) and applies defaults (9:00, Mon, day 1).
 */
async function resolveSchedule(raw: unknown): Promise<ResolvedSchedule> {
  if (!raw || typeof raw !== "object") throw new Error(hostI18n.t("errors.automations.scheduleRequired"));
  const input = raw as AutomationScheduleInput;
  if (input.kind !== "rule" && input.kind !== "cron") throw new Error(hostI18n.t("errors.automations.scheduleRequired"));
  if (input.kind === "cron") {
    const expr = String(input.cronExpr ?? "").trim();
    if (!expr || !isValidCronExpr(expr)) throw new Error(hostI18n.t("errors.automations.invalidCron", { expr }));
  }
  return normalizeScheduleInput(input);
}

/** Trimmed non-empty string or "" (lets callers reject with fieldRequired). */
function reqString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Positive finite number → floor, anything else → undefined (maxRuns cleared). */
function optCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
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
    const raw = (msg?.automation ?? {}) as Partial<AutomationUpsertInput>;
    const title = reqString(raw.title);
    const prompt = reqString(raw.prompt);
    const cwd = reqString(raw.cwd);
    if (!title || !prompt || !cwd) throw new Error(hostI18n.t("errors.automations.fieldRequired"));
    const schedule = await resolveSchedule(raw.schedule);
    const state = readAutomations();
    if (state.automations.length >= AUTOMATION_CREATE_LIMIT)
      throw new Error(hostI18n.t("errors.automations.limitReached", { limit: AUTOMATION_CREATE_LIMIT }));
    const now = Date.now();
    const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
    const maxRuns = optCount(raw.maxRuns);
    const endAt = typeof raw.endAt === "number" && Number.isFinite(raw.endAt) ? raw.endAt : undefined;
    const automation: Automation = {
      id: newAutomationId(),
      title,
      prompt,
      cwd,
      cronExpr: schedule.cronExpr,
      scheduleRule: schedule.scheduleRule,
      ...(model ? { model } : {}),
      ...(raw.computer === true ? { computer: true } : {}),
      recurring: raw.recurring === true,
      ...(maxRuns !== undefined ? { maxRuns } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
      runCount: 0,
      enabled: true,
      lifecycle: "active",
      createdAt: now,
      updatedAt: now,
    };
    // A one-shot whose schedule is already in the past is born completed.
    const next = computeAutomationNextRunAt(automation, now);
    if (next !== null) automation.nextRunAt = next;
    else if (isOneShot(automation)) automation.lifecycle = "completed";
    state.automations.push(automation);
    writeAutomations(state);
    replyList(ws);
  },

  async automations_update(ws, msg) {
    const id = String(msg?.id ?? "");
    const { state, automation: a } = requireAutomation(id);
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
