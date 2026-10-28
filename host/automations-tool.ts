// Agent-facing automation tools (this app's Automations feature): two entries
// instead of one-per-verb — `automations_list` (read approval) and
// `automations_manage` (write approval, action: create | delete). The split is
// by approval level: listing must never ask for write confirmation.
//
// Creation reuses the automations domain entry (host/automations/create.ts)
// that the UI's create RPC calls, so validation, the 20-task limit, id minting
// and the born-completed rule stay one implementation. Only the model-facing
// shape is translated here: flat schedule fields instead of the nested
// AutomationScheduleInput union, plus "HH:MM" instead of hour/minute pairs.
// `deliverToSession: true` aims the run at the calling conversation instead of
// a fresh session; that mode is agent-only (the UI editor can neither create
// nor convert one) and must carry a run cap so it cannot self-wake forever.
// After a mutation the automations_list frame is pushed to the connected UI,
// the same reconciliation the RPC reply performs.
import fs from "node:fs";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { createAutomation } from "./automations/create.ts";
import { readAutomations, writeAutomations } from "./automations/store.ts";
import type { Automation, AutomationScheduleInput, AutomationUnit } from "./automations/types.ts";
import { eachUiWs } from "./state.ts";

/** Runs a session delivery may wake the conversation for by default. */
const DELIVERY_DEFAULT_MAX_RUNS = 10;
/** Hard cap on a session delivery's run count (self-wake cost guard). */
const DELIVERY_MAX_RUNS_LIMIT = 100;

const LIST_DESCRIPTION = `List this app's automations (scheduled tasks) with their schedule, next run, run count and delivery target.

Use it before creating or deleting anything: creation is limited to 20 automations and the user manages the same records in the Automations view.`;

const MANAGE_DESCRIPTION = `Create or delete an automation (this app's Automations feature).

An automation runs \`prompt\` on a timer. Two delivery modes:
- default (new session): every run starts its own session in \`cwd\`; that session has no memory of this conversation, so the prompt must be self-contained.
- session (deliverToSession: true): every run wakes THIS conversation by posting the prompt as a user message. Only use it when the user asks to be reminded or nudged in this same conversation. It requires a bounded run count (maxRuns, default ${DELIVERY_DEFAULT_MAX_RUNS}, at most ${DELIVERY_MAX_RUNS_LIMIT}) because each run costs a full turn of this context.

SCHEDULE
- \`every\`: the repeat unit — "minute", "hourly", "daily", "weekly" or "monthly". Defaults to "daily".
- \`at\`: local time of day as "HH:MM" (24h). daily/weekly/monthly only; defaults to 09:00. Ignored for minute/hourly, which anchor to the creation time.
- \`interval\`: run once every N units, 1-200 (default 1). "every: hourly, interval: 3" = every 3 hours.
- \`weekdays\`: weekly only — ISO weekdays, 1 = Monday .. 7 = Sunday (default [1]).
- \`monthDays\`: monthly only — days of month 1-31 (default [1]); invalid dates (Feb 31) are skipped.
- \`cron\`: optional raw 5-field cron in local time; when set it replaces every/at/interval/weekdays/monthDays.
- \`recurring\`: defaults to true (repeat forever). Ignored for session deliveries, which are always bounded by maxRuns.
- \`maxRuns\`: total runs before the automation completes. \`recurring: false\` with maxRuns = N runs N times then completes.
- \`computer\`: let each run drive the computer (screenshots, input, accessibility). Off by default: only set it when the user asks the task to operate the desktop, and note the global computer-control master switch must be on.

EXAMPLES
- Every weekday at 09:30 in a fresh session: { action: "create", title: "Weekday standup brief", prompt: "…", every: "weekly", at: "09:30", weekdays: [1,2,3,4,5] }
- Remind me in this conversation in 30 minutes, five times: { action: "create", title: "Check the build", prompt: "…", every: "minute", interval: 30, deliverToSession: true, maxRuns: 5 }
- Delete: { action: "delete", id: "automation-…" }

There is no update action: to change an automation, delete it and create a new one. At most 20 automations can exist.`;

const listParams = type({});

const manageParams = type({
  action: type("'create'|'delete'").describe("create a new automation, or delete one by id."),
  "id?": type("string").describe('delete: automation id, as reported by automations_list.'),
  "title?": type("string").describe('create: short label, e.g. "Weekday standup brief".'),
  "prompt?": type("string").describe("create: instruction sent on every run."),
  "every?": type("'minute'|'hourly'|'daily'|'weekly'|'monthly'").describe("create: repeat unit (default: daily)."),
  "at?": type("string").describe('create: time of day as "HH:MM" in local time (daily/weekly/monthly, default 09:00).'),
  "interval?": type("number").describe("create: run once every N units, 1-200 (default 1)."),
  "weekdays?": type.array(type("number")).describe("create, weekly only: 1 = Monday .. 7 = Sunday (default [1])."),
  "monthDays?": type.array(type("number")).describe("create, monthly only: days of month 1-31 (default [1])."),
  "cron?": type("string").describe("create: raw 5-field cron in local time; replaces the unit fields above when set."),
  "recurring?": type("boolean").describe("create: repeat forever (default true). Ignored for session deliveries."),
  "maxRuns?": type("number").describe("create: total runs before it completes."),
  "cwd?": type("string").describe("create: working directory for the run session (defaults to this session's cwd)."),
  "deliverToSession?": type("boolean").describe(
    `create: deliver into this conversation instead of a fresh session (requires maxRuns, at most ${DELIVERY_MAX_RUNS_LIMIT}).`,
  ),
  "computer?": type("boolean").describe(
    "create: let every run drive this computer (screenshots, input, accessibility). Default false — an unattended run never gets desktop control unless asked for. Ignored while the global computer-control master switch is off.",
  ),
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

/** Subagent refusal text shared by both tools (see transcriptLooksLikeSubagent). */
const SUBAGENT_REFUSAL = {
  content: [
    {
      type: "text" as const,
      text: "Only the main session can manage automations. Tell the user what should be automated and let them ask you at the top level.",
    },
  ],
  isError: true,
};

/** Tool execute context fields this file reads (the base passes a wider object). */
interface ToolCtx {
  taskDepth?: number;
}

/**
 * Session facts the tools need, injected by the host at creation.
 *
 * Why not read them off the execute context: `write` to `xd://<tool>` dispatches
 * with the device's `AgentToolContext` (addAdditionalContext only), not the base's
 * ToolSession — so `ctx.getSessionFile()` is undefined there and every live
 * session looked transcript-less. The host owns the manager and knows the file.
 */
export interface AutomationToolSession {
  /** Transcript path of the session owning these tools; null for a session with no file. */
  sessionFile: () => string | null;
  /** Cross the base's lazy-persistence gate so the bound path is a real file. */
  ensureOnDisk: () => Promise<void>;
}

function isSubagentCall(ctx: ToolCtx | undefined, session: AutomationToolSession): boolean {
  return (ctx?.taskDepth ?? 0) > 0 || transcriptLooksLikeSubagent(session.sessionFile());
}

/** One line per automation: enough for the model to pick an id without dumping the store. */
function describeAutomation(a: Automation): string {
  const schedule = a.cronExpr ?? (a.scheduleRule ? `${a.scheduleRule.unit} x${a.scheduleRule.interval}` : "no schedule");
  const next = a.nextRunAt ? new Date(a.nextRunAt).toLocaleString() : "none";
  const target = a.deliverTo ? `this-session` : "new-session";
  const cap = a.recurring ? "∞" : String(a.maxRuns ?? 1);
  return `- ${a.id} | ${a.title} | ${schedule} | next=${next} | runs=${a.runCount}/${cap} | ${a.lifecycle}${a.enabled ? "" : " (disabled)"} | ${target}${a.computer ? " | computer" : ""}`;
}

/** Same reconciliation the create RPC reply performs: the sidebar refreshes without a reload. */
function pushList(): void {
  const state = readAutomations();
  const data = JSON.stringify({ type: "automations_list", automations: state.automations, runs: state.runs });
  eachUiWs((ws) => ws.send(data));
}

/** Build the automation tools for one session (they carry its cwd default). */
export function createAutomationTools(sessionCwd: string, session: AutomationToolSession) {
  const list = {
    name: "automations_list",
    label: "List Automations",
    description: LIST_DESCRIPTION,
    parameters: listParams,
    approval: "read" as const,
    execute: async (_id: string, _params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, ctx?: ToolCtx) => {
      if (isSubagentCall(ctx, session)) return SUBAGENT_REFUSAL;
      const { automations } = readAutomations();
      if (automations.length === 0) return { content: [{ type: "text" as const, text: "No automations exist." }] };
      return {
        content: [{ type: "text" as const, text: `${automations.length} automation(s):\n${automations.map(describeAutomation).join("\n")}` }],
      };
    },
  };

  const manage = {
    name: "automations_manage",
    label: "Manage Automations",
    description: MANAGE_DESCRIPTION,
    parameters: manageParams,
    approval: "write" as const,
    execute: async (_id: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, ctx?: ToolCtx) => {
      // Subagents must not schedule follow-up work on the user's behalf. The tools are
      // already withheld from reloaded subagent sessions (host/session-lifecycle.ts),
      // but live task-spawned subagents inherit the parent's custom tools, so the
      // entry refuses on both signals: the base's taskDepth counter (authoritative
      // when present) and the on-disk transcript shape.
      if (isSubagentCall(ctx, session)) return SUBAGENT_REFUSAL;
      try {
        if (params.action === "delete") {
          const id = String(params.id ?? "").trim();
          if (!id) throw new Error('"id" is required for action: "delete"');
          const state = readAutomations();
          const target = state.automations.find((a) => a.id === id);
          if (!target) throw new Error(`automation not found: ${id}`);
          state.automations = state.automations.filter((a) => a.id !== id);
          delete state.runs[id];
          writeAutomations(state);
          pushList();
          return { content: [{ type: "text" as const, text: `Deleted automation "${target.title}" (${id}).` }] };
        }
        if (params.action !== "create") throw new Error('"action" must be "create" or "delete"');
        const deliverToSession = params.deliverToSession === true;
        let sessionFile = session.sessionFile();
        if (deliverToSession) {
          if (!sessionFile)
            throw new Error("this session has no transcript file, so it cannot be a delivery target; send a message and retry");
          // Base persistence is lazy: the manager hands out the allocated path
          // before the JSONL exists (first assistant message, or this gate). The
          // scheduler reopens the bound path on every run, so the file must be
          // real at bind time — otherwise the automation can never fire.
          await session.ensureOnDisk();
          sessionFile = session.sessionFile() ?? sessionFile;
          if (!fs.existsSync(sessionFile))
            throw new Error("this session's transcript is not on disk yet, so it cannot be a delivery target; send a message and retry");
        }
        const rawMaxRuns = typeof params.maxRuns === "number" ? Math.floor(params.maxRuns) : undefined;
        if (deliverToSession && rawMaxRuns !== undefined && rawMaxRuns > DELIVERY_MAX_RUNS_LIMIT)
          throw new Error(`maxRuns for a session delivery must be at most ${DELIVERY_MAX_RUNS_LIMIT}`);
        const automation = await createAutomation({
          title: String(params.title ?? ""),
          prompt: String(params.prompt ?? ""),
          cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : sessionCwd,
          schedule: scheduleFrom(params),
          // A delivery is always bounded: the cap is what keeps a self-wake loop finite.
          recurring: deliverToSession ? false : params.recurring !== false,
          maxRuns: deliverToSession ? (rawMaxRuns ?? DELIVERY_DEFAULT_MAX_RUNS) : rawMaxRuns,
          computer: params.computer === true,
          ...(deliverToSession && sessionFile ? { deliverTo: { sessionPath: sessionFile } } : {}),
        });
        pushList();
        const next = automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : "never";
        const where = deliverToSession ? "into this conversation" : "in a fresh session";
        return {
          content: [
            {
              type: "text" as const,
              text: `Created automation "${automation.title}" (id ${automation.id}), running ${where}. Next run: ${next}. Visible in the Automations view, where the user can pause or delete it.`,
            },
          ],
          // Structured, not just prose: the turn's action row reads this to offer the jump
          // to the new task's editor (details.xdev.inner through the xd:// dispatch).
          details: { automation: { id: automation.id, title: automation.title } },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Automation ${String(params.action)} failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };

  return [list, manage];
}
