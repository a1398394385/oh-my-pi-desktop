// Settings page: automations (pg-automations), opened from the gear on the
// Automations list header. One desktop-owned switch — the toggle row is hand
// written (not SchemaRows) because omp-desktop.json fields are not part of the
// base settings registry, same as the experimental page's rows.
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import { Toggle } from "../common";

export default function AutomationsPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const known = typeof hostSettings?.automationAgentEnabled === "boolean";
  const enabled = known && !!hostSettings?.automationAgentEnabled;
  return (
    <div className="set-page" id="pg-automations">
      <div className="set-tt">{t("settingsPage.nav.automations")}</div>

      <div className="set-group-tt">{t("settingsPage.auto.agentGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.auto.agentGroupDesc")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              {t("settingsPage.auto.agentTitle")}
              <span className="srow-wn-inline">{t("settingsPage.auto.restartWarn")}</span>
            </b>
            <span>{t("settingsPage.auto.agentDesc")}</span>
          </div>
          <Toggle
            on={enabled}
            disabled={!known}
            onChange={() => send({ type: "set_automation_agent_enabled", enabled: !enabled })}
          />
        </div>
      </div>
    </div>
  );
}
