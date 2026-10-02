// Platform constants: shortcut modifiers use Ctrl on Windows (the Win key is
// too system-occupied), ⌘ stays on macOS. All ⌘ chord decisions and keycap
// copy come uniformly from here.
export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** Modifier keycap copy: Ctrl on Windows, ⌘ elsewhere */
export const MOD = IS_WINDOWS ? "Ctrl" : "⌘";

/** Whether the modifier is down (platform mapping of the ⌘ chords) */
export function modDown(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_WINDOWS ? e.ctrlKey : e.metaKey;
}
