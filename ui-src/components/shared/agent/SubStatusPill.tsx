// Subagent status capsule: text pill shown left of the card title (running = blue,
// completed = green, failed = red, aborted = neutral). Shared by the Agent Hub roster
// rows (HubRow) and the subagent tab's cards (SubCard) — one look on both surfaces.
import { useTranslation } from "react-i18next";
import { subStatus, ST_GROUP, ST_KEY } from "./subShared";
import type { SubagentState } from "../../../types/session";

export function SubStatusPill({ sub }: { sub: SubagentState }) {
  const { t } = useTranslation();
  const st = ST_GROUP[subStatus(sub)] ?? "running";
  return <span className={"sub-st st-" + st}>{t(ST_KEY[st])}</span>;
}
