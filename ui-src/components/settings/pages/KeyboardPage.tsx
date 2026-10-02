// Settings page: keyboard shortcuts (pg-keyboard). Entries come from the ui-src/keys.js
// registry — display and binding share one source; keys align with the omp CLI (keys bound
// inside components are also registered there; this page is read-only).
import { useTranslation } from "react-i18next";
import { SHORTCUT_GROUPS } from "../../../keys";

// Entry shape of the keys.js registry (untyped; narrowed by literal)
interface ShortcutItem {
  keys: string[]; // keycap display
  label: string;
}
interface ShortcutGroup {
  title: string;
  desc: string;
  items: ShortcutItem[];
}
const GROUPS = SHORTCUT_GROUPS as ShortcutGroup[];

export default function KeyboardPage() {
  const { t } = useTranslation();
  return (
    <div className="set-page" id="pg-keyboard">
      <div className="set-tt">{t("settingsPage.nav.keyboard")}</div>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="set-group-tt">{g.title}</div>
          <div className="set-group-desc">{g.desc}</div>
          <div className="set-card">
            {g.items.map((it) => (
              <div className="srow" key={it.label + it.keys.join("")}>
                <div className="srow-tx"><b>{it.label}</b></div>
                <div className="sc-keys">
                  {it.keys.map((k, i) => <span className="sc-key" key={i}>{k}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
