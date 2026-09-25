// 全局二次确认弹窗（ui/sidebar.js showConfirmDialog 平移）：Radix Dialog 行为层
// （Esc / 点遮罩关闭 / focus trap / Enter 激活聚焦钮）+ .confirm-box 同款视觉（基件
// DialogContent 的浮层卡语言）；confirm-title/desc/actions 与 confirm-btn 按钮类、
// .danger 变体原样保留。按钮关闭统一走 DialogClose → onOpenChange(false) → onClose，
// 确定钮只挂业务 onConfirm；autoFocus 使打开即聚焦，Enter 即确认。
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog";

export default function ConfirmDialog({ title, message, confirmText = "确定", cancelText = "取消", danger = false, onConfirm, onClose }: {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}) {
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
            <button type="button" className="confirm-btn">{cancelText}</button>
          </DialogClose>
          <DialogClose asChild>
            <button
              type="button"
              className={"confirm-btn" + (danger ? " danger" : "")}
              autoFocus
              onClick={() => { onConfirm?.(); }}
            >
              {confirmText}
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
