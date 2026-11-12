// Pending annotation chips above the composer: one aggregated pill per kind —
// text quoted from the file / diff pane ("N selected blocks"), and selection
// comments over assistant output (first snippet + a count when there are
// several), mirroring the attachment chips in AttachRow. Hover/focus shows the
// quoted text and comment of every pending note; × clears that kind, per-row ×
// drops just that note.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { placeMenu } from "../../shell";
import { removeAnnotation, type PendingAnnotation } from "../../store/annotations";
import type { QuoteNote } from "../../lib/conversation-quote";
import { pathBase } from "../../store/utils";
import { fileTypeIcon } from "../../../ui/icons";
import Icon from "../../Icon";

// Clearance from the chip to its hover card: 6px read as touching the composer card's
// top border in the real render, so the popover keeps a visible gap instead.
const GAP = 10;
const EDGE = 8;

export default function AnnotationChips({ list }: { list: PendingAnnotation[] }) {
  const { t } = useTranslation();
  // File-pane quotes carry their path, output comments do not: two chips so neither
  // kind hides the other's count.
  const blocks = list.filter((a) => a.file);
  const notes = list.filter((a) => !a.file);
  return (
    <>
      {blocks.length > 0 && (
        <Chip
          list={blocks}
          icon={fileTypeIcon(blocks[0].file!)}
          label={t("composer.quoteBlocks", { count: blocks.length })}
          footer={t("composer.quoteBlocks", { count: blocks.length })}
          onRemove={(a) => removeAnnotation(a.id)}
          onClear={() => blocks.forEach((a) => removeAnnotation(a.id))}
        />
      )}
      {notes.length > 0 && (
        <Chip
          list={notes}
          icon="comment"
          label={notes[0].text}
          footer={t("composer.annotateCount", { count: notes.length })}
          count={notes.length > 1 ? notes.length : undefined}
          onRemove={(a) => removeAnnotation(a.id)}
          onClear={() => notes.forEach((a) => removeAnnotation(a.id))}
        />
      )}
    </>
  );
}

/** One aggregated pill + its hover card. `onRemove` / `onClear` are optional:
 *  a sent bubble shows the same card read-only, without the × controls. */
export function Chip<T extends QuoteNote>({
  list,
  icon,
  label,
  footer,
  count,
  onRemove,
  onClear,
}: {
  list: readonly T[];
  icon: string;
  label: string;
  footer?: string;
  count?: number;
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
        {count ? <span className="annot-chip-n">{count}</span> : null}
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
                    <span className="annot-qm">“</span>
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
            {footer ? <div className="annot-chip-count">{footer}</div> : null}
          </div>,
          document.body,
        )}
    </>
  );
}
