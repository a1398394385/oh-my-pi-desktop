// Composer menu positioning (ported from the positioning body of the old
// composer.js openComposerMenu, no shell.js dependency):
// horizontally centered on the button (button center = menu center, clamped to
// the composer's left edge and never overflowing its right edge), bottom hugs
// 8px above the button, expanding upward.
// Vertically, compute from the button's live offsetTop instead of a fixed
// bottom:44px -- the latter only holds by luck in single-row layouts; once
// wrapping or graded collapse moves the button, the popup detaches from it (the
// root cause of the new-session narrow-window misplacement bug).
// When the viewport space above is insufficient, switch to capped height +
// internal scrolling; the menu top reaches at most 4px below the viewport top,
// and the bottom edge still hugs above the button.
import { effZoom } from "../../store";

export function placeComposerMenu(comp: HTMLElement | null, menu: HTMLElement | null, btn: HTMLElement | null): void {
  if (!comp || !menu || !btn) return;
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const z = effZoom();
  const maxLeft = comp.clientWidth - menu.offsetWidth - 4;
  // Vertical centerline alignment: the popup's middle sits on the button's
  // middle, not its left edge (the row below is a pill, not a text anchor).
  const centered = btn.offsetLeft + (btn.offsetWidth - menu.offsetWidth) / 2;
  menu.style.left = Math.max(0, Math.min(centered, maxLeft)) + "px";
  const btnAbsTop = btn.getBoundingClientRect().top;
  let top = btn.offsetTop - menu.offsetHeight - 8;
  if (btnAbsTop - (menu.offsetHeight + 8) * z < 4) {
    const compTop = comp.getBoundingClientRect().top;
    menu.style.maxHeight = Math.max(80, Math.round((btnAbsTop - 8 * z - 4) / z)) + "px";
    menu.style.overflowY = "auto";
    top = Math.round((4 - compTop) / z);
  }
  menu.style.top = top + "px";
  menu.style.bottom = "auto";
}

// Sigil completion card positioning: align left with the composer card and
// anchor above its top edge. The gap is one shared constant for all triggers
// (/ @ $) so the three cards cannot drift apart again (the slash card used to
// sit at 8px, file/skill at 2px).
// Max height = ratio times the composer card height (2.6); when the viewport above is insufficient, the bottom edge stays put and
// the top reaches at most 4px below the viewport top, overflowing content
// scrolls internally.
// The vertical position is anchored via bottom (= padding box height + top
// border + gap) rather than a top measurement: no one-shot measurement of the
// popup's own height, so height changes from candidates arriving or fonts
// loading never leave a stale gap.
const PALETTE_GAP = 8;

export function placePaletteCard(comp: HTMLElement | null, menu: HTMLElement | null, ratio = 2.6): void {
  if (!comp || !menu) return;
  const z = effZoom();
  const cs = getComputedStyle(comp);
  const borderLeft = Number.parseFloat(cs.borderLeftWidth) || 0;
  const borderTop = Number.parseFloat(cs.borderTopWidth) || 0;
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  // The containing block is #composer's padding box: flush alignment = shift
  // left by the left border width + the card's border-box width
  menu.style.left = -borderLeft + "px";
  menu.style.width = comp.offsetWidth + "px";
  // Bottom anchoring: (padding height + top border + gap/zoom) above the
  // padding box bottom edge, i.e. PALETTE_GAP screen pixels above the card top
  menu.style.bottom = comp.clientHeight + borderTop + PALETTE_GAP / z + "px";
  menu.style.top = "auto";
  const maxH = Math.round(comp.offsetHeight * ratio);
  if (menu.offsetHeight > maxH) {
    menu.style.maxHeight = maxH + "px";
    menu.style.overflowY = "auto";
  }
  // Available height above (layout px): up to 4px below the viewport top,
  // minus the gap and the border difference from the containing block to the
  // card's outer edge
  const avail = Math.round((comp.getBoundingClientRect().top - 4) / z) - borderTop - Math.ceil(PALETTE_GAP / z);
  if (menu.offsetHeight > avail) {
    menu.style.maxHeight = Math.max(80, avail) + "px";
    menu.style.overflowY = "auto";
  }
}
