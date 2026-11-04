// Settings · advisor section (rendered inside the model config page). Two switches:
// the master one is the base's global advisor.enabled (it seeds every new session and
// applies live to open ones through the base listener); the default-on one is
// desktop-owned (omp-desktop.json advisor.defaultEnabled) and only decides what a
// *fresh* session starts with. The tuning rows stay behind the base's own condition
// (ui.condition = advisorEnabled), so they appear as soon as the master switch is on.
import { useTranslation } from "react-i18next";
import { SchemaGroupTitle, SchemaRowsBare } from "../SchemaRows";
import { useAppStore, send } from "../../../store";
import { Srow, Toggle } from "../common";
import type { Section } from "../placement";

export default function AdvisorSection({ sections }: { sections: Section[] }) {
  const { t } = useTranslation();
  const hs = useAppStore((s) => s.hostSettings);
  const masterKnown = typeof hs?.values?.["advisor.enabled"] === "boolean";
  const masterOn = hs?.values?.["advisor.enabled"] === true;
  const defaultKnown = typeof hs?.advisorDefaultEnabled === "boolean";
  const defaultOn = hs?.advisorDefaultEnabled === true;
  return (
    <>
      <SchemaGroupTitle sections={sections} />
      <div className="set-card">
        <Srow title={t("settingsPage.advisor.masterTitle")} desc={t("settingsPage.advisor.masterDesc")}>
          <Toggle
            on={masterOn}
            disabled={!masterKnown}
            onChange={() => send({ type: "set_setting", key: "advisor.enabled", value: !masterOn })}
          />
        </Srow>
        <Srow title={t("settingsPage.advisor.defaultTitle")} desc={t("settingsPage.advisor.defaultDesc")}>
          <Toggle
            on={defaultOn}
            disabled={!defaultKnown}
            onChange={() => send({ type: "set_advisor_default", enabled: !defaultOn })}
          />
        </Srow>
        <SchemaRowsBare sections={sections} />
      </div>
    </>
  );
}
