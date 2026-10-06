// ctx-menu generic container: portaled to body (fixed positioning), place does measured
// placement (zoom compensation + viewport clamp), closes on click-outside / window blur.
// place(menuRect) returns the desired [left, top] visual coordinates.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../../store";

export default function Menu({ place, onClose, children }: {
  place: (mr: DOMRect) => [number, number];
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Placement must happen after measuring the menu's actual size (mirrors the old append → getBoundingClientRect → placeMenu)
  useLayoutEffect(() => {
    const el = ref.current!; // exists right after portal mount (the old JS dereferenced directly; same assumption kept)
    const [left, top] = place(el.getBoundingClientRect());
    const z = useAppStore.getState().zoomLevel || 1; // fixed-menu coordinate compensation: set zoom first, then divide back
    el.style.zoom = String(z);
    el.style.left = left / z + "px";
    el.style.top = top / z + "px";
  });
  useEffect(() => {
    // Close on click outside the menu or window blur (mirrors shell.js window click/blur → closeAllMenus)
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose(); // in a window listener e.target is always a Node at runtime
    };
    window.addEventListener("click", onClick);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div className="ctx-menu" ref={ref}>
      {children}
    </div>,
    document.body,
  );
}
