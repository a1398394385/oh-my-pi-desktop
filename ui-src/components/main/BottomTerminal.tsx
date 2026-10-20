// Bottom dock (⌘/Ctrl+J): terminal-only panel spanning the center column.
// Its head IS the tab strip: each tab is one independent terminal (no nested terminal tabs),
// same shape as the right panel where every terminal is its own panel tab.
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { useAppStore } from "../../store";
import TerminalPage from "./right/TerminalPage";
import {
  useBottomTermTabs, addBottomTermTab, activateBottomTermTab, closeBottomTermTab, termGroupKey,
} from "./right/termTabs";

export default function BottomTerminal() {
  const { t } = useTranslation();
  // Group key flips with the sharing pref/session: one strip per project when shared,
  // the historical global strip otherwise
  const groupKey = useAppStore(() => termGroupKey());
  const tabs = useBottomTermTabs(groupKey);
  return (
    <div id="bottom-panel">
      <div className="bpanel-head">
        <Icon name="termBox" size={14} />
        <div className="tpane-tabs">
          {tabs.ids.map((id) => (
            <button
              key={id}
              type="button"
              className={"rtab" + (id === tabs.active ? " on" : "")}
              onClick={() => activateBottomTermTab(groupKey, id)}
            >
              <span className="rtab-tx">{t("misc.terminalTab", { n: Number(id.slice(1)) || 1 })}</span>
              {tabs.ids.length > 1 && (
                <span
                  className="rtab-x"
                  title={t("common.close")}
                  onClick={(e) => { e.stopPropagation(); closeBottomTermTab(groupKey, id); }}
                >
                  <Icon name="xmark" size={12} />
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="icon-btn tpane-tab-add"
            title={t("misc.newTerminalTab")}
            onClick={() => addBottomTermTab(groupKey)}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          title={t("common.close")}
          onClick={() => useAppStore.getState().toggleBottomTerminal()}
        >
          <Icon name="xmark" size={14} />
        </button>
      </div>
      <TerminalPage scope="bottom" tabId={tabs.active} />
    </div>
  );
}
