import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function FilesPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-files">
      <div className="set-tt">{t("settingsPage.nav.files")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-files"]} />
    </div>
  );
}
