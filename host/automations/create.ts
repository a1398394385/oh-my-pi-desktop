// Automation creation domain entry: validate an upsert payload, normalize its
// schedule, mint the record and persist it. Shared by the create RPC
// (host/rpc/automations.ts) and the automations_manage built-in tool
// (host/automations-tool.ts) so both enforce the same limits, defaults and
// born-completed rule; update/preview reuse resolveSchedule from here.
import { hostI18n } from "../i18n/host.ts";
import { computeAutomationNextRunAt, isOneShot, isValidCronExpr, normalizeScheduleInput } from "./cron.ts";
import { readAutomations, writeAutomations } from "./store.ts";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_DIALOG_TIMEOUT_SEC,
  newAutomationId,
  type Automation,
  type AutomationScheduleInput,
  type AutomationUpsertInput,
} from "./types.ts";

/** Trimmed non-empty string or "" (lets callers reject with fieldRequired). */
export function reqString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Positive finite number → floor, anything else → undefined (maxRuns cleared). */
export function optCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
}

/** Dialog deadline in seconds: 0 (wait forever) and up accepted, junk → undefined. */
export function optSeconds(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Normalize a wire schedule input into the persisted scheduling source.
 * Missing/unknown shapes throw scheduleRequired; raw cron that croner rejects
 * throws invalidCron (pre-validated here because the domain normalizer throws
 * a plain English message). Structured rules delegate to the domain layer,
 * which clamps interval bounds (1-200) and applies defaults (9:00, Mon, day 1).
 */
export async function resolveSchedule(raw: unknown): Promise<Pick<Automation, "cronExpr" | "scheduleRule">> {
  if (!raw || typeof raw !== "object") throw new Error(hostI18n.t("errors.automations.scheduleRequired"));
  const input = raw as AutomationScheduleInput;
  if (input.kind !== "rule" && input.kind !== "cron") throw new Error(hostI18n.t("errors.automations.scheduleRequired"));
  if (input.kind === "cron") {
    const expr = String(input.cronExpr ?? "").trim();
    if (!expr || !isValidCronExpr(expr)) throw new Error(hostI18n.t("errors.automations.invalidCron", { expr }));
  }
  return normalizeScheduleInput(input);
}

/**
 * Validate + persist one automation and return the stored record.
 * Every field follows the create RPC's contract: title/prompt/cwd non-empty,
 * one scheduling source, the create limit counted over all lifecycle states.
 */
export async function createAutomation(raw: Partial<AutomationUpsertInput>): Promise<Automation> {
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
  // A session delivery wakes a live conversation, so it must be bounded: the
  // agent cannot create an unbounded self-wake loop.
  const deliverTo = raw.deliverTo;
  if (deliverTo && (raw.recurring === true || maxRuns === undefined))
    throw new Error(hostI18n.t("errors.automations.deliveryNeedsCap"));
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
    // Dialog deadlines are stored explicitly so the record states what its runs
    // will wait for; absent fields on older records fall back at dispatch.
    askTimeoutSec: optSeconds(raw.askTimeoutSec) ?? AUTOMATION_DIALOG_TIMEOUT_SEC,
    approvalTimeoutSec: optSeconds(raw.approvalTimeoutSec) ?? AUTOMATION_DIALOG_TIMEOUT_SEC,
    ...(deliverTo ? { deliverTo } : {}),
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
  return automation;
}
