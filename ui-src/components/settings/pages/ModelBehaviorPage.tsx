import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ModelBehaviorPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-model-behavior">
      <div className="set-tt">{t("settingsPage.nav.modelBehavior")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-model-behavior"]} />
    </div>
  );
}
