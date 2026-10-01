// 设置页：电脑控制（pg-computer）。tgComputer 开关：写宿主机 computer.enabled。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-computer">，
// 绑定参照 ui/settings/index.js initSettings 的 wireToggle("tgComputer")。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ComputerPage() {
  const { t } = useTranslation();
  const hs = useAppStore((s) => s.hostSettings);
  const [on, setOn] = useState(!!hs?.computerEnabled); // 初值布尔，类型可推断
  // settings 回包后同步开关态
  useEffect(() => {
    setOn(!!useAppStore.getState().hostSettings?.computerEnabled);
  }, [hs]);
  const toggle = (): void => {
    const next = !on;
    setOn(next);
    send({ type: "set_setting", key: "computer.enabled", value: next });
    toast(t("settingsPage.computer.writtenToast"));
  };
  return (
    <div className="set-page" id="pg-computer">
      <div className="set-tt">{t("settingsPage.nav.computer")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.computer.enableTitle")}</b><span>{t("settingsPage.computer.enableDesc")}</span></div>
          <div className={"tg" + (on ? " on" : "")} id="tgComputer" onClick={toggle}><i></i></div>
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-computer"]} />
    </div>
  );
}
