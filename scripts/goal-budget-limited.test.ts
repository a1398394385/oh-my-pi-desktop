// Budget-limited goal lifecycle.
//
// The base goal runtime keeps a goal `enabled` when its token budget runs out:
// only `status` flips to "budget-limited", and `isAccountingStatus` treats
// "active" and "budget-limited" alike (node_modules/@oh-my-pi/pi-coding-agent
// /src/goals/runtime.ts). The TUI therefore drives /goal set, /goal pause and
// /goal budget off `goalModeEnabled` (= state.enabled), so a budget-limited
// goal can be replaced, paused, or rescued by raising the budget.
//
// The desktop GoalController must behave the same: a budget-limited goal is a
// live goal, not "no goal". Driving the real base GoalRuntime here keeps the
// reproduction honest — the state under test comes from the base state machine,
// not from a hand-written fixture.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/goal-budget-limited.test.ts
//
// Import order matters: host/goal.ts pulls in bootstrap.ts, which runs
// setProfile before the SDK graph loads (the profile red line). Keep it first.
import { GoalController, type GoalSession } from "../host/goal.ts";
import { sessionModeState } from "../host/mode-state.ts";
import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";

const BUDGET = 10;

function harness() {
  const settings = Settings.isolated({ "goal.enabled": true });
  let state: GoalModeState | undefined;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const outputs: string[] = [];
  const runtime = new GoalRuntime({
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    getCurrentUsage: () => usage,
    emit: () => {},
    persist: () => {},
    sendHiddenMessage: async () => {},
  });
  const session = {
    getGoalModeState: () => state,
    setGoalModeState: (next: GoalModeState | undefined) => {
      state = next;
    },
    getPlanModeState: () => undefined,
    getVibeModeState: () => undefined,
    getEnabledToolNames: () => ["read"],
    setActiveToolsByName: () => {},
    settings,
    goalRuntime: runtime,
    sessionManager: {
      appendModeChange: () => {},
      appendCustomEntry: () => {},
      buildSessionContext: () => ({ mode: state?.enabled ? "goal" : "goal_paused", modeData: { goal: state?.goal } }),
    },
    promptCustomMessage: async () => {},
    sendGoalModeContext: async () => {},
    isStreaming: false,
    isCompacting: false,
    hasPostPromptWork: false,
    getSessionStats: () => ({ cost: 0 }),
  } as unknown as GoalSession;
  const controller = new GoalController({ session, output: (text) => outputs.push(text), onChange: () => {} });

  return {
    controller,
    session,
    outputs,
    state: () => state,
    /** Create a goal with a token budget, then burn it in one turn so the base runtime flips it to budget-limited. */
    async createBudgetLimitedGoal(objective = "original") {
      await runtime.createGoal({ objective, tokenBudget: BUDGET });
      const baseline = { ...usage };
      usage = { ...usage, input: usage.input + BUDGET };
      await runtime.onTurnStart("turn-1", baseline);
      await runtime.onAgentEnd({ turnCompleted: true, currentUsage: () => usage });
    },
  };
}

describe("budget-limited goal", () => {
  test("the base runtime keeps it enabled and flips only the status", async () => {
    const h = harness();
    await h.createBudgetLimitedGoal();
    expect(h.state()?.goal.status).toBe("budget-limited");
    expect(h.state()?.enabled).toBe(true);
  });

  test("/goal set replaces it instead of starting from scratch", async () => {
    const h = harness();
    await h.createBudgetLimitedGoal();
    const objective = await h.controller.handleCommand("set fresh objective");
    expect(objective).toBe("fresh objective");
    expect(h.state()?.goal.objective).toBe("fresh objective");
    expect(h.state()?.goal.status).toBe("active");
    expect(h.state()?.enabled).toBe(true);
    expect(h.state()?.goal.tokensUsed).toBe(0);
  });

  test("/goal budget <N> rescues it back to active", async () => {
    const h = harness();
    await h.createBudgetLimitedGoal();
    await h.controller.handleCommand(`budget ${BUDGET * 10}`);
    expect(h.state()?.goal.status).toBe("active");
    expect(h.state()?.enabled).toBe(true);
    expect(h.state()?.goal.tokenBudget).toBe(BUDGET * 10);
  });

  test("/goal pause pauses it", async () => {
    const h = harness();
    await h.createBudgetLimitedGoal();
    await h.controller.handleCommand("pause");
    expect(h.state()?.goal.status).toBe("paused");
    expect(h.state()?.enabled).toBe(false);
  });

  test("bare /goal reports it as a live goal, not as usage help", async () => {
    const h = harness();
    await h.createBudgetLimitedGoal();
    await h.controller.handleCommand("");
    expect(h.outputs.at(-1)).not.toContain("/goal <objective>");
  });

  test("the mode projection keeps reporting active", async () => {
    const h = harness();
    await h.createBudgetLimitedGoal();
    expect(sessionModeState(h.session).goal).toMatchObject({ status: "active", objective: "original" });
  });
});
