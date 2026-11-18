// Pending annotation chips above the composer: one aggregated pill — selection comments
// over assistant output and text quoted from the file / diff pane both count as comments
// ("N comments") — mirroring the attachment chips in AttachRow. The pill carries only the
// count, never the quoted body: hover/focus shows the quoted text and comment of every
// pending note (rows from a pane lead with their path:lines), × clears all of them,
// per-row × drops just that note.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { placeMenu } from "../../shell";
import { removeAnnotation, type PendingAnnotation } from "../../store/annotations";
import type { QuoteNote } from "../../lib/conversation-quote";
import { pathBase } from "../../store/utils";
import Icon from "../../Icon";

// Clearance from the chip to its hover card: 6px read as touching the composer card's
// top border in the real render, so the popover keeps a visible gap instead.
const GAP = 10;
const EDGE = 8;

export default function AnnotationChips({ list }: { list: PendingAnnotation[] }) {
  const { t } = useTranslation();
  // One chip for every pending note: the hover card labels each row with its own source
  // path, so splitting by kind would only hide half the count.
  if (list.length === 0) return null;
  return (
    <Chip
      list={list}
      icon="messageSquareText"
      label={t("composer.annotateCount", { count: list.length })}
      onRemove={(a) => removeAnnotation(a.id)}
      onClear={() => list.forEach((a) => removeAnnotation(a.id))}
    />
  );
}

/** One aggregated pill + its hover card. `onRemove` / `onClear` are optional:
 *  a sent bubble shows the same card read-only, without the × controls. */
export function Chip<T extends QuoteNote>({
  list,
  icon,
  label,
  onRemove,
  onClear,
}: {
  list: readonly T[];
  icon: string;
  label: string;
  onRemove?: (note: T) => void;
  onClear?: () => void;
}) {
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
          <Icon name={icon} />
        </span>
        <span className="at-name" title={label}>
          {label}
        </span>
        {onClear ? (
          <button type="button" className="atchip-x" title={t("common.delete")} onClick={onClear}>
            ×
          </button>
        ) : null}
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
              {list.map((a, i) => (
                <div className="annot-chip-item" key={i}>
                  {a.file ? (
                    <div className="annot-chip-src" title={a.file}>
                      {pathBase(a.file)}
                      {a.lines ? ":" + a.lines : ""}
                    </div>
                  ) : null}
                  <div className="annot-chip-quote">
                    <span className="annot-chip-qm">
                      <Icon name="textQuote" size={12} />
                    </span>
                    <span className="annot-chip-text">{a.text}</span>
                    {onRemove ? (
                      <button type="button" className="annot-chip-x" title={t("common.delete")} onClick={() => onRemove(a)}>
                        ×
                      </button>
                    ) : null}
                  </div>
                  {a.comment ? <div className="annot-chip-comment">{a.comment}</div> : null}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
