// Settings page: model config (pg-model). First row opens the model manager (catalog /
// roles / cycle order — the container's former page, reused as-is); the schema rows below
// are the model-behavior groups (formerly the separate pg-model-behavior page). The
// advisor group is hand written (two switches, AdvisorSection.tsx) and stays in place.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import AdvisorSection from "./AdvisorSection";
import ModelPage from "./ModelPage";

const SECTIONS = PAGE_PLACEMENT["pg-model"];
const ADVISOR_AT = SECTIONS.findIndex((s) => s.id === "advisor");
const BEFORE_ADVISOR = SECTIONS.slice(0, ADVISOR_AT);
const ADVISOR_SECTION = SECTIONS.slice(ADVISOR_AT, ADVISOR_AT + 1);
const AFTER_ADVISOR = SECTIONS.slice(ADVISOR_AT + 1);

export default function ModelSettingsPage() {
  const { t } = useTranslation();
  const [manager, setManager] = useState(false);
  if (manager) return <ModelPage onBack={() => setManager(false)} />;
  return (
    <div className="set-page" id="pg-model-settings">
      <div className="set-tt">{t("settingsPage.nav.model")}</div>
      <div className="set-card">
        <div className="srow set-row" data-key="models.manage">
          <div className="srow-tx">
            <b>{t("settingsPage.model.manageTitle")}</b>
            <span>{t("settingsPage.model.manageDesc")}</span>
          </div>
          <div className="srow-ctl">
            <button type="button" className="save-btn" onClick={() => setManager(true)}>
              {t("settingsPage.model.manageOpen")}
            </button>
          </div>
        </div>
      </div>
      <SchemaRows sections={BEFORE_ADVISOR} />
      <AdvisorSection sections={ADVISOR_SECTION} />
      <SchemaRows sections={AFTER_ADVISOR} />
    </div>
  );
}
