// Dropdown exclusivity: opening a dropdown closes the previously open one.
// Every custom dropdown (the .sel/.menu family) claims the single slot while
// open and releases it on close/unmount; stopPropagation on the triggers keeps
// each dropdown's own outside-click listener blind to clicks on another
// dropdown's trigger, which is exactly why they could stack before.
// Radix-based dropdowns (SchemaRows' Select) already enforce this among
// themselves and dismiss on any outside press, so they need no wiring here.

type Closer = () => void;

let current: Closer | null = null;

/** Take the open slot, closing the previous holder (no-op when it already holds it). */
export function claimDropdown(close: Closer): void {
  if (current && current !== close) current();
  current = close;
}

/** Release the slot on close/unmount; stale holders (already replaced) are ignored. */
export function releaseDropdown(close: Closer): void {
  if (current === close) current = null;
}
