import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ContextPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-context">
      <div className="set-tt">{t("settingsPage.nav.context")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-context"]} />
    </div>
  );
}
