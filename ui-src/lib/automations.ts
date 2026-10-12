// Automations domain (UI side): type mirror of host/automations/types.ts plus
// pure display helpers (schedule summary strings, local time formatting).
// The shapes here MUST stay field-compatible with the host contract — the wire
// frames (automations_list / automation_run_started / automation_preview) are
// built from those types on the host side.
import type { TFunction } from "i18next";

/** Repetition unit of a structured schedule rule (mirror of host AutomationUnit). */
export type AutomationUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly";

/** Structured schedule rule (mirror of host ScheduleRule). */
export interface ScheduleRule {
  unit: AutomationUnit;
  /** Repeat every N units (1-200). */
  interval: number;
  /** Time of day for daily/weekly/monthly; 0 for minute, anchor minute for hourly. */
  hour: number;
  minute: number;
  /** Creation-time epoch ms; phase anchor for minute/hourly intervals. */
  anchorAt: number;
  /** weekly: ISO-like weekdays, Monday=1 .. Sunday=7. */
  weekdays?: number[];
  /** monthly: days of month 1-31; invalid dates (Feb 31) are skipped. */
  monthDays?: number[];
}

export type AutomationLifecycle = "active" | "completed" | "failed";

/** One scheduled-task definition plus its scheduling state (mirror of host Automation). */
export interface Automation {
  id: string;
  title: string;
  prompt: string;
  /** Advanced mode: raw 5-field cron (local timezone); scheduling source when scheduleRule is absent. */
  cronExpr?: string;
  /** Builder mode: authoritative schedule source; mutually exclusive with cronExpr. */
  scheduleRule?: ScheduleRule;
  cwd: string;
  /** "provider/id"; absent = follow the host default model. */
  model?: string;
  recurring: boolean;
  maxRuns?: number;
  endAt?: number;
  runCount: number;
  enabled: boolean;
  lifecycle: AutomationLifecycle;
  nextRunAt?: number;
  lastRunAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "skipped";
export type AutomationTrigger = "schedule" | "manual";

/** One trigger of an automation (mirror of host AutomationRun). */
export interface AutomationRun {
  runId: string;
  automationId: string;
  scheduledAt?: number;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  sessionId?: string;
  sessionPath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** Wire shape submitted by the UI editor for a schedule (create/update/preview). */
export type AutomationScheduleInput =
  | {
      kind: "rule";
      unit: AutomationUnit;
      interval: number;
      hour?: number;
      minute?: number;
      weekdays?: number[];
      monthDays?: number[];
    }
  | { kind: "cron"; cronExpr: string };

/** Translator signature accepted by the describe helpers (react-i18next's t). */
type TFn = TFunction;

/** Two-digit zero pad. */
function p2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "09:30" style local clock label for a rule's hour/minute fields. */
export function formatHM(hour: number, minute: number): string {
  return `${p2(hour)}:${p2(minute)}`;
}

/** Local wall-clock string for an epoch-ms timestamp (Intl, user's locale/timezone). */
export function formatLocalTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

/** Local-timezone end-of-day epoch ms for a yyyy-mm-dd date input value. */
export function endDateToMs(dateStr: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const ms = new Date(`${dateStr}T23:59:59`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** yyyy-mm-dd value for <input type="date"> from an epoch-ms deadline. */
export function msToEndDate(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Loose local validation for the advanced cron input: exactly five non-empty fields
 *  over the standard cron charset. The host (croner) is the authority. */
export function isPlausibleCronExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^[0-9*/,-]+$/.test(part) && !/[,-]{2,}/.test(part));
}

/** Structured summary of a builder schedule, e.g. "every 2 weeks on Mon, Wed at 09:30".
 *  Assembled from settingsPage.automations.* keys. */
export function describeSchedule(rule: ScheduleRule, t: TFn): string {
  const time = formatHM(rule.hour, rule.minute);
  const sep = t("settingsPage.automations.listSep") as string;
  switch (rule.unit) {
    case "minute":
      return t("settingsPage.automations.descMinute", { interval: rule.interval });
    case "hourly":
      return t("settingsPage.automations.descHourly", { interval: rule.interval, minute: p2(rule.minute) });
    case "daily":
      // interval 1 reads naturally as "Every day", not "Every 1 day"
      return rule.interval === 1
        ? t("settingsPage.automations.descDailyOne", { time })
        : t("settingsPage.automations.descDaily", { interval: rule.interval, time });
    case "weekly": {
      const names = (rule.weekdays ?? [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => t(`settingsPage.automations.weekday${d}`))
        .join(sep);
      return t("settingsPage.automations.descWeekly", { interval: rule.interval, days: names, time });
    }
    case "monthly": {
      const days = (rule.monthDays ?? [])
        .slice()
        .sort((a, b) => a - b)
        .join(sep);
      return t("settingsPage.automations.descMonthly", { interval: rule.interval, days, time });
    }
  }
}

/** Advanced-cron schedules show the raw expression (semantics are carried by the
 *  next-run preview; no natural-language cron parsing is ported). */
export function describeCronExpr(expr: string): string {
  return expr;
}

/** Row summary for an automation: dispatches on the scheduling source. */
export function describeAutomation(a: Automation, t: TFn): string {
  if (a.scheduleRule) return describeSchedule(a.scheduleRule, t);
  if (a.cronExpr) return describeCronExpr(a.cronExpr);
  return t("settingsPage.automations.descNone");
}
