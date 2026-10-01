// 手动添加项目弹层（ui/sidebar.js openProjAddPop 平移）：全路径输入，Enter 提交 / Esc 关闭。
// 宿主负责把命中已移除列表的项移回所有项目列表。定位于触发按钮下方（宽 330）。
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../store";

export default function ProjAddPop({ anchorRect, onClose }: { anchorRect: DOMRect; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const inpRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!; // portal mount 后即存在（原 JS 直接解引用，保持同一假设）
    const w = 330;
    const left = Math.max(4, Math.min(anchorRect.right - w, window.innerWidth - w - 8));
    const z = useAppStore.getState().zoomLevel || 1; // placeMenu 同款：先设 zoom 再除回
    el.style.zoom = String(z);
    el.style.left = left / z + "px";
    el.style.top = (anchorRect.bottom + 4) / z + "px";
    inpRef.current?.focus();
  }, []);
  useEffect(() => {
    // 点弹层外部或窗口失焦时关闭（对照 shell.js closeAllMenus 协调）
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
  const submit = () => {
    const cwd = inpRef.current!.value.trim();
    if (!cwd) return;
    send({ type: "add_project", cwd });
    onClose();
  };
  return createPortal(
    <div className="proj-add-pop" ref={ref}>
      <input
        className="inp"
        ref={inpRef}
        placeholder={t("sidebar.projectPathPh")}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") onClose();
        }}
      />
      <button className="pa-btn" onClick={submit}>{t("sidebar.add")}</button>
    </div>,
    document.body,
  );
}
