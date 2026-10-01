import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ProvidersPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-providers">
      <div className="set-tt">{t("settingsPage.nav.providers")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-providers"]} />
    </div>
  );
}
