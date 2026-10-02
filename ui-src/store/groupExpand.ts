// Render channel for module-level expansion state (WeakMaps) of read/device groups etc.: bump once per change, subscribers re-render.
import { useSyncExternalStore } from "react";
import type { ToolItem } from "../types/session";

let version = 0;
const listeners = new Set<() => void>();

export function bumpGroupExpand(): void {
  version++;
  for (const fn of listeners) fn();
}

export function useGroupExpandVersion(): number {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => version,
  );
}

// Module-level expansion state WeakMaps (keyed by the group-head item, preserved across full redraws)
export const rdExpand = new WeakMap<ToolItem, boolean>();
export const chgExpand = new WeakMap<ToolItem, boolean>();
export const cmdExpand = new WeakMap<ToolItem, boolean>();
export const devExpand = new WeakMap<ToolItem, boolean>();

/** When a child item is replaced by a copy, migrate the expansion state to the new object if the old one held it as the group head */
export function migrateGroupExpand(from?: ToolItem, to?: ToolItem): void {
  if (!from || !to) return;
  if (rdExpand.has(from)) rdExpand.set(to, rdExpand.get(from)!);
  if (chgExpand.has(from)) chgExpand.set(to, chgExpand.get(from)!);
  if (cmdExpand.has(from)) cmdExpand.set(to, cmdExpand.get(from)!);
  if (devExpand.has(from)) devExpand.set(to, devExpand.get(from)!);
}

