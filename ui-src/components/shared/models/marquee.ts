import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Arms the billboard scroll on a model name that the squeezed flyout clips. The travel distance
 * cannot be expressed in CSS: the name cell is sized by the flyout, whose width depends on the
 * remaining viewport room. Measure it per hover and hand it to the keyframes as --mq.
 */
export function armMarquee(e: ReactMouseEvent) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".mi-name");
  if (!cell) return;
  const over = cell.clientWidth - cell.scrollWidth;
  cell.style.setProperty("--mq", Math.min(0, over) + "px");
  cell.classList.toggle("mq", over < 0);
}
