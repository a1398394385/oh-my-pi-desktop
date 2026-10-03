// Plan-mode approval flow: the five next-step options plus the execution-model
// slider, ported from the base TUI's `InteractiveMode.#handlePlanApproval` /
// `#approvePlan` / `#savePlanAndQuit` (oh-my-pi
// packages/coding-agent/src/modes/interactive-mode.ts:5216-4560).
//
// Why the approval runs out of band instead of inside the `xd://propose`
// handler: `AgentSession.abort()` awaits `agent.waitForIdle()`, so awaiting an
// operator decision inside a running tool handler and then aborting deadlocks.
// The TUI already solves this by letting `xd://propose` return a dumb tool
// result and dispatching approval from `tool_execution_end` with `void`
// (event-controller.ts:1975). `installProposalHandler` keeps the handler a
// thin validator; `dispatchFromToolEnd` is the detached entry point the session
// event subscription calls.
//
// Approval semantics kept identical to the TUI:
//   - execute          fresh session (history cleared, local:// artifacts carried over)
//   - compact context  distill the transcript, then execute in this session
//   - keep context     execute here with the exploration history (disabled >95%)
//   - refine           stay in plan mode for another pass
//   - save and quit    write the plan to a chosen path, then start a new session
import path from "node:path";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { prompt } from "@oh-my-pi/pi-utils";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { hostI18n } from "../ui-src/i18n/host.ts";
import {
  autosaveApprovedPlan,
  copyLocalArtifacts,
  normalizeLocalScheme,
  PROPOSE_DEVICE_NAME,
  readSdkPrompt,
  resolveApprovedPlan,
  resolveLocalUrlToPath,
  resolveToCwd,
  writeDeviceDispatch,
} from "./bootstrap.ts";
import { pushCommandOutput, requestApproval, type PoolEntry } from "./state.ts";

// Stable option ids on the plan approval frame. The UI renders localized
// labels from these ids and returns the chosen id, so display text never
// crosses the wire and the contract survives language switches.
export const PLAN_EXECUTE = "plan:execute";
export const PLAN_COMPACT = "plan:compact";
export const PLAN_KEEP = "plan:keep";
export const PLAN_REFINE = "plan:refine";
export const PLAN_SAVE_QUIT = "plan:save-quit";

/** `Approve and keep context` is disabled once the context is nearly full (base TUI parity). */
const KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

type Ws = { send(data: string): unknown };

/** Tool-presentation snapshot taken when plan mode is entered, restored on approval. */
type ToolPresentation = { enabled: string[]; mounted: string[] };

/** Model-tier slider payload: the roles the operator may execute the plan with. */
export type ExecutionSlider = {
  caption: string;
  index: number;
  segments: { label: string; detail: string }[];
};

/** Per-request presentation carried alongside the option ids. */
type PlanApprovalPresentation = NonNullable<Parameters<typeof requestApproval>[5]>;

/** Transient approval-flow state hung off the pool entry (not part of PoolEntry's public shape). */
type PlanApprovalState = {
  presentation?: ToolPresentation;
};

function planState(entry: PoolEntry): PlanApprovalState {
  return entry as PoolEntry & PlanApprovalState;
}

/** The role-cycle slider, always parked on `default` so execution defaults to the default model. */
function buildExecutionSlider(entry: PoolEntry): ExecutionSlider | undefined {
  const cycle = entry.session.getRoleModelCycle(entry.session.settings.get("cycleOrder") as string[]);
  if (!cycle || cycle.models.length <= 1) return undefined; // a lone tier is no choice
  const defaultIndex = cycle.models.findIndex((m) => m.role === "default");
  const startIndex = defaultIndex >= 0 ? defaultIndex : cycle.currentIndex;
  return {
    caption: hostI18n.t("flows.plan.continueWith"),
    index: startIndex,
    segments: cycle.models.map((m) => ({ label: m.role, detail: m.model.name || m.model.id })),
  };
}

/** Disk path of the local:// plan file. */
function planFilePathOnDisk(entry: PoolEntry, url: string): string {
  const normalized = url.startsWith("local:") ? normalizeLocalScheme(url) : url;
  return resolveLocalUrlToPath(normalized, {
    getArtifactsDir: () => entry.session.sessionManager.getArtifactsDir(),
    getSessionId: () => entry.session.sessionManager.getSessionId(),
  });
}

/** Read the plan file; null when absent. */
async function readPlanContent(entry: PoolEntry, url: string): Promise<string | null> {
  try {
    return await Bun.file(planFilePathOnDisk(entry, url)).text();
  } catch {
    return null;
  }
}

/** `local://` plan files in the session root, newest first (title-loss fallback). */
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

/**
 * Creates the post-approval fresh session. Injected rather than imported:
 * session-lifecycle is the module that calls us (it owns the event
 * subscription the dispatch rides on), so a static import back would be a
 * cycle — the same reason the host boundary table forbids it.
 */
type FreshSessionFactory = (ws: Ws, entry: PoolEntry) => Promise<PoolEntry>;
let createFreshSession: FreshSessionFactory | undefined;

/** Wire the session factory (called once by session-lifecycle at module load). */
export function setFreshSessionFactory(factory: FreshSessionFactory): void {
  createFreshSession = factory;
}

/** New session + carry the old session's local:// artifacts across the switch. */
async function forkWithLocalArtifacts(ws: Ws, entry: PoolEntry, sourceLocalRoot: string): Promise<PoolEntry> {
  if (!createFreshSession) throw new Error("plan approval: session factory not installed");
  const next = await createFreshSession(ws, entry);
  await copyLocalArtifacts(sourceLocalRoot, planFilePathOnDisk(next, "local://"));
  return next;
}

/**
 * Show the approval card and act on the choice. Mirrors the TUI's option list
 * and its three terminal outcomes (approve / refine / save-and-quit).
 */
async function approveProposal(
  ws: Ws,
  sessionId: string,
  entry: PoolEntry,
  planFilePath: string,
  title: string,
  planContent: string,
  sourceLocalRoot: string,
) {
  const usage = entry.session.getContextUsage();
  const slider = buildExecutionSlider(entry);
  // The picked tier arrives with the response; default to the tier the slider
  // was parked on so a plan variant without a slider still executes on the
  // default role.
  let pickedTier: number | undefined = slider?.index;
  const answer = await requestApproval(
    ws,
    sessionId,
    hostI18n.t("flows.plan.approvalTitle", { title, path: planFilePath }),
    [PLAN_EXECUTE, PLAN_COMPACT, PLAN_KEEP, PLAN_REFINE, PLAN_SAVE_QUIT],
    undefined,
    {
      // Raw token counts, not a rendered label: the UI localizes the
      // "Approve and keep context (~44k / 1m)" row from them, so no display
      // text crosses the wire and the answer contract stays id-based. A
      // zero/absent context window (no model resolved) is omitted so the UI
      // falls back to the bare label instead of rendering "/ 0".
      keepContextTokens:
        usage && usage.contextWindow > 0 ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : undefined,
      disabledIndices:
        usage && usage.percent > KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT ? [optionsKeepIndex()] : undefined,
      slider,
    } satisfies PlanApprovalPresentation,
    (index) => {
      pickedTier = index;
    },
  );

  if (answer === PLAN_SAVE_QUIT) {
    const destination = await promptPlanSavePath(ws, sessionId, entry, planContent);
    if (destination === undefined) return; // cancelled, or the write failed
    exitPlanModeState(entry);
    pushPlanState(ws, sessionId, entry);
    try {
      await forkWithLocalArtifacts(ws, entry, sourceLocalRoot);
      pushCommandOutput(sessionId, hostI18n.t("flows.plan.savedPlan", { path: destination }));
    } catch (err) {
      pushCommandOutput(
        sessionId,
        hostI18n.t("flows.plan.savedThenQuitFailed", { path: destination, err: describe(err) }),
      );
    }
    return;
  }

  if (answer === PLAN_REFINE) return; // stay in plan mode; the model refines the same file

  await approvePlan(ws, sessionId, entry, {
    planFilePath,
    title,
    planContent,
    preserveContext: answer !== PLAN_EXECUTE,
    compactBeforeExecute: answer === PLAN_COMPACT,
    roleIndex: pickedTier,
    sourceLocalRoot,
  });
}

/** Index of the keep-context row within the option list (protocol constant, not display order). */
function optionsKeepIndex(): number {
  return [PLAN_EXECUTE, PLAN_COMPACT, PLAN_KEEP, PLAN_REFINE, PLAN_SAVE_QUIT].indexOf(PLAN_KEEP);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Write the plan to the operator's chosen path (the TUI's `#promptPlanSavePath`). */
async function promptPlanSavePath(
  ws: Ws,
  sessionId: string,
  entry: PoolEntry,
  planContent: string,
): Promise<string | undefined> {
  const answer = await requestApproval(
    ws,
    sessionId,
    hostI18n.t("flows.plan.savePathTitle"),
    ["submit", "cancel"],
    undefined,
    { editable: true, editableIndex: 0 } satisfies PlanApprovalPresentation,
  );
  if (!answer || answer === "cancel") return undefined;
  let destination: string;
  try {
    destination = resolveToCwd(answer, entry.session.sessionManager.getCwd());
  } catch (err) {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.saveFailed", { path: answer, err: describe(err) }));
    return undefined;
  }
  try {
    await writeFile(destination, planContent);
  } catch (err) {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.saveFailed", { path: destination, err: describe(err) }));
    return undefined;
  }
  return destination;
}

/**
 * Apply the operator's approval: leave plan mode, then execute per the chosen
 * context policy. Resolves false when the operator cancelled the compaction —
 * their explicit abort is honoured and no execution turn is dispatched.
 */
async function approvePlan(
  ws: Ws,
  sessionId: string,
  entry: PoolEntry,
  options: {
    planFilePath: string;
    title: string;
    planContent: string;
    preserveContext: boolean;
    compactBeforeExecute: boolean;
    roleIndex: number | undefined;
    sourceLocalRoot: string;
  },
): Promise<boolean> {
  const { planFilePath, title, planContent, preserveContext, compactBeforeExecute, roleIndex, sourceLocalRoot } =
    options;
  const session = entry.session;

  if (!preserveContext) {
    // Fresh context: a brand-new session carrying the durable plan across, so
    // the execution turn can still recover it from `local://` after compaction.
    const next = await forkWithLocalArtifacts(ws, entry, sourceLocalRoot);
    const dest = planFilePathOnDisk(next, planFilePath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, planContent);
    exitPlanModeState(entry);
    pushPlanState(ws, sessionId, entry);
    return dispatchApprovedTurn(next, {
      planFilePath,
      planContent,
      preserveContext,
      roleIndex,
      title,
    });
  }

  exitPlanModeState(entry);
  pushPlanState(ws, sessionId, entry);

  // The plan→execution transition aborts the turn that produced the proposal.
  // Arm the silent marker so that aborted message is stamped as a silent abort
  // instead of surfacing as a user-visible cancellation; clear it on every exit.
  let compactOutcome: "ok" | "cancelled" | "failed" = "ok";
  if (compactBeforeExecute) {
    session.markPlanInternalAbortPending();
    try {
      // Pin the plan reference before compacting so anything queued during the
      // compaction wait still sees the approved plan in context.
      session.setPlanReferencePath(planFilePath);
      const guidance = prompt.render(await readSdkPrompt("plan-mode-compact-instructions.md"), { planFilePath });
      await session.compact(undefined, { internalGuidance: guidance, suppressContinuation: true });
    } catch (err) {
      compactOutcome = err instanceof CompactionCancelledError ? "cancelled" : "failed";
      if (compactOutcome === "failed") {
        process.stderr.write(`[host] plan approval compaction failed: ${describe(err)}\n`);
      }
    } finally {
      session.clearPlanInternalAbortPending();
    }
  }

  // Restore the full tool set, but force-enable `read` so the durable plan stays
  // reachable even if the inline copy is compacted away.
  const presentation = planState(entry).presentation ?? {
    enabled: session.getEnabledToolNames(),
    mounted: session.getMountedXdevToolNames(),
  };
  await session
    .restoreNonMCPToolPresentation(
      presentation.enabled.includes("read") ? presentation.enabled : [...presentation.enabled, "read"],
      presentation.mounted,
    )
    .catch((err: unknown) => process.stderr.write(`[host] plan tool restore failed: ${describe(err)}\n`));
  session.setPlanReferencePath(planFilePath);

  try {
    await autosaveApprovedPlan({
      settings: session.settings,
      cwd: session.sessionManager.getCwd(),
      title,
      planContent,
    });
  } catch (err) {
    process.stderr.write(`[host] plan autosave failed: ${describe(err)}\n`);
  }

  // A cancelled compaction is the operator aborting the distillation, not the
  // approval: honour it and leave execution to their next turn.
  if (compactOutcome === "cancelled") {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.compactCancelled"));
    return false;
  }
  return dispatchApprovedTurn(entry, { planFilePath, planContent, preserveContext, roleIndex, title });
}

/** Clear plan-mode state (the desktop has no paused intermediate state). */
function exitPlanModeState(entry: PoolEntry) {
  const state = planState(entry);
  state.presentation = undefined;
  entry.session.setPlanProposalHandler?.(null);
  entry.session.setPlanModeState(undefined);
  entry.manager.appendModeChange?.("none");
}

/** Push the (now-disabled) plan-mode state frame so the UI drops the exit button. */
function pushPlanState(ws: Ws, sessionId: string, entry: PoolEntry) {
  ws.send(
    JSON.stringify({
      type: "plan_mode",
      sessionId,
      enabled: entry.session.getPlanModeState()?.enabled === true,
      planFilePath: entry.session.getPlanModeState()?.planFilePath ?? null,
    }),
  );
}

/**
 * Apply the slider's chosen role model, then dispatch the approved execution
 * turn. Runs after plan-mode exit so the pre-plan model restore cannot revert it.
 */
async function dispatchApprovedTurn(
  entry: PoolEntry,
  args: { planFilePath: string; planContent: string; preserveContext: boolean; roleIndex: number | undefined; title: string },
): Promise<boolean> {
  const session = entry.session;
  if (args.roleIndex !== undefined) {
    const cycle = session.getRoleModelCycle(session.settings.get("cycleOrder") as string[]);
    const chosen = cycle?.models[args.roleIndex];
    if (chosen) await session.applyRoleModel(chosen);
  }

  // Seed an auto name from the plan title so the fresh session is not unnamed
  // (a no-op when the operator already named it, i.e. the keep-context paths).
  if (args.title && !session.sessionManager.getSessionName()) {
    await session.sessionManager.setSessionName(args.title, "auto").catch(() => {});
  }

  // The approved turn is synthetic: its plan body is inlined, so it must not
  // read as an operator utterance (no title generation, no user attribution).
  session.markPlanReferenceSent();
  const approved = prompt.render(await readSdkPrompt("plan-mode-approved.md"), {
    planFilePath: args.planFilePath,
    planContent: args.planContent,
    contextPreserved: args.preserveContext,
  });
  // A turn the operator queued during compaction wins; the execution directive
  // rides behind it as a synthetic follow-up rather than racing it.
  if (session.isStreaming) {
    await session.followUp(approved, undefined, { synthetic: true });
  } else {
    try {
      await session.prompt(approved, { synthetic: true });
    } catch (err) {
      if (!(err instanceof Error) || err.name !== "AgentBusyError") throw err;
      await session.followUp(approved, undefined, { synthetic: true });
    }
  }
  return true;
}

/**
 * Plan-proposal handler installed while plan mode is active. It only validates
 * the plan and returns a dumb tool result — the approval itself is dispatched
 * out of band (see `dispatchFromToolEnd`) so no operator wait ever blocks the
 * agent loop that `abort()` needs to idle.
 */
export function installProposalHandler(ws: Ws, sessionId: string, entry: PoolEntry) {
  const session = entry.session;
  // Snapshot the pre-plan tool presentation so approval can restore it.
  planState(entry).presentation = {
    enabled: session.getEnabledToolNames(),
    mounted: session.getMountedXdevToolNames(),
  };
  session.setPlanProposalHandler?.(async (title: string) => {
    const state = session.getPlanModeState();
    if (!state?.enabled) throw new Error(hostI18n.t("errors.plan.notActive"));
    const resolved = await resolveApprovedPlan({
      suppliedTitle: title,
      statePlanFilePath: state.planFilePath,
      readPlan: (url: string) => readPlanContent(entry, url),
      listPlanFiles: () => listPlanFilesOf(entry),
    });
    // Carry the approval payload on the tool result so the event subscription
    // can pick it up at `tool_execution_end` (the TUI's dispatch shape).
    return {
      content: [{ type: "text" as const, text: "Plan ready for review." }],
      details: { planFilePath: resolved.planFilePath, title: resolved.title, planExists: true },
    };
  });
}

/**
 * Detached approval entry point, called from the session's `tool_execution_end`
 * subscription when a `write` to `xd://propose` lands. Never awaited by the
 * caller: awaiting would hold the serialized event chain for the whole
 * execution turn (the TUI hit this as #7684).
 */
export function dispatchFromToolEnd(ws: Ws, sessionId: string, entry: PoolEntry, toolName: string, result: unknown) {
  const dispatch = writeDeviceDispatch(toolName, result);
  const details = dispatch?.tool === PROPOSE_DEVICE_NAME && dispatch.mode === "execute" ? dispatch.inner : undefined;
  if (
    !details ||
    typeof details !== "object" ||
    !("planFilePath" in details) ||
    !("title" in details) ||
    typeof details.planFilePath !== "string" ||
    typeof details.title !== "string"
  ) {
    return;
  }
  void runApproval(ws, sessionId, entry, details.planFilePath, details.title).catch((err: unknown) => {
    process.stderr.write(`[host] plan approval dispatch failed: ${describe(err)}\n`);
  });
}

/** The approval itself: settle the proposal turn, then ask and act. */
async function runApproval(ws: Ws, sessionId: string, entry: PoolEntry, planFilePath: string, title: string) {
  const session = entry.session;
  const state = session.getPlanModeState();
  if (!state?.enabled) return; // plan mode already left (the operator bailed first)
  // resolveApprovedPlan may return a newer draft than the state path; promote it
  // so the next planning turn targets the plan just reviewed.
  if (state.planFilePath !== planFilePath) session.setPlanModeState({ ...state, planFilePath });

  // Read the plan BEFORE aborting: abort resets a non-persisted session's file
  // handle, after which `local://` no longer resolves. Every branch below works
  // from this captured copy.
  const planContent = await readPlanContent(entry, planFilePath);
  if (planContent === null) {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.planNotFound", { path: planFilePath }));
    return;
  }
  // Same reason: the fresh-context branch copies this session's local:// root
  // into the new session, so the source path has to be captured up front too.
  const sourceLocalRoot = planFilePathOnDisk(entry, "local://");

  // The proposal turn already returned its tool result; abort it so the model
  // does not read "Plan ready for review." and immediately re-propose. This is
  // an internal UI transition, not operator cancellation.
  session.markPlanInternalAbortPending();
  try {
    await session.abort();
  } finally {
    session.clearPlanInternalAbortPending();
  }

  if (!session.getPlanModeState()?.enabled) return; // aborted into a mode change

  try {
    await approveProposal(ws, sessionId, entry, planFilePath, title, planContent, sourceLocalRoot);
  } catch (err) {
    pushCommandOutput(sessionId, hostI18n.t("flows.plan.approveFailed", { err: describe(err) }));
  }
}
