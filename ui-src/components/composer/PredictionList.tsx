// Composer prediction alternatives (host/prediction.ts) in the slash-command card's clothes:
// one "Predictions" tab listing every candidate the model returned. ↑↓ moves the highlight and
// writes that candidate into the composer as it moves; Tab, Enter and newline stay the editor's
// business (the card never claims them). Only a manual Esc closes it: typing and clicking a row
// leave it up (a click just applies that candidate).
// The card reuses PaletteMenu's DOM classes and placement helper, so it needs no CSS of its own.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store";
import { setPredictionOpen } from "../../store/session";
import { getDraftText } from "./lexical/draft";
import { placePaletteCard } from "./place";

type Props = {
  composerRef: RefObject<HTMLDivElement | null>;
  draftKey: string;
  onPick(text: string): void;
};

export default function PredictionList({ composerRef, draftKey, onPick }: Props) {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const choices = s?.prediction ?? null;
  const sessionId = s?.sessionId;
  const open = s?.predictionOpen === true;
  const menuRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  // Start on the candidate the draft already holds (that is why the card could open)
  useLayoutEffect(() => {
    if (!open) return;
    const at = choices?.indexOf(getDraftText(draftKey)) ?? -1;
    setIndex(at >= 0 ? at : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    placePaletteCard(composerRef.current, menuRef.current, 2.6);
  }, [open, choices, composerRef]);

  useEffect(() => {
    if (!open || !choices || !sessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const next = (index + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
        setIndex(next);
        // Switching also applies: the composer always holds the highlighted prediction
        const choice = choices[next];
        if (choice !== undefined) onPick(choice);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPredictionOpen(sessionId, false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, choices, index, sessionId, onPick]);

  if (!open || !choices || choices.length === 0) return null;
  return (
    <div className="menu palette open slash" ref={menuRef}>
      <div className="slash-tabs" role="tablist" aria-label={t("composer.predictionTab")}>
        <button type="button" role="tab" tabIndex={-1} className="slash-tab" aria-selected={true}>
          {t("composer.predictionTab")}
        </button>
      </div>
      <div className="slash-list" role="listbox" aria-label={t("composer.predictionTab")}>
        {choices.map((choice, i) => (
          <div
            key={choice}
            className={"mi" + (i === index ? " on" : "")}
            role="option"
            aria-selected={i === index}
            title={choice}
            onMouseEnter={() => setIndex(i)}
            onClick={() => onPick(choice)}
          >
            <span className="mi-tx">{choice}</span>
          </div>
        ))}
      </div>
      <div className="slash-footer">
        <span className="slash-hint">
          <kbd>↑↓</kbd>
          {t("composer.paletteSelect")}
        </span>
        <span className="slash-hint slash-close">
          <kbd>Esc</kbd>
          {t("common.close")}
        </span>
      </div>
    </div>
  );
}
