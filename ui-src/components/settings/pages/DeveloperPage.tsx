// Developer page: low-level runtime knobs aggregated from the advanced page and
// the tools page — auto QA reporting (dev.*), blob/session garbage collection
// (gc.*), and the ui-less compaction tuning keys. The user-facing compaction
// switches live on the Context page's Compaction group; they are not duplicated.
import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function DeveloperPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-developer">
      <div className="set-tt">{t("settingsPage.nav.developer")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-developer"]} />
    </div>
  );
}
