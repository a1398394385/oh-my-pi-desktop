// Settings page: computer control (pg-computer). tgComputer toggle: writes host computer.enabled.
// Old reference: <div class="set-page" id="pg-computer"> in git show 464131d:ui/index.html,
// binding per wireToggle("tgComputer") in ui/settings/index.js initSettings.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ComputerPage() {
  const { t } = useTranslation();
  const hs = useAppStore((s) => s.hostSettings);
  const [on, setOn] = useState(!!hs?.computerEnabled); // boolean initial value, type inferable
  // Sync the toggle state after the settings reply
  useEffect(() => {
    setOn(!!useAppStore.getState().hostSettings?.computerEnabled);
  }, [hs]);
  const toggle = (): void => {
    const next = !on;
    setOn(next);
    send({ type: "set_setting", key: "computer.enabled", value: next });
    toast(t("settingsPage.computer.writtenToast"));
  };
  return (
    <div className="set-page" id="pg-computer">
      <div className="set-tt">{t("settingsPage.nav.computer")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.computer.enableTitle")}</b><span>{t("settingsPage.computer.enableDesc")}</span></div>
          <div className={"tg" + (on ? " on" : "")} id="tgComputer" onClick={toggle}><i></i></div>
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-computer"]} />
    </div>
  );
}
