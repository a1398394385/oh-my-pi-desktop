import type { MouseEvent as ReactMouseEvent } from "react";

/** Billboard speed (cell px per second). Fixed time read as a blur on long lines, so callers
 *  that honor --mq-t scale the duration with the measured distance. */
export const MARQUEE_PX_PER_S = 60;

/**
 * Arms the billboard scroll on a cell whose text is clipped by a container sized elsewhere
 * (model flyout, queue row). The travel distance cannot be expressed in CSS: the width depends
 * on the remaining viewport room. Measure it per hover and hand it to the keyframes as --mq.
 * `nameSel` picks the clipping cell, so callers outside the menu reuse the same measurement.
 */
export function armMarquee(e: ReactMouseEvent, nameSel = ".mi-name") {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(nameSel);
  if (!cell) return;
  const over = cell.clientWidth - cell.scrollWidth;
  cell.style.setProperty("--mq", Math.min(0, over) + "px");
  // Two seconds floor: a barely-clipped tail still needs a perceptible sweep...
  cell.style.setProperty("--mq-t", Math.max(2, -over / MARQUEE_PX_PER_S).toFixed(2) + "s");
  cell.classList.toggle("mq", over < 0);
}
