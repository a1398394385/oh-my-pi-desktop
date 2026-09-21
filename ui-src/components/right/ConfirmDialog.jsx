// 二次确认弹窗（settings/providers.js confirmDialog 的 React 版）：lp-mask/lp-box 类名照用。
// onDone(ok) 回调替代原 Promise resolve；点遮罩空白处等同取消。
export default function ConfirmDialog({ title, message = "", confirmText = "确定", danger = false, onDone }) {
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
            取消
          </button>
          <button className={"save-btn" + (danger ? " danger" : "")} onClick={() => onDone(true)}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
