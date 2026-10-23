// Permission mode menu (ported from the old static rows of index.html
// #modeMenu + composer.js click bindings): the omp permission modes
// always-ask | always-ask-cached | write | yolo. Selection goes through the
// host (with sessionId when in a session), with a local optimistic update of
// approvalMode (the old setApprovalModeUi); the host's approval_mode frame
// confirms afterwards.
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useAppStore, setBump, send } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import type { ApprovalMode } from "../../types/frames";
import { placeComposerMenu } from "./place";

type ModeMeta = { label: string; icon: string; yolo: boolean };

// Mode metadata (ported from the old composer.js MODE_META; button states reuse
// it too). label/desc are getters so the
// module-level constants re-read the active language on every access (tree re-mounts on lang switch).
export const MODE_META: Record<ApprovalMode, ModeMeta> = {
  "always-ask": { get label() { return t("composer.modeAlwaysAsk"); }, icon: "permAsk", yolo: false },
  "always-ask-cached": { get label() { return t("composer.modeAlwaysAskCached"); }, icon: "memory", yolo: false },
  write: { get label() { return t("composer.modeWrite"); }, icon: "permDefault", yolo: false },
  yolo: { get label() { return t("composer.modeYolo"); }, icon: "shieldWarn", yolo: true },
};

/**
 * Derived fourth row: `write` plus the LLM gate (autoReview) in front of the
 * cards that still appear (exec tier keeps prompting). It cannot be a real
 * ApprovalMode: the base maps unknown values to "yolo"
 * (packages/coding-agent/src/tools/approval.ts), so the pair
 * (mode=write, autoReview=on) is the only safe encoding. Rendered only while
 * the experimental switch is on; picking a plain mode turns the gate off so the
 * two rows stay mutually exclusive.
 */
const SMART = "smart" as const;
export const SMART_MODE: ModeMeta = {
  get label() { return t("composer.modeSmart"); },
  icon: "think",
  yolo: false,
};

type ModeMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ModeMenu({ btnRef, composerRef, onClose }: ModeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const approvalMode = useAppStore((st) => st.approvalMode);
  const newSessionPlanMode = useAppStore((st) => st.newSessionPlanMode);
  const planOn = s ? !!s.planMode : newSessionPlanMode;
  // The experimental page's switch only offers the row; the gate itself rides
  // approvalMode === "write" (autoReviewEnabled, written by pickMode).
  const autoReviewOffered = useAppStore((st) => st.hostSettings?.autoReviewOfferMode === true);
  const autoReview = useAppStore((st) => st.hostSettings?.autoReviewEnabled === true);
  // write + LLM gate is what the "smart approval" row means; the plain write
  // row must not also look selected while it is on
  const smartOn = approvalMode === "write" && autoReview;
  const rows: (ApprovalMode | typeof SMART)[] = autoReviewOffered
    ? ["always-ask", "always-ask-cached", "write", SMART, "yolo"]
    : ["always-ask", "always-ask-cached", "write", "yolo"];
  // Position on mount (the old openComposerMenu: positioned once when opened)
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const pickMode = (mode: ApprovalMode | typeof SMART) => {
    // Writes only the gate; the experimental page's "offer the row" switch is
    // never touched here, so picking a plain mode keeps the row visible.
    if (autoReview !== (mode === SMART)) send({ type: "set_auto_review", enabled: mode === SMART });
    const target: ApprovalMode = mode === SMART ? "write" : mode;
    if (s) send({ type: "set_approval_mode", sessionId: s.sessionId, mode: target });
    else send({ type: "set_approval_mode", mode: target });
    setBump({ approvalMode: target });
    onClose();
  };

  // Plan mode: inside a session it toggles the live mode via the host; on the
  // new-session page it flips the local intent consumed by create_session
  const togglePlan = () => {
    if (s) send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: !planOn });
    else setBump({ newSessionPlanMode: !newSessionPlanMode });
    onClose();
  };

  return (
    <div className="menu mode open" id="modeMenu" ref={menuRef}>
      <div className="mi big" id="planModeRow" onClick={togglePlan} title={t("composer.planModeHint")}>
        <span className="mi-ic"><Icon name="plan" /></span>
        <span className="mi-tx"><span className="mi-tt">{t("composer.planMode")}</span></span>
        <span className="ck">{planOn ? "✓" : ""}</span>
      </div>
      <div className="mode-sep"></div>
      {rows.map((mode) => {
        const meta = mode === SMART ? SMART_MODE : MODE_META[mode];
        const checked = mode === SMART ? smartOn : approvalMode === mode && !smartOn;
        return (
          <div className="mi big" data-mode={mode} key={mode} onClick={() => pickMode(mode)}>
            <span className="mi-ic"><Icon name={meta.icon} /></span>
            <span className="mi-tx"><span className="mi-tt">{meta.label}</span></span>
            <span className="ck">{checked ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
