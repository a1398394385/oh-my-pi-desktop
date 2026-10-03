// Plan mode domain: /plan command dispatch, plan_mode state frames, and
// persisted mode_change restore. The proposal approval loop itself lives in
// ./plan-approve.ts (the five next-step options + the execution-model slider,
// ported from the base TUI's InteractiveMode approval flow).
import { hostI18n } from "../ui-src/i18n/host.ts";
import { installProposalHandler } from "./plan-approve.ts";
import { pushCommandOutput, type PoolEntry } from "./state.ts";

const PLAN_MODE_NAME = "plan";
const PLAN_FILE_URL = "local://PLAN.md"; // same location as the ACP default plan file

/** Plan-mode state frame: the UI shows/hides the "Plan" exit button right of the permission pill based on it. */
export function pushPlanMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const state = entry.session.getPlanModeState();
  ws.send(
    JSON.stringify({
      type: "plan_mode",
      sessionId,
      enabled: state?.enabled === true,
      planFilePath: state?.planFilePath ?? null,
    }),
  );
}

/**
 * Enter/exit plan mode. persist=false is for restoring from a persisted
 * mode_change (no double bookkeeping).
 * Once inside, the proposal handler owns the xd://propose approval loop —
 * without it installed, nobody receives the agent's proposals.
 */
export function setPlanMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  enabled: boolean,
  options?: { planFilePath?: string; persist?: boolean },
) {
  const persist = options?.persist !== false;
  if (enabled) {
    const previous = entry.session.getPlanModeState();
    const planFilePath = options?.planFilePath ?? previous?.planFilePath ?? PLAN_FILE_URL;
    entry.session.setPlanModeState({
      enabled: true,
      planFilePath,
      workflow: previous?.workflow ?? "parallel",
      reentry: previous !== undefined,
    });
    // The handler only validates the plan and returns a dumb tool result; the
    // approval card is raised out of band from tool_execution_end.
    installProposalHandler(ws, sessionId, entry);
    if (persist) entry.manager.appendModeChange?.(PLAN_MODE_NAME, { planFilePath });
  } else {
    entry.session.setPlanProposalHandler?.(null);
    entry.session.setPlanModeState(undefined);
    if (persist) entry.manager.appendModeChange?.("none");
  }
  pushPlanMode(ws, sessionId, entry);
}

/**
 * Dispatch /plan args (a trimmed version of the base TUI
 * handlePlanModeCommand: the desktop has no paused intermediate state; exit
 * clears state immediately). No args = toggle the current state; with a
 * prompt = enable and use the prompt as the first plan turn.
 * Returns the prompt (caller forwards it into the normal prompt path) or
 * null (consumed).
 */
export function handlePlanCommand(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  args: string,
): string | null {
  if (entry.session.getGoalModeState()) {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.goalModeBlocked"));
    return null;
  }
  if (!entry.session.settings.get("plan.enabled")) {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.notEnabled"));
    return null;
  }
  if (entry.session.getPlanModeState()?.enabled) {
    setPlanMode(ws, sessionId, entry, false);
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.exited"));
    return null;
  }
  setPlanMode(ws, sessionId, entry, true);
  const prompt = args.trim();
  if (prompt) return prompt;
  pushCommandOutput(sessionId, hostI18n.t("flows.plan.enabled", { file: PLAN_FILE_URL }));
  return null;
}

/** Restore plan mode from the last mode_change when a session reopens (desktop version of TUI #reconcileModeFromSession) */
export function reconcilePlanMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry, entries: any[]) {
  const last = [...entries].reverse().find((e) => e?.type === "mode_change");
  if (last?.mode !== PLAN_MODE_NAME) {
    pushPlanMode(ws, sessionId, entry); // push the frame even outside plan mode: the UI needs an explicit false
    return;
  }
  const planFilePath = typeof last.data?.planFilePath === "string" ? last.data.planFilePath : PLAN_FILE_URL;
  setPlanMode(ws, sessionId, entry, true, { planFilePath, persist: false });
}
