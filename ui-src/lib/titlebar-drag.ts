// Tauri's drag-region script toggles window maximize on a double click
// (mousedown path on Windows/Linux, mouseup path on macOS — see tauri's
// window/scripts/drag.js). The headers that carry data-tauri-drag-region are app
// content, not a title bar, so a double click there must not resize or move the
// window. React dispatches before the event reaches document, where Tauri listens;
// stopping the second click hides it from Tauri while leaving the detail === 1
// path (single-click window drag) untouched.
import type { MouseEvent } from "react";

function stopDoubleClick(e: MouseEvent) {
  if (e.detail === 2) e.stopPropagation();
}

/** Spread onto a data-tauri-drag-region element to keep double clicks local. */
export const noMaximizeOnDoubleClick = { onMouseDown: stopDoubleClick, onMouseUp: stopDoubleClick };
