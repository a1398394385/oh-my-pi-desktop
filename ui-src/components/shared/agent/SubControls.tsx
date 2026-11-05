// Subagent card controls (18.5 subagent-control surface): the stop / open pair for streaming
// agents. Shared by the Agent Hub roster rows and the subagent tab's cards — same icons at the
// same sizes on both surfaces (stopSolid / chevronRight). Open hands off to
// openSubagentSession (subRoster), so the button lands where Enter and double-click already do.
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { sendSubagentControl } from "./hubExt";

/** Stop / open button pair (rendered only while the agent streams; clicks never select the row) */
export function SubControls({ sessionId, agentId, onOpen }: { sessionId: string; agentId: string; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="hub-row-acts" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="hub-ibtn"
        title={t("hubExt.stopSub")}
        onClick={() => sendSubagentControl(sessionId, agentId, "cancel")}
      >
        <Icon name="stopSolid" size={12} />
      </button>
      <button type="button" className="hub-ibtn" title={t("hubExt.openSub")} onClick={onOpen}>
        <Icon name="chevronRight" size={14} />
      </button>
    </span>
  );
}
