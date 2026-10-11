import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { useAppStore, send } from "../../../store";

export default function ProvidersPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const known = typeof hostSettings?.kimiAutoThinking === "boolean";
  const on = known && !!hostSettings?.kimiAutoThinking;
  return (
    <div className="set-page" id="pg-providers">
      <div className="set-tt">{t("settingsPage.nav.providers")}</div>
      <div className="set-group-tt">{t("settingsPage.providers.kimiGroup")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.providers.kimiAutoThinking")}</b>
            <span>{t("settingsPage.providers.kimiAutoThinkingDesc")}</span>
          </div>
          <div
            className={"tg" + (on ? " on" : "") + (known ? "" : " disabled")}
            id="tgKimiAutoThinking"
            onClick={() => send({ type: "set_kimi_auto_thinking", enabled: !on })}
          >
            <i></i>
          </div>
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-providers"]} />
    </div>
  );
}
