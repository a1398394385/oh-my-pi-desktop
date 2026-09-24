// 查阅组/设备组等模块级展开态(WeakMap)的渲染通道:变更 bump 一次,订阅者重渲染。
import { useSyncExternalStore } from "react";

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
