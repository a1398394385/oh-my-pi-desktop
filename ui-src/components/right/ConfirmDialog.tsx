// 二次确认弹窗（settings/providers.js confirmDialog 的 React 版）：lp-mask/lp-box 类名照用。
// onDone(ok) 回调替代原 Promise resolve；点遮罩空白处等同取消。
import { useTranslation } from "react-i18next";

interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
  onDone: (ok: boolean) => void;
}

export default function ConfirmDialog({ title, message = "", confirmText, danger = false, onDone }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <div
      className="lp-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDone(false);
      }}
    >
      <div className="lp-box">
        <div className="lp-msg">{title}</div>
        {message ? <div className="cf-msg">{message}</div> : null}
        <div className="lp-row">
          <button className="save-btn" onClick={() => onDone(false)}>
            {t("common.cancel")}
          </button>
          <button className={"save-btn" + (danger ? " danger" : "")} onClick={() => onDone(true)}>
            {confirmText ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
