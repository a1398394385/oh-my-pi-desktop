// /goal 命令的桌面实现 + 目标续跑调度（语义对齐 omp CLI TUI 的 goal）。
// 底座 /goal 只有 handleTui（BUILTIN 里无 handle），ACP 分发 executeAcpBuiltinSlashCommand
// 不会接手——桌面在 dispatchSlashInput 前置拦截本命令。TUI 的菜单/编辑器交互换成
// command_output 提示；状态机（create/replace/pause/resume/drop/budget）、goal 工具集暴露、
// goal-continuation 隐藏续跑与「无进展抑制」（连续续跑轮没有新工具活动即停）均对齐
// interactive-mode 的 handleGoalModeCommand / #scheduleGoalContinuation / #handleGoalSessionEvent。
import { hostI18n } from "../ui-src/i18n/host.ts";

/** 目标记录（落盘 mode_change 的 modeData.goal 同构；字段校验见 goalFromModeData）。 */
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

/** GoalController 依赖的会话窄接口（AgentSession 的 goal 相关面，结构满足即可）。 */
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

/** 首词是子命令则拆出，否则整体视为 objective（对齐 TUI parseGoalSubcommand）。 */
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

/** 从落盘 modeData 校验恢复 goal 记录（对齐 TUI #goalFromModeData）。 */
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

/** 键排序的稳定序列化：续跑活动指纹不因对象键序抖动而误判为「有新活动」。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") + "}";
}

/** 模型可见的工具活动指纹（排除 callId/时间戳等每轮都变的字段；对齐 TUI #goalContinuationActivity）。 */
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
  /** 进入 goal 模式前的工具集（exit 时恢复）；恢复来的 goal 在 restore() 记录。 */
  #prevTools: string[] | undefined;
  #timer: NodeJS.Timeout | undefined;
  // 目标期间的会话成本增量（goal 记录无 cost 字段：以会话 cost 锚点差量累计；
  // 重开会话从恢复时刻起算，历史增量不回溯）
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

  /** 目标期间已消耗成本（会话 cost 增量累计，美元）。 */
  get costUsed(): number {
    return this.#costUsed;
  }

  /** /goal 的 args 分发。返回 objective（调用方转正常 prompt 链路）或 null（已消费）。 */
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
      // pause/resume/drop/budget 是 void 动作：必须显式返回 null（本地消费）。
      // 漏返回会让 dispatchSlashInput 把 undefined 当 objective 转给 prompt()，
      // 底座 parseSlashCommand(undefined) 报 text.startsWith TypeError
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

  /** 命令动作统一出口：状态变更后通知宿主推 goal 帧（会话状态卡刷新）。 */
  async #dispatch<T>(action: Promise<T>): Promise<T> {
    try {
      return await action;
    } finally {
      this.#notify();
    }
  }

  // ---------- 事件钩子（宿主事件订阅转发，对齐 TUI #handleGoalSessionEvent） ----------

  onAgentStart(): void {
    this.cancel();
  }

  /** 用户真实消息（非 synthetic）到达：重置抑制，下一轮结束照常评估续跑。 */
  onUserMessage(): void {
    this.#resetSuppression();
  }

  async onAgentEnd(messages: unknown[]): Promise<void> {
    try {
      if (this.#pendingContinuationTurns > 0) {
        this.#pendingContinuationTurns--;
        const activity = goalContinuationActivity(messages);
        // 无活动或与上一轮活动完全相同 → 无进展，抑制下一次续跑（防原地空转）
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
      this.#notify(); // 每轮收尾 tokensUsed/时长有变，刷新会话状态卡
    }
  }

  onGoalUpdated(state: GoalStateLike | undefined): void {
    // 模型侧 goal 工具 drop：退出并恢复工具集（TUI 在清标志前处理，便于恢复快照）
    if (state?.goal?.status === "dropped") {
      void this.#exitGoalMode({ reason: "dropped", silent: true }).then(() => this.#notify());
      return;
    }
    if (!state?.enabled) this.cancel();
    this.#notify();
  }

  /** 取消挂起的续跑定时器。 */
  cancel(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 冷加载恢复（对齐 TUI #reconcileModeFromSession 的 goal 段）：不主动续跑，等下一个 agent_end。 */
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
      // 强退错过完成事件（completeGoalFromTool 落盘了终态 goal）：恢复即补完成收尾，
      // 不把已完成目标复活成进行中
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
    // sdk 初始工具集无条件排除 goal：恢复后补回，模型才能对本目标 resume/complete/drop
    if (restored?.goal) {
      const prev = s.getEnabledToolNames().filter((n) => n !== "goal");
      this.#prevTools = prev;
      await s.setActiveToolsByName([...new Set([...prev, "goal"])]);
    }
    this.#notify();
  }

  // ---------- 内部动作 ----------

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

  // ---------- 续跑调度（对齐 TUI #scheduleGoalContinuation） ----------

  /** goal 处于 active 且允许续跑时挂 800ms 定时器发隐藏续跑消息。 */
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
    // TUI #isAutoSubmitBlocked 同款：忙时丢弃本轮，下一个 agent_end 会重新调度
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
