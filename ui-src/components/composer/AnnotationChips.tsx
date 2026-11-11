// Pending annotation chip above the composer: one aggregated pill (comment icon +
// the first quoted snippet + a count when there are several), mirroring the
// attachment chips in AttachRow. Hover/focus shows the quoted text and comment of
// every pending note; × clears them all, per-row × drops just that note.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { placeMenu } from "../../shell";
import { clearAnnotations, removeAnnotation, type PendingAnnotation } from "../../store/annotations";
import Icon from "../../Icon";

// Clearance from the chip to its hover card: 6px read as touching the composer card's
// top border in the real render, so the popover keeps a visible gap instead.
const GAP = 10;
const EDGE = 8;

export default function AnnotationChips({ list }: { list: PendingAnnotation[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = () => clearTimeout(closeTimer.current);
  // Small grace so the pointer can cross the gap into the card
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => cancelClose, []);

  // Anchor above the chip (it sits at the bottom of the window); flip below when clipped
  useLayoutEffect(() => {
    const chip = chipRef.current;
    const pop = popRef.current;
    if (!open || !chip || !pop) return;
    placeMenu(pop, 0, 0); // apply zoom before reading visual sizes
    const c = chip.getBoundingClientRect();
    const b = pop.getBoundingClientRect();
    const left = Math.min(Math.max(c.left, EDGE), window.innerWidth - b.width - EDGE);
    const above = c.top - b.height - GAP;
    const top = above >= EDGE ? above : Math.min(c.bottom + GAP, window.innerHeight - b.height - EDGE);
    placeMenu(pop, left, top);
  });

  if (list.length === 0) return null;
  return (
    <>
      <span
        ref={chipRef}
        className="atchip annot-chip"
        tabIndex={0}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
      >
        <span className="at-ic">
          <Icon name="comment" />
        </span>
        <span className="at-name" title={list[0].text}>
          {list[0].text}
        </span>
        {list.length > 1 ? <span className="annot-chip-n">{list.length}</span> : null}
        <button type="button" className="atchip-x" title={t("composer.annotateClear")} onClick={clearAnnotations}>
          ×
        </button>
      </span>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="annot-chip-pop"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onFocus={cancelClose}
          >
            <div className="annot-chip-list">
              {list.map((a) => (
                <div className="annot-chip-item" key={a.id}>
                  <div className="annot-chip-quote">
                    <span className="annot-qm">“</span>
                    <span className="annot-chip-text">{a.text}</span>
                    <button
                      type="button"
                      className="annot-chip-x"
                      title={t("common.delete")}
                      onClick={() => removeAnnotation(a.id)}
                    >
                      ×
                    </button>
                  </div>
                  {a.comment ? <div className="annot-chip-comment">{a.comment}</div> : null}
                </div>
              ))}
            </div>
            <div className="annot-chip-count">{t("composer.annotateCount", { count: list.length })}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
