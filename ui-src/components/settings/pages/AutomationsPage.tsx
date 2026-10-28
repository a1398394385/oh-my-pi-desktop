// Settings page: automations (pg-automations), opened from the gear on the
// Automations list header. Desktop-owned config only — the rows are hand
// written (not SchemaRows) because omp-desktop.json fields are not part of the
// base settings registry, same as the experimental page's rows.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import { Toggle } from "../common";

export default function AutomationsPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const known = typeof hostSettings?.automationAgentEnabled === "boolean";
  const enabled = known && !!hostSettings?.automationAgentEnabled;
  // Unattended-run dialog deadlines (seconds): the host applies them to every
  // automation-spawned session, both ask dialogs and permission approvals.
  const timeouts = useAppStore((s) => s.hostSettings?.automationDialogTimeouts);
  const [askSec, setAskSec] = useState("");
  const [approvalSec, setApprovalSec] = useState("");
  useEffect(() => {
    if (!timeouts) return;
    setAskSec(String(timeouts.askSec));
    setApprovalSec(String(timeouts.approvalSec));
  }, [timeouts]);

  // One RPC writes both deadlines, so any blur commits the pair (the edited field from
  // the event, the other from state). Invalid text stays in the box with a toast instead
  // of snapping back to the host value.
  const commitTimeouts = (next: { ask?: string; approval?: string }) => {
    const askRaw = next.ask ?? askSec;
    const approvalRaw = next.approval ?? approvalSec;
    const ask = Math.floor(Number(askRaw));
    const approval = Math.floor(Number(approvalRaw));
    // Empty reads as 0 through Number(), and 0 means "never time out" — reject it instead
    // of silently disabling the unattended-run deadline.
    if (askRaw.trim() === "" || approvalRaw.trim() === "" || !Number.isFinite(ask) || !Number.isFinite(approval) || ask < 0 || approval < 0) {
      toast(t("settingsPage.auto.timeoutInvalid"));
      return;
    }
    if (ask === timeouts?.askSec && approval === timeouts.approvalSec) return;
    send({ type: "set_automation_dialog_timeouts", askSec: ask, approvalSec: approval });
  };

  return (
    <div className="set-page" id="pg-automations">
      <div className="set-tt">{t("settingsPage.nav.automations")}</div>

      <div className="set-group-tt">{t("settingsPage.auto.agentGroup")}</div>
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

      <div className="set-group-tt">{t("settingsPage.auto.timeoutGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.auto.timeoutGroupDesc")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.auto.askTimeoutTitle")}</b>
            <span>{t("settingsPage.auto.askTimeoutDesc")}</span>
          </div>
          <div className="srow-ctl">
            <input className="inp" style={{ width: 100, minWidth: 0 }} type="number" min="0" step="1"
              value={askSec} disabled={!timeouts} onChange={(e) => setAskSec(e.target.value)}
              onBlur={(e) => commitTimeouts({ ask: e.target.value })} />
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.auto.approvalTimeoutTitle")}</b>
            <span>{t("settingsPage.auto.approvalTimeoutDesc")}</span>
          </div>
          <div className="srow-ctl">
            <input className="inp" style={{ width: 100, minWidth: 0 }} type="number" min="0" step="1"
              value={approvalSec} disabled={!timeouts} onChange={(e) => setApprovalSec(e.target.value)}
              onBlur={(e) => commitTimeouts({ approval: e.target.value })} />
          </div>
        </div>
      </div>
    </div>
  );
}
