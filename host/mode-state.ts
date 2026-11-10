// Session-mode snapshot shared by ctx.sessionModes (mode-control.ts) and the desktop's own
// mode controllers (plan.ts / goal.ts): one state shape, one place that reports `mode_changed`
// to extension observers, whichever source flipped the mode.
import type { SessionModeState } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

/** The mode-related face of AgentSession this module reads (structural typing at the boundary). */
export interface ModeSessionLike {
  getPlanModeState(): { enabled?: boolean; planFilePath?: string } | undefined;
  getGoalModeState():
    | { enabled: boolean; mode: "active" | "exiting"; goal: { objective: string; status: string; tokenBudget?: number } }
    | undefined;
  getVibeModeState(): { enabled: boolean } | undefined;
  extensionRunner?: { emit(event: unknown): Promise<unknown> } | null;
}

/** Detached snapshot of the desktop's built-in modes. Vibe/loop have no desktop surface. */
export function sessionModeState(s: ModeSessionLike): SessionModeState {
  const plan = s.getPlanModeState();
  const goal = s.getGoalModeState();
  const goalActive = goal !== undefined && (goal.enabled || goal.mode === "exiting");
  return {
    plan: plan?.enabled === true ? { status: "active", planFilePath: plan.planFilePath } : { status: "inactive" },
    vibe: s.getVibeModeState()?.enabled === true ? { status: "active" } : { status: "inactive" },
    goal:
      goalActive && goal !== undefined
        ? { status: "active", objective: goal.goal.objective, tokenBudget: goal.goal.tokenBudget }
        : goal !== undefined && goal.goal.status === "paused"
          ? { status: "paused", objective: goal.goal.objective, tokenBudget: goal.goal.tokenBudget }
          : { status: "inactive" },
    loop: { status: "inactive" },
  };
}

// Last state reported per session: mode reads happen on every turn end, and only an actual
// change may reach extension handlers (same dedupe as the TUI's #reportedModeKey).
const INACTIVE: SessionModeState = {
  plan: { status: "inactive" },
  vibe: { status: "inactive" },
  goal: { status: "inactive" },
  loop: { status: "inactive" },
};
const reported = new WeakMap<ModeSessionLike, string>();

/** Emit `mode_changed` when the session's mode snapshot differs from the last reported one. */
export function reportModeChange(s: ModeSessionLike): void {
  const state = sessionModeState(s);
  const key = JSON.stringify(state);
  const previousKey = reported.get(s) ?? JSON.stringify(INACTIVE);
  if (previousKey === key) return;
  reported.set(s, key);
  const previous = JSON.parse(previousKey) as SessionModeState;
  void s.extensionRunner?.emit({ type: "mode_changed", previous, state: structuredClone(state) });
}
