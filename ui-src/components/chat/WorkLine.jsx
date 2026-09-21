// working 状态行 + 「工作中 N 秒」行。迁移自 ui/core.js renderWorkLine 与 chat.js initChat 的轮询。
import { useEffect, useState } from "react";
import { useStore, activeOpen } from "../../store.js";

// working 状态行（输入框上方）：仅当前活跃会话流式期间显示（intent/思考/默认文案）。
// 结构稳定（wl-spin + wl-tx），workingText 变化只更新文本，不重建 spinner 节点防闪烁
export default function WorkLine() {
  useStore();
  const s = activeOpen();
  const text = s?.streaming ? s.workingText || "正在处理…" : "";
  return (
    <div className="work-line" id="workLine" hidden={!text}>
      {text && (
        <>
          <span className="wl-spin" />
          <span className="wl-tx" title={text}>{text}</span>
        </>
      )}
    </div>
  );
}

// 「工作中 N 秒」：250ms 轮询按真实时间取值（setInterval(1000) 与 turnStartAt 相位不对齐，
// 且主线程被流式重绘阻塞时回调被压缩补跳）
export function WorkSec() {
  const [sec, setSec] = useState(() => {
    const cur = activeOpen();
    return cur?.turnStartAt ? Math.floor((Date.now() - cur.turnStartAt) / 1000) : 0;
  });
  useEffect(() => {
    const t = setInterval(() => {
      const s = activeOpen();
      if (s?.turnStartAt) setSec(Math.floor((Date.now() - s.turnStartAt) / 1000));
    }, 250);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="act t2">
      工作中 <span id="workSec">{sec}</span> 秒
    </div>
  );
}
