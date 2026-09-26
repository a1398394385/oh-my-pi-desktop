// 查阅组/设备组等模块级展开态(WeakMap)的渲染通道:变更 bump 一次,订阅者重渲染。
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

// 模块级展开状态 WeakMap（以组首 item 为键，跨全量重绘保留）
export const rdExpand = new WeakMap<ToolItem, boolean>();
export const chgExpand = new WeakMap<ToolItem, boolean>();
export const cmdExpand = new WeakMap<ToolItem, boolean>();
export const devExpand = new WeakMap<ToolItem, boolean>();

/** 当子项被拷贝替换时，若旧子项作为组首持有展开状态，将状态迁移至新对象 */
export function migrateGroupExpand(from?: ToolItem, to?: ToolItem): void {
  if (!from || !to) return;
  if (rdExpand.has(from)) rdExpand.set(to, rdExpand.get(from)!);
  if (chgExpand.has(from)) chgExpand.set(to, chgExpand.get(from)!);
  if (cmdExpand.has(from)) cmdExpand.set(to, cmdExpand.get(from)!);
  if (devExpand.has(from)) devExpand.set(to, devExpand.get(from)!);
}

