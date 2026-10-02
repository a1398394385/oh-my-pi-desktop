// Desktop implementation of the /goal command + goal continuation scheduling
// (semantics aligned with the omp CLI TUI goal). The base /goal only has
// handleTui (no handle in BUILTIN), so the ACP dispatcher
// executeAcpBuiltinSlashCommand never picks it up — the desktop intercepts
// this command ahead of dispatchSlashInput. TUI menu/editor interactions are
// replaced with command_output notices; the state machine
// (create/replace/pause/resume/drop/budget), goal tool-set exposure,
// goal-continuation hidden follow-ups and the no-progress suppression (stop
// when consecutive continuation turns produce no new tool activity) all align
// with interactive-mode's handleGoalModeCommand / #scheduleGoalContinuation /
// #handleGoalSessionEvent.
import { hostI18n } from "../ui-src/i18n/host.ts";

/** Goal record (isomorphic to modeData.goal of the persisted mode_change; field validation in goalFromModeData). */
export interface GoalLike {
  id: string;
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalStateLike {
  enabled: boolean;
  mode: "active" | "exiting";
  goal: GoalLike;
}

/** Narrow session interface GoalController depends on (the goal-related face of AgentSession; structural typing suffices). */
export interface GoalSession {
  getGoalModeState(): GoalStateLike | undefined;
  setGoalModeState(state: GoalStateLike | undefined): void;
  getPlanModeState(): { enabled?: boolean } | undefined;
  getEnabledToolNames(): string[];
  setActiveToolsByName(names: string[]): Promise<unknown> | void;
  settings: { get(key: string): unknown };
  goalRuntime: {
    createGoal(input: { objective: string }): Promise<GoalStateLike>;
    replaceGoal(input: { objective: string }): Promise<GoalStateLike>;
    resumeGoal(): Promise<GoalStateLike>;
    pauseGoal(): Promise<GoalStateLike | undefined>;
    dropGoal(): Promise<GoalLike | undefined>;
    onBudgetMutated(budget: number | undefined): Promise<GoalStateLike | undefined>;
    onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalStateLike | undefined>;
    clearAccounting(): void;
    buildContinuationPrompt(): string | undefined;
  };
  sessionManager: {
    appendModeChange(mode: string, data?: Record<string, unknown>): void;
    appendCustomEntry(type: string, data: Record<string, unknown>): void;
    buildSessionContext(): { mode?: string; modeData?: { goal?: unknown } };
  };
  promptCustomMessage(
    message: { customType: string; content: string; display: boolean; attribution: string },
    options?: { streamingBehavior?: string },
  ): Promise<unknown>;
  sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" }): Promise<unknown>;
  isStreaming: boolean;
  isCompacting: boolean;
  hasPostPromptWork: boolean;
  getSessionStats(): { cost: number };
}

type GoalSubcommand = "set" | "pause" | "resume" | "drop" | "budget";
const GOAL_SUBCOMMANDS: Record<string, true> = { set: true, pause: true, resume: true, drop: true, budget: true };

/** Split off the first word when it is a subcommand, otherwise treat the whole input as the objective (aligned with TUI parseGoalSubcommand). */
function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { sub: undefined, rest: "" };
  const m = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  const head = m?.[1] ?? trimmed;
  if (head in GOAL_SUBCOMMANDS) {
    return { sub: head as GoalSubcommand, rest: (m?.[2] ?? "").trim() };
  }
  return { sub: undefined, rest: trimmed };
}

/** Validate and restore a goal record from persisted modeData (aligned with TUI #goalFromModeData). */
function goalFromModeData(modeData: { goal?: unknown } | undefined): GoalLike | undefined {
  const goal = modeData?.goal;
  if (!goal || typeof goal !== "object") return undefined;
  const v = goal as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.objective !== "string" ||
    typeof v.status !== "string" ||
    typeof v.tokensUsed !== "number" ||
    typeof v.timeUsedSeconds !== "number" ||
    typeof v.createdAt !== "number" ||
    typeof v.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    id: v.id,
    objective: v.objective,
    status: v.status,
    tokenBudget: typeof v.tokenBudget === "number" ? v.tokenBudget : undefined,
    tokensUsed: v.tokensUsed,
    timeUsedSeconds: v.timeUsedSeconds,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

/** Key-sorted stable serialization: continuation activity fingerprints must not misjudge "new activity" due to object key-order jitter. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") + "}";
}

/** Model-visible tool activity fingerprint (excludes per-turn fields like callId/timestamps; aligned with TUI #goalContinuationActivity). */
function goalContinuationActivity(messages: unknown[]): string {
  const digests: string[] = [];
  const record = (value: unknown): void => {
    const serialized = stableStringify(value);
    digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
  };
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: Array<{ type?: string; name?: string; arguments?: unknown }>;
      toolName?: string;
      isError?: boolean;
    };
    if (m.role === "assistant") {
      for (const block of m.content ?? []) {
        if (block.type === "toolCall") record(["call", block.name, block.arguments]);
      }
    } else if (m.role === "toolResult") {
      record(["result", m.toolName, m.content, m.isError === true]);
    }
  }
  return digests.join(":");
}

export class GoalController {
  readonly #session: GoalSession;
  readonly #output: (text: string) => void;
  readonly #onChange: () => void;
  /** Tool set before entering goal mode (restored on exit); for restored goals it is recorded in restore(). */
  #prevTools: string[] | undefined;
  #timer: NodeJS.Timeout | undefined;
  // Session cost delta during the goal (goal records carry no cost field:
  // accumulated as deltas against a session cost anchor; a reopened session
  // counts from the restore moment, historical deltas are not backfilled)
  #costUsed = 0;
  #costAnchor = 0;
  #pendingContinuationTurns = 0;
  #previousActivity: string | undefined;
  #suppressNext = false;

  constructor(deps: { session: GoalSession; output: (text: string) => void; onChange: () => void }) {
    this.#session = deps.session;
    this.#output = deps.output;
    this.#onChange = deps.onChange;
  }

  #notify(): void {
    const cost = this.#session.getSessionStats().cost;
    this.#costUsed += Math.max(0, cost - this.#costAnchor);
    this.#costAnchor = cost;
    this.#onChange();
  }

  /** Cost consumed during the goal (accumulated session cost deltas, USD). */
  get costUsed(): number {
    return this.#costUsed;
  }

  /** Dispatch /goal args. Returns the objective (caller forwards it into the normal prompt path) or null (consumed). */
  async handleCommand(args: string): Promise<string | null> {
    const s = this.#session;
    if (s.getPlanModeState()?.enabled) {
      this.#output(hostI18n.t("flows.goal.planModeBlocked"));
      return null;
    }
    if (!s.settings.get("goal.enabled")) {
      this.#output(hostI18n.t("flows.goal.notEnabled"));
      return null;
    }
    const { sub, rest } = parseGoalSubcommand(args);
    switch (sub) {
      case "set":
        return await this.#dispatch(this.#handleSet(rest));
      // pause/resume/drop/budget are void actions: must explicitly return null
      // (consumed locally). A missing return would let dispatchSlashInput hand
      // undefined to prompt() as the objective, and the base
      // parseSlashCommand(undefined) throws text.startsWith TypeError
      case "pause":
        await this.#dispatch(this.#pause());
        return null;
      case "resume":
        await this.#dispatch(this.#resume());
        return null;
      case "drop":
        await this.#dispatch(this.#drop());
        return null;
      case "budget":
        await this.#dispatch(this.#budget(rest));
        return null;
    }
    const state = s.getGoalModeState();
    if (state?.enabled && state.goal.status === "active") {
      if (rest) {
        this.#output(hostI18n.t("flows.goal.activeUpdateHint"));
        return null;
      }
      this.#output(hostI18n.t("flows.goal.running"));
      return null;
    }
    if (this.#pausedState()) {
      if (rest) {
        this.#output(hostI18n.t("flows.goal.pausedNewGoal"));
        return null;
      }
      this.#output(hostI18n.t("flows.goal.paused"));
      return null;
    }
    if (rest) return await this.#dispatch(this.#startFromObjective(rest));
    this.#output(hostI18n.t("flows.goal.usage"));
    return null;
  }

  /** Unified exit for command actions: notify the host to push a goal frame after state changes (session state card refresh). */
  async #dispatch<T>(action: Promise<T>): Promise<T> {
    try {
      return await action;
    } finally {
      this.#notify();
    }
  }

  // ---------- event hooks (host event subscription forwarding, aligned with TUI #handleGoalSessionEvent) ----------

  onAgentStart(): void {
    this.cancel();
  }

  /** A real user message (not synthetic) arrived: reset suppression and evaluate continuation normally at the next turn end. */
  onUserMessage(): void {
    this.#resetSuppression();
  }

  async onAgentEnd(messages: unknown[]): Promise<void> {
    try {
      if (this.#pendingContinuationTurns > 0) {
        this.#pendingContinuationTurns--;
        const activity = goalContinuationActivity(messages);
        // No activity or identical to last turn's activity -> no progress; suppress the next continuation (prevents spinning in place)
        this.#suppressNext = activity.length === 0 || activity === this.#previousActivity;
        this.#previousActivity = activity;
      } else {
        this.#resetSuppression();
      }
      const state = this.#session.getGoalModeState();
      if (state?.mode === "exiting") {
        await this.#exitGoalMode({ reason: "completed" });
        this.#output(hostI18n.t("flows.goal.completed"));
        return;
      }
      this.schedule();
    } finally {
      this.#notify(); // tokensUsed/duration changed at turn end; refresh the session state card
    }
  }

  onGoalUpdated(state: GoalStateLike | undefined): void {
    // Model-side goal tool drop: exit and restore the tool set (TUI handles it before clearing the flag, so the snapshot is easy to restore)
    if (state?.goal?.status === "dropped") {
      void this.#exitGoalMode({ reason: "dropped", silent: true }).then(() => this.#notify());
      return;
    }
    if (!state?.enabled) this.cancel();
    this.#notify();
  }

  /** Cancel the pending continuation timer. */
  cancel(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Cold-load restore (aligned with the goal part of TUI #reconcileModeFromSession): no proactive continuation; wait for the next agent_end. */
  async restore(): Promise<void> {
    const s = this.#session;
    this.#costAnchor = s.getSessionStats().cost;
    const ctx = s.sessionManager.buildSessionContext();
    if (ctx.mode !== "goal" && ctx.mode !== "goal_paused") return;
    if (!s.settings.get("goal.enabled")) {
      s.goalRuntime.clearAccounting();
      s.sessionManager.appendModeChange("none");
      return;
    }
    const goal = goalFromModeData(ctx.modeData);
    if (!goal) {
      s.sessionManager.appendModeChange("none");
      return;
    }
    if (goal.status === "complete") {
      // Force-quit missed the completion event (completeGoalFromTool already
      // persisted the terminal goal): backfill the completion wrap-up on
      // restore instead of reviving a completed goal as in-progress
      s.sessionManager.appendModeChange("none");
      s.sessionManager.appendCustomEntry("goal-completed", {
        objective: goal.objective,
        tokensUsed: goal.tokensUsed,
        tokenBudget: goal.tokenBudget,
        timeUsedSeconds: goal.timeUsedSeconds,
      });
      this.#output(hostI18n.t("flows.goal.completedBackfilled"));
      this.#notify();
      return;
    }
    s.setGoalModeState({ enabled: ctx.mode === "goal", mode: "active", goal });
    const restored = await s.goalRuntime.onThreadResumed({});
    // The sdk's initial tool set unconditionally excludes goal: add it back after restore so the model can resume/complete/drop this goal
    if (restored?.goal) {
      const prev = s.getEnabledToolNames().filter((n) => n !== "goal");
      this.#prevTools = prev;
      await s.setActiveToolsByName([...new Set([...prev, "goal"])]);
    }
    this.#notify();
  }

  // ---------- internal actions ----------

  #pausedState(): GoalStateLike | undefined {
    const state = this.#session.getGoalModeState();
    return state && !state.enabled && state.goal.status === "paused" ? state : undefined;
  }

  #resetSuppression(): void {
    this.#suppressNext = false;
    this.#previousActivity = undefined;
  }

  async #handleSet(rest: string): Promise<string | null> {
    if (this.#pausedState()) {
      this.#output(hostI18n.t("flows.goal.pausedNewGoal"));
      return null;
    }
    const objective = rest.trim();
    if (!objective) {
      this.#output(hostI18n.t("flows.goal.setUsage"));
      return null;
    }
    const state = this.#session.getGoalModeState();
    if (state?.enabled && state.goal.status === "active") return await this.#replaceFromObjective(objective);
    return await this.#startFromObjective(objective);
  }

  async #startFromObjective(objective: string): Promise<string> {
    const s = this.#session;
    const prev = s.getEnabledToolNames().filter((n) => n !== "goal");
    const state = await s.goalRuntime.createGoal({ objective });
    await s.setActiveToolsByName([...new Set([...prev, "goal"])]);
    s.setGoalModeState(state);
    this.#prevTools = prev;
    this.#costUsed = 0;
    this.#costAnchor = s.getSessionStats().cost;
    this.#resetSuppression();
    this.#output(hostI18n.t("flows.goal.modeEnabled"));
    return objective;
  }

  async #replaceFromObjective(objective: string): Promise<string> {
    const s = this.#session;
    const state = await s.goalRuntime.replaceGoal({ objective });
    s.setGoalModeState(state);
    this.#costUsed = 0;
    this.#costAnchor = s.getSessionStats().cost;
    this.#resetSuppression();
    if (s.isStreaming) await s.sendGoalModeContext({ deliverAs: "steer" });
    this.#output(hostI18n.t("flows.goal.updated"));
    return objective;
  }

  async #pause(): Promise<void> {
    const state = this.#session.getGoalModeState();
    if (!state?.enabled || state.goal.status !== "active") {
      this.#output(hostI18n.t("flows.goal.nothingToPause"));
      return;
    }
    await this.#session.goalRuntime.pauseGoal();
    await this.#exitGoalMode({ paused: true });
    this.#output(hostI18n.t("flows.goal.pausedDone"));
  }

  async #resume(): Promise<void> {
    const s = this.#session;
    if (!this.#pausedState()) {
      this.#output(hostI18n.t("flows.goal.nonePaused"));
      return;
    }
    const state = await s.goalRuntime.resumeGoal();
    if (state?.goal) {
      const prev = s.getEnabledToolNames().filter((n) => n !== "goal");
      this.#prevTools ??= prev;
      await s.setActiveToolsByName([...new Set([...prev, "goal"])]);
    }
    this.#resetSuppression();
    this.#output(hostI18n.t("flows.goal.resumed"));
    this.schedule();
  }

  async #drop(): Promise<void> {
    const s = this.#session;
    if (!s.getGoalModeState()) {
      this.#output(hostI18n.t("flows.goal.noGoal"));
      return;
    }
    await s.goalRuntime.dropGoal();
    await this.#exitGoalMode({ reason: "dropped" });
    this.#output(hostI18n.t("flows.goal.dropped"));
  }

  async #budget(rest: string): Promise<void> {
    const s = this.#session;
    const state = s.getGoalModeState();
    if (!state?.enabled || state.goal.status !== "active") {
      this.#output(hostI18n.t(this.#pausedState() ? "flows.goal.budgetPausedHint" : "flows.goal.budgetNoActive"));
      return;
    }
    const t = rest.trim();
    if (!t) {
      this.#output(hostI18n.t("flows.goal.budgetUsage", { current: state.goal.tokenBudget ?? hostI18n.t("flows.goal.noBudget") }));
      return;
    }
    let next: number | undefined;
    if (t === "off") {
      next = undefined;
    } else {
      const n = Number(t);
      if (!Number.isInteger(n) || n <= 0) {
        this.#output(hostI18n.t("flows.goal.budgetInvalid"));
        return;
      }
      next = n;
    }
    await s.goalRuntime.onBudgetMutated(next);
    this.#resetSuppression();
    this.schedule();
    this.#output(next === undefined ? hostI18n.t("flows.goal.budgetCleared") : hostI18n.t("flows.goal.budgetSet", { n: next.toLocaleString() }));
  }

  async #exitGoalMode(options: { paused?: boolean; reason?: "completed" | "dropped"; silent?: boolean }): Promise<void> {
    const s = this.#session;
    const prev = this.#prevTools;
    if (prev) await s.setActiveToolsByName(prev);
    if (options.reason === "completed") {
      const cur = s.getGoalModeState();
      s.setGoalModeState(undefined);
      s.sessionManager.appendModeChange("none");
      s.sessionManager.appendCustomEntry("goal-completed", {
        objective: cur?.goal.objective,
        tokensUsed: cur?.goal.tokensUsed,
        tokenBudget: cur?.goal.tokenBudget,
        timeUsedSeconds: cur?.goal.timeUsedSeconds,
      });
    }
    this.#prevTools = undefined;
    this.#pendingContinuationTurns = 0;
    this.#resetSuppression();
    this.cancel();
  }

  // ---------- continuation scheduling (aligned with TUI #scheduleGoalContinuation) ----------

  /** When the goal is active and continuation is allowed, arm an 800ms timer to send the hidden continuation message. */
  schedule(): void {
    this.cancel();
    const s = this.#session;
    const modes = s.settings.get("goal.continuationModes");
    if (!Array.isArray(modes) || !modes.includes("interactive")) return;
    if (s.getPlanModeState()?.enabled) return;
    if (this.#suppressNext) return;
    const state = s.getGoalModeState();
    if (!state?.enabled || state.goal.status !== "active") return;
    const prompt = s.goalRuntime.buildContinuationPrompt();
    if (!prompt) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#fireContinuation(prompt);
    }, 800);
  }

  async #fireContinuation(prompt: string): Promise<void> {
    const s = this.#session;
    // Same as TUI #isAutoSubmitBlocked: drop this round when busy; the next agent_end reschedules
    if (s.isStreaming || s.isCompacting || s.hasPostPromptWork) return;
    const state = s.getGoalModeState();
    if (!state?.enabled || state.goal.status !== "active") return;
    this.#pendingContinuationTurns++;
    await s.promptCustomMessage(
      { customType: "goal-continuation", content: prompt, display: false, attribution: "agent" },
      { streamingBehavior: "followUp" },
    );
  }
}
