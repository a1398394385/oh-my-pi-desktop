// ctx.sessionModes: extension-driven plan/goal transitions over the desktop's own controllers.
// Vibe and loop are TUI-only surfaces the desktop never renders (no command, no indicator, no
// exit path), so those transitions are refused instead of committing a mode nobody can leave.
// Busy/conflict/disabled rules mirror the base TUI's #planSessionModeTransition.
import type {
  ExtensionSessionModes,
  SessionModeRequest,
  SessionModeResult,
  SessionModeState,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { setPlanMode } from "./plan.ts";
import { sessionModeState } from "./mode-state.ts";
import { settingsGet } from "./settings-compat.ts";
import { entryBus, type PoolEntry } from "./state.ts";

// A transition in flight: a second call from one of this transition's own handlers would deadlock.
const inFlight = new Set<string>();

export function createSessionModes(entry: PoolEntry, sessionId: string): ExtensionSessionModes {
  const state = (): SessionModeState => sessionModeState(entry.session);
  const refuse = (code: Extract<SessionModeResult, { ok: false }>["code"], message: string, current?: SessionModeState): SessionModeResult => ({
    ok: false,
    code,
    message,
    state: current ?? state(),
  });

  return {
    getState: state,
    async set(request: SessionModeRequest): Promise<SessionModeResult> {
      const s = entry.session;
      if (settingsGet(s.settings, "extensionHandlers.modeControl") !== true) {
        return refuse("disabled", "Extension mode control is disabled in settings (extensionHandlers.modeControl).");
      }
      if (inFlight.has(sessionId)) return refuse("busy", "Another mode transition is running; retry after it settles.");
      if (s.isStreaming || s.isCompacting) return refuse("busy", "The session is busy with a turn or compaction; retry once it is idle.");
      if (s.getGoalModeState()?.mode === "exiting") {
        return refuse("busy", "The completed goal is still being torn down; retry after its `mode_changed`.");
      }

      const previous = state();
      const invalid = (message: string) => refuse("invalid_request", message, previous);
      const conflict = (mode: string) => refuse("conflict", `Exit ${mode} mode first.`, previous);
      const planOn = s.getPlanModeState()?.enabled === true;
      const goalState = s.getGoalModeState();
      const goalOn = goalState?.enabled === true;
      const goalPaused = !goalOn && goalState?.goal.status === "paused";
      const vibeOn = s.getVibeModeState()?.enabled === true;
      let run: (() => Promise<void>) | undefined;

      switch (request.mode) {
        case "plan":
          if (request.action === "exit") {
            if (planOn) run = async () => setPlanMode(entryBus(entry), sessionId, entry, false);
          } else if (!planOn) {
            if (!settingsGet(s.settings, "plan.enabled")) {
              return refuse("disabled", "Plan mode is disabled in settings (plan.enabled).", previous);
            }
            if (goalOn || goalPaused) return conflict("goal");
            if (vibeOn) return conflict("vibe");
            run = async () => setPlanMode(entryBus(entry), sessionId, entry, true);
          }
          break;
        case "vibe":
          return refuse("disabled", "Vibe mode has no desktop surface.", previous);
        case "loop":
          return refuse("disabled", "Loop mode has no desktop surface.", previous);
        case "goal":
          switch (request.action) {
            case "enter": {
              const objective = typeof request.objective === "string" ? request.objective.trim() : "";
              if (!objective) return invalid("Goal objective must be a non-empty string.");
              const budget = request.tokenBudget;
              if (budget !== undefined && !(Number.isInteger(budget) && budget > 0)) {
                return invalid("Goal tokenBudget must be a positive integer.");
              }
              if (goalOn) {
                const current = goalState.goal;
                if (current.objective === objective && current.tokenBudget === budget) break;
                return invalid("A goal is already active; drop it before setting a new objective.");
              }
              if (goalPaused) return invalid("Resume or drop the paused goal first.");
              if (!settingsGet(s.settings, "goal.enabled")) {
                return refuse("disabled", "Goal mode is disabled in settings (goal.enabled).", previous);
              }
              if (planOn) return conflict("plan");
              if (vibeOn) return conflict("vibe");
              // The desktop controller prints the same command notice /goal does.
              run = async () => {
                await entry.goal.handleCommand(objective);
                if (budget !== undefined) await entry.goal.handleCommand(`budget ${budget}`);
              };
              break;
            }
            case "pause":
              if (goalOn) run = async () => void (await entry.goal.handleCommand("pause"));
              else if (!goalPaused) return invalid("There is no active goal to pause.");
              break;
            case "resume":
              if (goalOn) break;
              if (!goalPaused) return invalid("There is no paused goal to resume.");
              if (!settingsGet(s.settings, "goal.enabled")) {
                return refuse("disabled", "Goal mode is disabled in settings (goal.enabled).", previous);
              }
              run = async () => void (await entry.goal.handleCommand("resume"));
              break;
            case "drop":
              if (goalOn || goalPaused) run = async () => void (await entry.goal.handleCommand("drop"));
              break;
          }
          break;
      }

      if (!run) return { ok: true, changed: false, state: previous };
      inFlight.add(sessionId);
      try {
        await run();
      } finally {
        inFlight.delete(sessionId);
      }
      const next = state();
      return { ok: true, changed: JSON.stringify(next) !== JSON.stringify(previous), state: next };
    },
  };
}
