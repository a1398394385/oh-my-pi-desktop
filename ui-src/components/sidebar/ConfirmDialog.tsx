// 全局二次确认弹窗（ui/sidebar.js showConfirmDialog 平移）：复用 lp-mask/lp-box 同款
// confirm-mask/confirm-box 结构；Esc 关闭、Enter 确认、点遮罩关闭、确定钮自动聚焦。
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function ConfirmDialog({ title, message, confirmText = "确定", cancelText = "取消", danger = false, onConfirm, onClose }: {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => okRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") {
        onClose();
        onConfirm?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, onClose]);
  return createPortal(
    <div className="confirm-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="confirm-box">
        {title && <div className="confirm-title">{title}</div>}
        {message && <div className="confirm-desc">{message}</div>}
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onClose}>{cancelText}</button>
          <button className={"confirm-btn" + (danger ? " danger" : "")} ref={okRef} onClick={() => { onClose(); onConfirm?.(); }}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
