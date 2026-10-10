// Automations scheduling math: cron expression validation/next-run via croner
// (same library and version line as ZCodium) plus the structured ScheduleRule
// local-calendar algorithm ported from ZCodium
// packages/services/src/session/automationCron.ts (yearly and
// monthlyMode:"weekday" trimmed — omp-desktop v1 only exposes
// minute/hourly/daily/weekly/monthly builder units plus raw cron).
// All computation uses local calendar time, matching croner's default timezone.
import { Cron } from "croner";
import type { Automation, AutomationScheduleInput, ScheduleRule } from "./types.ts";

/** Validate a 5-field cron expression by constructing a croner job (ZCodium automationCronValidation parity). */
export function isValidCronExpr(expr: string): boolean {
  try {
    new Cron(expr);
    return true;
  } catch {
    return false;
  }
}

/** Next cron trigger strictly after `from` (epoch ms), or null when the expression never fires / is invalid. */
export function computeCronNextRunAt(expr: string, from?: number): number | null {
  try {
    const next = new Cron(expr).nextRun(new Date(from ?? Date.now()));
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

/** Local-midnight-anchored Date at hour:minute for the given calendar date. */
function atTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

/**
 * Next occurrence of a structured schedule rule strictly after `from` (epoch ms),
 * or null when nothing fires within the search horizon. Phases derive from
 * rule.anchorAt (creation/edit time) so late dispatches never accumulate drift.
 * Ported from ZCodium computeScheduleRuleNextRunAt; only strictly-advancing
 * results are ever returned (candidate > from).
 */
export function computeScheduleRuleNextRunAt(rule: ScheduleRule, from?: number): number | null {
  const interval = Math.max(1, Math.floor(rule.interval));
  const anchor = new Date(rule.anchorAt);
  const now = from ?? Date.now();

  if (rule.unit === "minute") {
    // Minute intervals start from the creation moment and always derive from the
    // fixed anchor (not */N cron wall-clock snapping), so a late scheduler tick
    // cannot cause per-round drift.
    const step = interval * 60 * 1_000;
    const steps = Math.max(1, Math.floor((now - rule.anchorAt) / step) + 1);
    return rule.anchorAt + steps * step;
  }

  if (rule.unit === "hourly") {
    // Every interval-th hour counting from the anchor hour, at rule.minute of
    // that hour (buildScheduleRule stores the anchor minute, keeping the phase).
    const base = new Date(anchor);
    base.setMinutes(rule.minute, 0, 0);
    const step = interval * 60 * 60 * 1_000;
    const steps = Math.max(0, Math.floor((now - base.getTime()) / step) + 1);
    return base.getTime() + steps * step;
  }

  if (rule.unit === "daily") {
    // Calendar days counted from the anchor date; ~100-year search horizon.
    for (let index = 0; index < 36_600; index += 1) {
      const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + index * interval);
      const candidate = atTime(date, rule.hour, rule.minute).getTime();
      if (candidate > now) return candidate;
    }
    return null;
  }

  if (rule.unit === "weekly") {
    // Anchor week snapped to its Monday (weekdays are 1=Mon..7=Sun), then every
    // interval-th week, candidates sorted by weekday within each week.
    const anchorWeek = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7));
    const weekdays = [...(rule.weekdays?.length ? rule.weekdays : [1])].sort((a, b) => a - b);
    for (let week = 0; week < 5_220; week += interval) {
      for (const weekday of weekdays) {
        const dayOffset = (weekday + 6) % 7;
        const date = new Date(
          anchorWeek.getFullYear(),
          anchorWeek.getMonth(),
          anchorWeek.getDate() + week * 7 + dayOffset,
        );
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > now) return candidate;
      }
    }
    return null;
  }

  if (rule.unit === "monthly") {
    // Calendar months counted from the anchor month; monthDays are filtered by
    // the overflow guard (Feb 31 rolls into March and is dropped). Inclusive
    // upper bound so a candidate late in the current month still resolves.
    for (let offset = 0; offset <= 1_200; offset += interval) {
      const month = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
      const days = [...(rule.monthDays?.length ? rule.monthDays : [1])].sort((a, b) => a - b);
      for (const day of days) {
        const date = new Date(month.getFullYear(), month.getMonth(), day);
        if (date.getMonth() !== month.getMonth()) continue; // invalid date (e.g. Feb 31): skip
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > now) return candidate;
      }
    }
    return null;
  }

  // Unknown unit (should be unreachable past buildScheduleRule validation).
  return null;
}

/**
 * Normalize builder-form schedule input into a persisted ScheduleRule.
 * Defaults: hour/minute 9:00, weekdays [1] (Monday), monthDays [1]; interval
 * must be an integer 1..200. Throws Error on out-of-range values so the RPC
 * layer can surface them to the editor verbatim.
 */
export function buildScheduleRule(
  input: Extract<AutomationScheduleInput, { kind: "rule" }>,
  anchorAt: number = Date.now(),
): ScheduleRule {
  const units: ScheduleRule["unit"][] = ["minute", "hourly", "daily", "weekly", "monthly"];
  if (!units.includes(input.unit)) throw new Error(`invalid schedule unit: ${String(input.unit)}`);
  const interval = input.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 200) {
    throw new Error("schedule interval must be an integer between 1 and 200");
  }
  const anchor = new Date(anchorAt);

  // minute/hourly carry no time-of-day: minute is fully anchor-derived, hourly
  // keeps only the anchor minute (types.ts contract).
  if (input.unit === "minute") {
    return { unit: "minute", interval, hour: 0, minute: 0, anchorAt };
  }
  if (input.unit === "hourly") {
    return { unit: "hourly", interval, hour: 0, minute: anchor.getMinutes(), anchorAt };
  }

  const hour = input.hour ?? 9;
  const minute = input.minute ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("schedule hour must be an integer between 0 and 23");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("schedule minute must be an integer between 0 and 59");

  if (input.unit === "daily") {
    return { unit: "daily", interval, hour, minute, anchorAt };
  }

  if (input.unit === "weekly") {
    const weekdays = input.weekdays ?? [1];
    if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error("weekdays must be non-empty integers between 1 (Monday) and 7 (Sunday)");
    }
    return { unit: "weekly", interval, hour, minute, anchorAt, weekdays: [...weekdays].sort((a, b) => a - b) };
  }

  const monthDays = input.monthDays ?? [1];
  if (!Array.isArray(monthDays) || monthDays.length === 0 || monthDays.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) {
    throw new Error("monthDays must be non-empty integers between 1 and 31");
  }
  return { unit: "monthly", interval, hour, minute, anchorAt, monthDays: [...monthDays].sort((a, b) => a - b) };
}

/**
 * Normalize a wire schedule input: builder form becomes a ScheduleRule anchored
 * at `anchorAt`; raw cron is validated and stored trimmed. Throws Error on
 * invalid cron expressions or an unknown kind.
 */
export async function normalizeScheduleInput(
  input: AutomationScheduleInput,
  anchorAt?: number,
): Promise<{ cronExpr?: string; scheduleRule?: ScheduleRule }> {
  if (input.kind === "rule") {
    return { scheduleRule: buildScheduleRule(input, anchorAt ?? Date.now()) };
  }
  if (input.kind === "cron") {
    const expr = input.cronExpr.trim();
    if (!isValidCronExpr(expr)) throw new Error(`invalid cron expression: ${expr}`);
    return { cronExpr: expr };
  }
  throw new Error('schedule.kind must be "rule" or "cron"');
}

/** Next trigger of an automation under either schedule source; scheduleRule wins over cronExpr. */
export function computeAutomationNextRunAt(
  a: Pick<Automation, "cronExpr" | "scheduleRule">,
  from?: number,
): number | null {
  if (a.scheduleRule) return computeScheduleRuleNextRunAt(a.scheduleRule, from);
  if (a.cronExpr) return computeCronNextRunAt(a.cronExpr, from);
  return null;
}

/** True when the automation is a single-shot: not recurring with an effective maxRuns of 1. */
export function isOneShot(a: Pick<Automation, "recurring" | "maxRuns">): boolean {
  return !a.recurring && (a.maxRuns ?? 1) <= 1;
}
