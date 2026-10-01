import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ToolsPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-tools">
      <div className="set-tt">{t("settingsPage.nav.tools")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-tools"]} />
    </div>
  );
}
