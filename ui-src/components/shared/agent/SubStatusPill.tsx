// Subagent status capsule: text pill shown left of the card title (running = blue,
// completed = green, failed = red, aborted = neutral). Shared by the Agent Hub roster
// rows (HubRow) and the subagent tab's cards (SubCard) — one look on both surfaces.
import { useTranslation } from "react-i18next";
import { subStatus } from "./subShared";
import type { SubagentState } from "../../../types/session";

// "started" (lifecycle register, before the first progress heartbeat) renders as
// running — the same grouping STATUS_ORDER already uses.
const ST_GROUP: Record<string, "running" | "completed" | "failed" | "aborted"> = {
  started: "running",
  running: "running",
  completed: "completed",
  failed: "failed",
  aborted: "aborted",
};

const ST_KEY: Record<string, string> = {
  running: "right.subStRunning",
  completed: "right.subStCompleted",
  failed: "right.subStFailed",
  aborted: "right.subStAborted",
};

export function SubStatusPill({ sub }: { sub: SubagentState }) {
  const { t } = useTranslation();
  const st = ST_GROUP[subStatus(sub)] ?? "running";
  return (
    <span className={"sub-st st-" + st}>
      {t(ST_KEY[st])}
    </span>
  );
}
