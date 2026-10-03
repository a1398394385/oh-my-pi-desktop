// Think level menu (ported from the old composer.js buildThinkMenu + click
// bindings): lists only tiers supported by the current model (the original
// English low/medium/...; auto/off are filled in by the store).
// With a session it goes through the host; creating-new state lands in
// newSessionThinking + localStorage.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, getSupportedThinkingForModel, pickThinkingLevel } from "../../store";
import { placeComposerMenu } from "./place";

type ThinkMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ThinkMenu({ btnRef, composerRef, onClose }: ThinkMenuProps) {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const newSessionThinking = useAppStore((st) => st.newSessionThinking);
  // No-assignment subscription: the tier catalog swaps its Map reference when
  // the models/ready frame arrives, so subscribing to the reference re-renders
  // after a catalog refresh (getSupportedThinkingForModel reads the latest
  // table via getState internally)
  useAppStore((st) => st.modelEfforts);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);
  // Drop the shift+tab auto-open flag on unmount so a pending auto-close
  // timer (keys.ts) cannot close a freshly manually reopened menu
  useEffect(
    () => () => {
      if (useAppStore.getState().thinkMenuAuto) useAppStore.setState({ thinkMenuAuto: false });
    },
    [],
  );

  const levels: string[] = getSupportedThinkingForModel(s?.model || newSessionModel);
  const curThinking = s?.thinking || newSessionThinking;

  const pickLevel = (lv: string) => {
    pickThinkingLevel(lv);
    onClose();
  };

  return (
    <div className="menu open" id="thinkMenu" ref={menuRef}>
      <div className="mh">{t("composer.reasoning")}</div>
      {levels.map((lv) => (
        <div className="mi" data-level={lv} key={lv} onClick={() => pickLevel(lv)}>
          <span className="ck">{curThinking === lv ? "✓" : ""}</span>{lv}
        </div>
      ))}
    </div>
  );
}
