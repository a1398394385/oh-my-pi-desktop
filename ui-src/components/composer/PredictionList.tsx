// Composer prediction alternatives (host/prediction.ts): Tab on an inserted prediction opens
// every candidate; ↑↓ moves, Enter replaces the draft with the choice, Esc or typing closes.
// Reuses the palette card DOM/classes and its placement helper, so it needs no CSS of its own.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
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
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const choices = s?.prediction ?? null;
  const sessionId = s?.sessionId;
  const open = s?.predictionOpen === true;
  const menuRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  // Start on the candidate already in the draft (that is why the list could open)
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
    const pick = (i: number) => {
      const choice = choices[i];
      if (choice === undefined) return;
      setPredictionOpen(sessionId, false);
      onPick(choice);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        pick(index);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPredictionOpen(sessionId, false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, choices, index, sessionId, onPick]);

  if (!open || !choices || choices.length < 2) return null;
  return (
    <div className="menu palette open" ref={menuRef}>
      <div className="palette-list">
        {choices.map((choice, i) => (
          <div
            key={choice}
            className={"mi" + (i === index ? " on" : "")}
            title={choice}
            onMouseEnter={() => setIndex(i)}
            onClick={() => {
              setPredictionOpen(sessionId!, false);
              onPick(choice);
            }}
          >
            <span className="mi-tx">{choice}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
