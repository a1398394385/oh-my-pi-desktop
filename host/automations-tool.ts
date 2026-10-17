// create_automation tool: the agent-facing entry to the scheduled-task system.
//
// The tool reuses the automations domain entry (host/automations/create.ts) that
// the UI's create RPC calls, so validation, the 20-task limit, id minting and
// the born-completed rule stay one implementation. Only the model-facing shape
// is translated here: flat schedule fields instead of the nested
// AutomationScheduleInput union, plus "HH:MM" instead of hour/minute pairs.
// After a successful create the automations_list frame is pushed to the
// connected UI, the same reconciliation the RPC reply performs.
import fs from "node:fs";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { createAutomation } from "./automations/create.ts";
import { readAutomations } from "./automations/store.ts";
import type { AutomationScheduleInput, AutomationUnit } from "./automations/types.ts";
import { eachUiWs } from "./state.ts";

const CREATE_AUTOMATION_DESCRIPTION = `Create a scheduled task that runs a prompt in a fresh session on a timer (this app's Automations feature).

Each run starts its own session in the task's working directory, sends \`prompt\` to the agent, and the run history is visible in the Automations view — so the task must be self-contained: the future session has no memory of this conversation.

SCHEDULE
- \`every\`: the repeat unit — "minute", "hourly", "daily", "weekly" or "monthly". Defaults to "daily".
- \`at\`: local time of day as "HH:MM" (24h). daily/weekly/monthly only; defaults to 09:00. Ignored for minute/hourly, which anchor to the creation time.
- \`interval\`: run once every N units, 1-200 (default 1). "every: hourly, interval: 3" = every 3 hours.
- \`weekdays\`: weekly only — ISO weekdays, 1 = Monday .. 7 = Sunday (default [1]).
- \`monthDays\`: monthly only — days of month 1-31 (default [1]); invalid dates (Feb 31) are skipped.
- \`cron\`: optional raw 5-field cron in local time; when set it replaces every/at/interval/weekdays/monthDays.
- \`recurring\`: defaults to true (repeat forever). Pass false for a one-shot task — it runs once and completes.
- \`maxRuns\`: optional cap on total runs when recurring.

EXAMPLES
- Every weekday at 09:30: { title: "Weekday standup brief", prompt: "…", every: "weekly", at: "09:30", weekdays: [1,2,3,4,5], cwd: "/path/to/repo" }
- One-shot reminder: { title: "Check the deploy", prompt: "…", every: "daily", at: "18:00", recurring: false }
- Every 10 minutes: { title: "Poll CI", prompt: "…", every: "minute", interval: 10 }

Creation only: there is no update/delete here — the user manages existing tasks in the Automations view. At most 20 tasks can exist.`;

const createAutomationParams = type({
  title: type("string").describe('Short label for the task, e.g. "Weekday standup brief".'),
  prompt: type("string").describe(
    "Self-contained instruction sent to the agent on every run — the run session knows nothing about this conversation.",
  ),
  "every?": type("'minute'|'hourly'|'daily'|'weekly'|'monthly'").describe("Repeat unit (default: daily)."),
  "at?": type("string").describe('Time of day as "HH:MM" in local time (daily/weekly/monthly, default 09:00).'),
  "interval?": type("number").describe("Run once every N units, 1-200 (default 1)."),
  "weekdays?": type.array(type("number")).describe("weekly only: 1 = Monday .. 7 = Sunday (default [1])."),
  "monthDays?": type.array(type("number")).describe("monthly only: days of month 1-31 (default [1])."),
  "cron?": type("string").describe("Raw 5-field cron in local time; replaces the unit fields above when set."),
  "recurring?": type("boolean").describe("Repeat forever (default true). false creates a one-shot task."),
  "maxRuns?": type("number").describe("Optional cap on total runs when recurring."),
  "cwd?": type("string").describe("Working directory for the run session (defaults to this session's cwd)."),
});

/** "HH:MM" → { hour, minute }; anything else is a user-input error, not a default. */
function parseAt(at: unknown): { hour?: number; minute?: number } {
  if (at === undefined) return {};
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!match) throw new Error(`"at" must look like "09:30" (got ${JSON.stringify(at)})`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Flat tool params → the domain's wire schedule input (cron wins over the unit fields). */
function scheduleFrom(params: Record<string, unknown>): AutomationScheduleInput {
  const cron = typeof params.cron === "string" ? params.cron.trim() : "";
  if (cron) return { kind: "cron", cronExpr: cron };
  const { hour, minute } = parseAt(params.at);
  return {
    kind: "rule",
    unit: (params.every as AutomationUnit) ?? "daily",
    interval: typeof params.interval === "number" ? Math.floor(params.interval) : 1,
    ...(hour !== undefined ? { hour } : {}),
    ...(minute !== undefined ? { minute } : {}),
    ...(Array.isArray(params.weekdays) ? { weekdays: params.weekdays as number[] } : {}),
    ...(Array.isArray(params.monthDays) ? { monthDays: params.monthDays as number[] } : {}),
  };
}

/**
 * Second subagent gate, on the same rule the app uses to stamp
 * `entry.isSubagent` (host/session-lifecycle.ts): a subagent transcript lives
 * inside `<parent session file>.jsonl/`, so the parent file sitting next to the
 * session's own directory is the marker. Same rule as the rest of the app means
 * no session shape can be a subagent to one place and a main session here.
 */
function transcriptLooksLikeSubagent(sessionFile: string | null | undefined): boolean {
  if (!sessionFile) return false; // no transcript yet (fresh session): only the taskDepth gate can judge
  return fs.existsSync(`${path.dirname(sessionFile)}.jsonl`);
}

/** Build the create_automation tool (one instance per session: it carries the cwd default). */
export function createAutomationTool(sessionCwd: string) {
  return {
    name: "create_automation",
    label: "Create Scheduled Task",
    description: CREATE_AUTOMATION_DESCRIPTION,
    parameters: createAutomationParams,
    loadMode: "essential" as const,
    approval: "write" as const,
    execute: async (
      _id: string,
      params: Record<string, unknown>,
      _signal?: unknown,
      _onUpdate?: unknown,
      ctx?: { taskDepth?: number; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      // Subagents must not schedule follow-up work on the user's behalf. The tool is
      // already withheld from reloaded subagent sessions (host/session-lifecycle.ts),
      // but live task-spawned subagents inherit the parent's custom tools, so the
      // entry refuses on both signals: the base's taskDepth counter (authoritative
      // when present) and the on-disk transcript shape.
      const sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
      if ((ctx?.taskDepth ?? 0) > 0 || transcriptLooksLikeSubagent(sessionFile)) {
        return {
          content: [{ type: "text" as const, text: "Only the main session can create scheduled tasks. Tell the user what should be scheduled and let them ask you at the top level." }],
          isError: true,
        };
      }
      try {
        const automation = await createAutomation({
          title: String(params.title ?? ""),
          prompt: String(params.prompt ?? ""),
          cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : sessionCwd,
          schedule: scheduleFrom(params),
          recurring: params.recurring !== false,
          ...(typeof params.maxRuns === "number" ? { maxRuns: params.maxRuns } : {}),
        });
        // Same reconciliation the create RPC reply performs: the sidebar refreshes without a reload.
        const state = readAutomations();
        const data = JSON.stringify({ type: "automations_list", automations: state.automations, runs: state.runs });
        eachUiWs((ws) => ws.send(data));
        const next = automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : "never";
        return {
          content: [
            {
              type: "text" as const,
              text: `Created scheduled task "${automation.title}" (id ${automation.id}). Next run: ${next}. It is visible in the Automations view, where the user can edit, pause or delete it.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to create the scheduled task: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}
