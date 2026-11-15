// Settings · Skills: multi-select dropdown for skills.manualSkills. Values are skill names
// (the base matches them as globs). The trigger shows the selected count; the menu lists every
// discovered skill grouped by profile / project so same-named skills stay distinguishable.
// Toggling a row keeps the menu open; an outside click closes it through the shared slot.
import { useState } from "react";
import type { ReactElement } from "react";
import { useAppStore, send } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import { useDropdownClose } from "./common";
import { SETTINGS_ZH } from "../../i18n/locales/settings-zh-CN";
import { SETTINGS_EN } from "../../i18n/locales/settings-en";

interface SkillItem {
  name: string;
  path: string;
  enabled: boolean;
  description?: string;
}

interface SkillProject {
  cwd: string;
  name: string;
  skills?: SkillItem[];
}

interface SkillsData {
  profile?: SkillItem[];
  profileName?: string;
  projects?: SkillProject[];
}

export default function ManualSkillsPicker(): ReactElement {
  const raw = useAppStore((s) => s.hostSettings?.values["skills.manualSkills"]);
  const skills = useAppStore((s) => s.agentAssets)?.skills as SkillsData | null | undefined;
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const copy = (lang === "zh-CN" ? SETTINGS_ZH : SETTINGS_EN)["skills.manualSkills"];
  const [open, setOpen] = useState(false);
  useDropdownClose(open, () => setOpen(false));

  const selected = Array.isArray(raw) ? (raw as string[]) : [];
  const groups = [
    { key: "profile", label: skills?.profileName, items: skills?.profile ?? [] },
    ...(skills?.projects ?? []).map((p) => ({ key: p.cwd, label: p.name, items: p.skills ?? [] })),
  ].filter((g) => g.items.length > 0);

  const toggle = (name: string) => {
    const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
    send({ type: "set_setting", key: "skills.manualSkills", value: next });
  };

  // Same .srow shell as SchemaRows rows: the picker replaces that row, so it keeps the
  // label/description column and the control column aligned with its neighbours.
  const control =
    groups.length === 0 ? (
      <div className="sel disabled">{t("settingsPage.manualSkills.empty")}</div>
    ) : (
      <div
        className="sel"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {t("settingsPage.manualSkills.count", { count: selected.length })} <Icon name="caret" size={14} className="caret-svg" />
        <div className={"menu" + (open ? " open" : "")} onClick={(e) => e.stopPropagation()}>
          {groups.map((g) => (
            <div key={g.key}>
              {g.label && <div className="mh">{g.label}</div>}
              {g.items.map((item) => {
                const on = selected.includes(item.name);
                return (
                  <div key={item.path} className="mi" onClick={() => toggle(item.name)}>
                    <span className="mi-ck">{on ? <Icon name="check" size={14} /> : null}</span>
                    <span className="mi-tx">
                      <span className="mi-tt">{item.name}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="set-card">
      <div className="srow" data-key="skills.manualSkills">
        <div className="srow-tx">
          <b>{copy.label}</b>
          {copy.description && <span>{copy.description}</span>}
        </div>
        <div className="srow-ctl">{control}</div>
      </div>
    </div>
  );
}
