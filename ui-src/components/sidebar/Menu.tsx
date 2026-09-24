// ctx-menu 通用容器：portal 到 body（fixed 定位），place 量测定位（zoom 补偿 + 视口 clamp），
// 点菜单外/窗口失焦关闭。place(menuRect) 返回期望的 [left, top] 视觉坐标。
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { S } from "../../store";

export default function Menu({ place, onClose, children }: {
  place: (mr: DOMRect) => [number, number];
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 定位须在量到菜单实际宽高后做（对照原版 append 后 getBoundingClientRect 再 placeMenu）
  useLayoutEffect(() => {
    const el = ref.current!; // portal mount 后即存在（原 JS 直接解引用，保持同一假设）
    const [left, top] = place(el.getBoundingClientRect());
    const z = S.zoomLevel || 1; // fixed 菜单坐标补偿：先设 zoom 再除回
    el.style.zoom = String(z);
    el.style.left = left / z + "px";
    el.style.top = top / z + "px";
  });
  useEffect(() => {
    // 点击菜单外部或窗口失焦时关闭（对照 shell.js window click/blur → closeAllMenus）
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose(); // window 监听里 e.target 运行时必为 Node
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
