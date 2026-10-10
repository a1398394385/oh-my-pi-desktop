// Automations domain types: shared contract between the scheduler (host/automations),
// the RPC layer (host/rpc/automations.ts), the smoke script, and the UI (which mirrors
// these shapes in ui-src/lib/automations.ts). Modeled after ZCodium's automation-types,
// trimmed for omp-desktop: JSON persistence, single-process scheduler, new session per run.
import { randomUUID } from "node:crypto";

/** Max number of retained automation definitions, all lifecycle states counted (ZCodium parity). */
export const AUTOMATION_CREATE_LIMIT = 20;

/** Max runs kept in history per automation; oldest trimmed. */
export const RUNS_PER_AUTOMATION_KEEP = 10;

/** Repetition unit of a structured schedule rule. Yearly/monthly-weekday-mode not supported in v1. */
export type AutomationUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly";

/**
 * Structured schedule rule — the authoritative schedule source when present.
 * cronExpr (see Automation) is the alternative source for advanced raw-cron entries.
 * Exactly one of the two fields is set on any persisted automation.
 */
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

/** One scheduled-task definition plus its scheduling state. */
export interface Automation {
  /** `automation-${randomUUID()}` */
  id: string;
  title: string;
  prompt: string;
  /** Advanced mode: raw 5-field cron (local timezone). Scheduling source when scheduleRule is absent. */
  cronExpr?: string;
  /** Builder mode: authoritative schedule source. Mutually exclusive with cronExpr. */
  scheduleRule?: ScheduleRule;
  /** Working directory the spawned session runs in. */
  cwd: string;
  /** "provider/id"; absent = follow the host default model. */
  model?: string;
  /** true = repeat forever; false = bounded by maxRuns (default 1). */
  recurring: boolean;
  maxRuns?: number;
  /** Epoch ms deadline; once the next run would exceed it, the task completes. */
  endAt?: number;
  runCount: number;
  /** Master switch; off = paused (tick never claims). Independent of lifecycle. */
  enabled: boolean;
  lifecycle: AutomationLifecycle;
  nextRunAt?: number;
  lastRunAt?: number;
  /** Last dispatch/turn error; cleared on the next successful run. */
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "skipped";
export type AutomationTrigger = "schedule" | "manual";

/** One trigger of an automation: idempotent ledger entry + outcome record. */
export interface AutomationRun {
  /** `${automationId}:${scheduledAt}` for schedule runs, `${automationId}:manual:${uuid}` for manual. */
  runId: string;
  automationId: string;
  /** Theoretical trigger time embedded in the runId (schedule runs only). */
  scheduledAt?: number;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  /** Pooled session created for this run (spawn success). */
  sessionId?: string;
  /** On-disk session file path, when known at dispatch time. */
  sessionPath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** Persisted document layout of <agentDir>/automations.json. */
export interface AutomationsFile {
  automations: Automation[];
  runs: Record<string, AutomationRun[]>;
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

/** Create payload (all required fields present). */
export interface AutomationUpsertInput {
  title: string;
  prompt: string;
  cwd: string;
  /** undefined = follow default; string = pin "provider/id". */
  model?: string | null;
  recurring: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  schedule: AutomationScheduleInput;
}

/** Update payload: every field optional; null clears an optional field. */
export interface AutomationUpdateInput {
  title?: string;
  prompt?: string;
  cwd?: string;
  model?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  schedule?: AutomationScheduleInput;
}

/** Outcome of one dispatch: a pooled session plus a closer that runs the prompt turn. */
export interface SpawnOutcome {
  sessionId: string;
  sessionPath?: string;
  /** Sends the automation prompt and settles when the turn finishes (matches session.prompt semantics). */
  sendPrompt: () => Promise<void>;
}

/** Dispatch function injected for tests; production impl lives in scheduler.ts. */
export type SpawnFn = (automation: Automation) => Promise<SpawnOutcome>;

/** tickAutomations options: clock override and spawn injection for smoke tests. */
export interface TickOpts {
  now?: number;
  spawn?: SpawnFn;
}

/** Fresh definition factory used by the create RPC. */
export function newAutomationId(): string {
  return `automation-${randomUUID()}`;
}
