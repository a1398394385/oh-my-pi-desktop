import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function InteractionPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-interaction">
      <div className="set-tt">{t("settingsPage.nav.interaction")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-interaction"]} />
    </div>
  );
}
