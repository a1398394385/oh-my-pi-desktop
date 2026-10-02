// Composer menu positioning (ported from the positioning body of the old
// composer.js openComposerMenu, no shell.js dependency):
// anchored to the button (left follows it, bottom hugs 8px above the button,
// expanding upward), right edge never overflows.
// Vertically, compute from the button's live offsetTop instead of a fixed
// bottom:44px -- the latter only holds by luck in single-row layouts; once
// wrapping or graded collapse moves the button, the popup detaches from it (the
// root cause of the new-session narrow-window misplacement bug).
// When the viewport space above is insufficient, switch to capped height +
// internal scrolling; the menu top reaches at most 4px below the viewport top,
// and the bottom edge still hugs above the button.
import { useAppStore } from "../../store";

export function placeComposerMenu(comp: HTMLElement | null, menu: HTMLElement | null, btn: HTMLElement | null): void {
  if (!comp || !menu || !btn) return;
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const z = useAppStore.getState().zoomLevel || 1;
  const maxLeft = comp.clientWidth - menu.offsetWidth - 4;
  menu.style.left = Math.max(0, Math.min(btn.offsetLeft, maxLeft)) + "px";
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

// Sigil completion card positioning: align flush with the composer card's outer
// edges, bottom edge 2px above the card's top edge (screen pixels, not doubled
// by UI zoom) -- two identical rounded cards stacked vertically (the one with
// more content on top). Max height = ratio times the composer card height
// (2.6); when the viewport above is insufficient, the bottom edge stays put and
// the top reaches at most 4px below the viewport top, overflowing content
// scrolls internally.
// The vertical position is anchored via bottom (= padding box height + top
// border + gap) rather than a top measurement: no one-shot measurement of the
// popup's own height, so height changes from candidates arriving or fonts
// loading never leave a stale gap.
export function placePaletteCard(comp: HTMLElement | null, menu: HTMLElement | null, ratio = 2.6): void {
  if (!comp || !menu) return;
  const z = useAppStore.getState().zoomLevel || 1;
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
  // padding box bottom edge, i.e. 2 screen pixels above the card's top edge
  menu.style.bottom = comp.clientHeight + borderTop + 2 / z + "px";
  menu.style.top = "auto";
  const maxH = Math.round(comp.offsetHeight * ratio);
  if (menu.offsetHeight > maxH) {
    menu.style.maxHeight = maxH + "px";
    menu.style.overflowY = "auto";
  }
  // Available height above (layout px): up to 4px below the viewport top,
  // minus the gap and the border difference from the containing block to the
  // card's outer edge
  const avail = Math.round((comp.getBoundingClientRect().top - 4) / z) - borderTop - Math.ceil(2 / z);
  if (menu.offsetHeight > avail) {
    menu.style.maxHeight = Math.max(80, avail) + "px";
    menu.style.overflowY = "auto";
  }
}

// Model second-level menu (flyout) positioning:
// 1. Horizontal: pop out rightward by default, overlapping the first-level
//    menu's border by 4px (visually seamless); flip to the left if the right
//    edge overflows.
// 2. Max height cap: the second-level dropdown absolutely never exceeds the
//    screen; overflowing content scrolls internally.
// 3. Vertical: center on the selected provider row of the first-level dropdown
//    (expanding both up and down), clamped inside the viewport's safe
//    boundaries.
export function placeFlyoutMenu(
  fly: HTMLElement | null,
  menu: HTMLElement | null,
  row: HTMLElement | null,
  boundary?: HTMLElement | null
): void {
  if (!fly || !menu || !row) return;

  const z = useAppStore.getState().zoomLevel || 1;
  const margin = 8;

  // 1. Horizontal positioning: overlap the first-level menu's border by 4px;
  // flip to the left if the right edge overflows
  fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px";
  const boundRight = boundary ? boundary.getBoundingClientRect().right : window.innerWidth;
  if (fly.getBoundingClientRect().right > boundRight - margin) {
    fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px";
  }

  // 2. Max height cap: the second-level dropdown absolutely never exceeds the screen
  const maxScreenH = window.innerHeight - margin * 2;
  const maxHInContainer = Math.max(80, Math.floor(maxScreenH / z));
  fly.style.maxHeight = maxHInContainer + "px";
  fly.style.overflowY = "auto";

  // 3. Vertical positioning: center on the provider row
  const rowRect = row.getBoundingClientRect();
  const rowCenterY = rowRect.top + rowRect.height / 2;
  const flyH = fly.offsetHeight;
  let screenTop = rowCenterY - (flyH * z) / 2;

  // Viewport top/bottom boundary guard: shift up or down to keep it on screen
  const minScreenY = margin;
  const maxScreenY = window.innerHeight - margin;
  if (screenTop + flyH * z > maxScreenY) {
    screenTop = maxScreenY - flyH * z;
  }
  if (screenTop < minScreenY) {
    screenTop = minScreenY;
  }

  // 4. Convert back to relative coordinates inside the containing block (offsetParent)
  const container = (fly.offsetParent as HTMLElement | null) ?? menu.offsetParent ?? document.body;
  const containerRect = container.getBoundingClientRect();
  fly.style.top = Math.round((screenTop - containerRect.top) / z) + "px";
}
