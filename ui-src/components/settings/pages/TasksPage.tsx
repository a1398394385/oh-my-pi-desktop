import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function TasksPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-tasks">
      <div className="set-tt">{t("settingsPage.nav.tasks")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-tasks"]} />
    </div>
  );
}
