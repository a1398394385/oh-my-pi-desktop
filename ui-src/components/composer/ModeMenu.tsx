// 权限模式菜单（原 index.html #modeMenu 静态三行 + composer.js 点击绑定平移）：
// omp 三值 always-ask | write | yolo。选中走宿主下发（有会话带 sessionId），
// 本地乐观更新 approvalMode（原 setApprovalModeUi），宿主 approval_mode 帧再确认。
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useAppStore, setBump, send } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";

// omp 权限模式三值（宿主 approval_mode 帧同此集合）
export type ApprovalMode = "always-ask" | "write" | "yolo";

type ModeMeta = { label: string; icon: string; yolo: boolean };

// 模式元信息（原 composer.js MODE_META 平移；按钮态也复用）。label/desc are getters so the
// module-level constants re-read the active language on every access (tree re-mounts on lang switch).
export const MODE_META: Record<ApprovalMode, ModeMeta> = {
  "always-ask": { get label() { return t("composer.modeAlwaysAsk"); }, icon: "permAsk", yolo: false },
  write: { get label() { return t("composer.modeWrite"); }, icon: "permDefault", yolo: false },
  yolo: { get label() { return t("composer.modeYolo"); }, icon: "shieldWarn", yolo: true },
};

const ROWS: { mode: ApprovalMode; desc: string }[] = [
  { mode: "always-ask", get desc() { return t("composer.modeAlwaysAskDesc"); } },
  { mode: "write", get desc() { return t("composer.modeWriteDesc"); } },
  { mode: "yolo", get desc() { return t("composer.modeYoloDesc"); } },
];

type ModeMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ModeMenu({ btnRef, composerRef, onClose }: ModeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const approvalMode = useAppStore((st) => st.approvalMode);
  const planOn = !!s?.planMode;
  // 挂载即定位（原 openComposerMenu：打开时定位一次）
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const pickMode = (mode: ApprovalMode) => {
    if (s) send({ type: "set_approval_mode", sessionId: s.sessionId, mode });
    else send({ type: "set_approval_mode", mode });
    setBump({ approvalMode: mode });
    onClose();
  };

  // 计划模式：仅在有会话时可切（模式状态挂在会话上）；置位由宿主 plan_mode 帧确认
  const togglePlan = () => {
    if (!s) return;
    send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: !planOn });
    onClose();
  };

  return (
    <div className="menu mode open" id="modeMenu" ref={menuRef}>
      <div className={"mi big" + (s ? "" : " off")} id="planModeRow" onClick={togglePlan} title={s ? t("composer.planModeHint") : t("composer.planModeNeedSession")}>
        <span className="mi-ic"><Icon name="plan" /></span>
        <span className="mi-tx">
          <span className="mi-tt">{t("composer.planMode")}</span>
          <span className="mi-desc">{t("composer.planModeDesc")}</span>
        </span>
        <span className="ck">{planOn ? "✓" : ""}</span>
      </div>
      <div className="mode-sep"></div>
      {ROWS.map(({ mode, desc }) => {
        const meta = MODE_META[mode];
        return (
          <div className="mi big" data-mode={mode} key={mode} onClick={() => pickMode(mode)}>
            <span className="mi-ic"><Icon name={meta.icon} /></span>
            <span className="mi-tx"><span className="mi-tt">{meta.label}</span><span className="mi-desc">{desc}</span></span>
            <span className="ck">{approvalMode === mode ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
