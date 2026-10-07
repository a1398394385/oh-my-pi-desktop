// Empty-state launcher (all right panel tabs closed, aligned with ZCode's side-pane empty
// state): centered icon + title/subtitle lines + entry button list (h-12 bars; the wide
// container switches to a two-column grid via container queries).
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import Icon from "../../../Icon";
import { TAB_META, openRightTab } from "./tabs";

export default function StartPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  return (
    <div className="rt-start">
      <span className="inline-flex items-center text-faint mb-3">
        <Icon name="panelRight" size={30} />
      </span>
      <div className="text-[length:20px] font-semibold leading-[28px] text-text" /* style-token-ignore */>{t("right.openTab")}</div>
      <div className="text-ui-base leading-5 text-dim mt-1 mb-5">{t("right.startSub")}</div>
      <div className="rt-list">
        {["subagent", "gitdiff", "file", "bgcmd", "tree", "terminal", "browser", "mirror"].map((name) => {
          const meta = TAB_META[name];
          const off = name === "gitdiff" && !s?.isGit;
          return (
            <button
              key={name}
              className={"rt-item" + (off ? " off" : "")}
              title={off ? t("right.notGitRepo") : undefined}
              onClick={off ? undefined : () => openRightTab(name)}
            >
              <span className="rt-item-ic">
                <Icon name={meta.icon} size={15} />
              </span>
              <span className="rt-item-tx">{t(meta.label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
