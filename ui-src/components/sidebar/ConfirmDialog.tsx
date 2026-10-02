// Global confirm dialog (ported from ui/sidebar.js showConfirmDialog): Radix Dialog behavior
// layer (Esc / mask-click close / focus trap / Enter activates the focused button) + the same
// .confirm-box visuals (the popover card language of the base DialogContent); confirm-title/
// desc/actions with the confirm-btn button class and the .danger variant kept verbatim. Button
// closes uniformly go DialogClose → onOpenChange(false) → onClose; the confirm button carries
// only the business onConfirm; autoFocus focuses on open so Enter confirms.
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog";

export default function ConfirmDialog({ title, message, confirmText, cancelText, danger = false, onConfirm, onClose }: {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="w-[480px] max-w-[calc(100vw-48px)] p-[16px_18px_14px]"
        aria-describedby={undefined}
      >
        {title && <DialogTitle className="confirm-title">{title}</DialogTitle>}
        {message && <DialogDescription className="confirm-desc">{message}</DialogDescription>}
        <DialogFooter className="confirm-actions">
          <DialogClose asChild>
            <button type="button" className="confirm-btn">{cancelText ?? t("common.cancel")}</button>
          </DialogClose>
          <DialogClose asChild>
            <button
              type="button"
              className={"confirm-btn" + (danger ? " danger" : "")}
              autoFocus
              onClick={() => { onConfirm?.(); }}
            >
              {confirmText ?? t("common.confirm")}
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
