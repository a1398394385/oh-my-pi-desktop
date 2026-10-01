// 「工作中 N 秒」行（原 WorkLine.jsx；流式状态行已合并进 ChatLoading——
// 转圈 + 动态文字现在挂在消息流末位、输入框正上方靠左，不再独立成行）。
import { useEffect, useState } from "react";
import { activeOpen } from "../../store";
import { fmtDuration } from "./util";
import { t } from "../../i18n";

// 「工作中 N 秒」：250ms 轮询按真实时间取值（setInterval(1000) 与 turnStartAt 相位不对齐，
// 且主线程被流式重绘阻塞时回调被压缩补跳）
export function WorkSec() {
  const [sec, setSec] = useState(() => {
    const cur = activeOpen();
    return cur?.turnStartAt ? Math.floor((Date.now() - cur.turnStartAt) / 1000) : 0;
  });
  useEffect(() => {
    // renamed from `t` to avoid shadowing the i18n t() import
    const timer = setInterval(() => {
      const s = activeOpen();
      if (s?.turnStartAt) setSec(Math.floor((Date.now() - s.turnStartAt) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="act t2">
      {t("chat.workingFor")}<span id="workSec">{fmtDuration(sec)}</span>
    </div>
  );
}
