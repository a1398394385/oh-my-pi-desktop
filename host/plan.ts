// Plan mode domain: /plan command dispatch, plan_mode state frames, the
// proposal approval loop (xd://propose), and persisted mode_change restore.
// Approval/autosave semantics align with the base plan-mode
// (resolveApprovedPlan / autosaveApprovedPlan); desktop differences = no
// paused intermediate state, approvals go through the requestApproval WS
// bridge.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { hostI18n } from "../ui-src/i18n/host.ts";
import {
  resolveApprovedPlan,
  autosaveApprovedPlan,
  resolveLocalUrlToPath,
  normalizeLocalScheme,
} from "./bootstrap.ts";
import { pushCommandOutput, requestApproval, type PoolEntry } from "./state.ts";

const PLAN_MODE_NAME = "plan";
const PLAN_FILE_URL = "local://PLAN.md"; // same location as the ACP default plan file
// Stable option ids on the plan approval frame: the UI renders localized
// labels from these ids and returns the chosen id — display text never
// crosses the wire, so the contract survives language switches.
const PLAN_APPROVE = "approve";
const PLAN_REFINE = "refine";

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

/** Disk path of the local:// plan file (aligned with ACP's #resolveAcpPlanFilePath) */
function planFilePathOnDisk(entry: PoolEntry, url: string): string {
  const normalized = url.startsWith("local:") ? normalizeLocalScheme(url) : url;
  return resolveLocalUrlToPath(normalized, {
    getArtifactsDir: () => entry.session.sessionManager.getArtifactsDir(),
    getSessionId: () => entry.session.sessionManager.getSessionId(),
  });
}

/** Read the plan file content; null when absent (resolveApprovedPlan falls back based on this) */
async function readPlanContent(entry: PoolEntry, url: string): Promise<string | null> {
  try {
    return await Bun.file(planFilePathOnDisk(entry, url)).text();
  } catch {
    return null;
  }
}

/** Plan files under the session-local root (newest first): the resolveApprovedPlan fallback when the agent lost extra.title */
async function listPlanFilesOf(entry: PoolEntry): Promise<string[]> {
  try {
    const dir = planFilePathOnDisk(entry, "local://");
    const files = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && /plan\.md$/i.test(d.name));
    const stamped = await Promise.all(
      files.map(async (d) => ({ name: d.name, mtime: (await stat(path.join(dir, d.name))).mtimeMs })),
    );
    return stamped.sort((a, b) => b.mtime - a.mtime).map((f) => `local://${f.name}`);
  } catch {
    return [];
  }
}

// Proposal handler: invoked by the base after the agent writes xd://propose
// (the returned tool result goes back to the model side).
// Approve -> record the plan reference + autosave the plan + exit plan mode;
// reject -> stay in plan mode and keep polishing.
async function handlePlanProposal(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  title: string,
) {
  const state = entry.session.getPlanModeState();
  if (!state?.enabled) throw new Error(hostI18n.t("errors.plan.notActive"));
  const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
    suppliedTitle: title,
    statePlanFilePath: state.planFilePath,
    readPlan: (url: string) => readPlanContent(entry, url),
    listPlanFiles: () => listPlanFilesOf(entry),
  });
  const details = { planFilePath, title: resolvedTitle, planExists: true };
  const answer = await requestApproval(
    ws,
    sessionId,
    hostI18n.t("flows.plan.approvalTitle", { title: resolvedTitle, path: planFilePath }),
    [PLAN_APPROVE, PLAN_REFINE],
  );
  if (answer !== PLAN_APPROVE) {
    // Rejected: promote the just-reviewed path to the state path so the next proposal keeps editing this plan
    if (state.planFilePath !== planFilePath) entry.session.setPlanModeState({ ...state, planFilePath });
    return {
      content: [{ type: "text" as const, text: hostI18n.t("flows.plan.refineResult", { path: planFilePath }) }],
      details,
    };
  }
  entry.session.setPlanReferencePath(planFilePath); // inject the plan body as context next turn
  const planContent = (await readPlanContent(entry, planFilePath)) ?? "";
  try {
    await autosaveApprovedPlan({
      settings: entry.session.settings,
      cwd: entry.session.sessionManager.getCwd(),
      title: resolvedTitle,
      planContent,
    });
  } catch (err) {
    process.stderr.write(`[host] 计划自动保存失败: ${String(err)}\n`);
  }
  setPlanMode(ws, sessionId, entry, false);
  return {
    content: [{ type: "text" as const, text: hostI18n.t("flows.plan.approvedResult", { path: planFilePath }) }],
    details,
  };
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
    entry.session.setPlanProposalHandler?.((title: string) => handlePlanProposal(ws, sessionId, entry, title));
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
