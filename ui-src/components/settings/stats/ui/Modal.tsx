import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export interface ModalAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface ModalProps {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  primaryAction?: ModalAction;
  cancelLabel?: string;
  children: React.ReactNode;
}

export function Modal({ open, title, onClose, primaryAction, cancelLabel, children }: ModalProps) {
  const { t } = useTranslation();
  const resolvedCancelLabel = cancelLabel ?? t("settingsPage.stats.ui.cancel");
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      opener?.focus();
    };
  }, [open]);

  const hasPrimary = primaryAction !== undefined;
  const primaryDisabled = primaryAction?.disabled ?? false;
  useEffect(() => {
    if (!open) return;
    const target = hasPrimary && !primaryDisabled ? primaryRef.current : cancelRef.current;
    target?.focus();
  }, [open, hasPrimary, primaryDisabled]);

  if (!open) return null;

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className="modal-overlay" onClick={handleOverlayClick} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="btn icon-btn"
            data-variant="ghost"
            data-icon="true"
            data-size="sm"
            onClick={onClose}
            aria-label={t("settingsPage.stats.ui.close")}
          >
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="btn confirm-btn" onClick={onClose}>
            {resolvedCancelLabel}
          </button>
          {primaryAction && (
            <button
              ref={primaryRef}
              type="button"
              className="btn confirm-btn"
              data-variant="primary"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {primaryAction.label}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
