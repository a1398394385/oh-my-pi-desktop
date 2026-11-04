// Automations data-domain frames: scheduled-task list snapshots, manual-run receipts and
// editor schedule previews. All three are pure landing frames — every mutating automations_*
// RPC replies with a fresh automations_list built from the persisted store, so the UI always
// reconciles against what the host actually wrote (host/rpc/automations.ts).
import { useAppStore } from "../index";
import type { HandlerSlice } from "./types";

export const automationsHandlers = {
  automations_list(msg) {
    useAppStore.setState({ automations: msg.automations ?? [], automationRuns: msg.runs ?? {} });
  },
  automation_run_started() {
    // Manual dispatch accepted: the run ledger row (running → succeeded/failed) lands with the
    // next automations_list refresh; that row is the only confirmation.
  },
  automation_preview(msg) {
    useAppStore.setState({ automationPreview: msg.nextRunsAt ?? [] });
  },
} satisfies HandlerSlice;

// Domain key set (for the exhaustive-assertion cross-check in index)
export type AutomationsFrames = keyof typeof automationsHandlers;
