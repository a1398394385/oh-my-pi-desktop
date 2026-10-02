// Permission mode menu (ported from the old static three rows of index.html
// #modeMenu + composer.js click bindings): the three omp values
// always-ask | write | yolo. Selection goes through the host (with sessionId
// when in a session), with a local optimistic update of approvalMode (the old
// setApprovalModeUi); the host's approval_mode frame confirms afterwards.
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useAppStore, setBump, send } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";

// The three omp permission modes (the host approval_mode frame uses the same set)
export type ApprovalMode = "always-ask" | "write" | "yolo";

type ModeMeta = { label: string; icon: string; yolo: boolean };

// Mode metadata (ported from the old composer.js MODE_META; button states reuse
// it too). label/desc are getters so the
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
  // Position on mount (the old openComposerMenu: positioned once when opened)
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const pickMode = (mode: ApprovalMode) => {
    if (s) send({ type: "set_approval_mode", sessionId: s.sessionId, mode });
    else send({ type: "set_approval_mode", mode });
    setBump({ approvalMode: mode });
    onClose();
  };

  // Plan mode: switchable only inside a session (the mode state hangs on the
  // session); setting is confirmed by the host's plan_mode frame
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
