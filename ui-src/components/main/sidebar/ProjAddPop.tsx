// Manual add-project popover (ported from ui/sidebar.js openProjAddPop): full-path input,
// Enter to submit / Esc to close.
// The host moves entries matching the removed list back into the all-projects list. Positioned
// below the trigger button (width 330).
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { send, effZoom } from "../../../store";

export default function ProjAddPop({ anchorRect, onClose }: { anchorRect: DOMRect; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const inpRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!; // exists right after portal mount (the old JS dereferenced directly; same assumption kept)
    const z = effZoom(); // same as placeMenu: set zoom first, then divide back
    el.style.zoom = String(z);
    // measure the real visual width after zoom: the clamps mix it with visual
    // anchor/viewport coordinates, so a fixed layout-width estimate would drift under zoom
    const w = el.getBoundingClientRect().width;
    const left = Math.max(4, Math.min(anchorRect.right - w, window.innerWidth - w - 8));
    el.style.left = left / z + "px";
    el.style.top = (anchorRect.bottom + 4) / z + "px";
    inpRef.current?.focus();
  }, []);
  useEffect(() => {
    // Close on click outside the popover or window blur (coordinated with the old shell.js closeAllMenus)
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
