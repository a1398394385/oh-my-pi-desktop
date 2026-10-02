// Settings page: browser control (pg-browser). Pure static placeholder page (set-note copied from the old DOM).
// Old reference: <div class="set-page" id="pg-browser"> in git show 464131d:ui/index.html.
import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function BrowserPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-browser">
      <div className="set-tt">{t("settingsPage.nav.browser")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-browser"]} />
    </div>
  );
}
