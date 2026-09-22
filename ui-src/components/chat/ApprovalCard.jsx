// 审批卡：标题 + 选项按钮（editable 时带输入框，「提交」取输入值，空输入按取消处理）。
// 迁移自 ui/chat.js 的 approval 分支。点击后 answer 定格（chosen/dim/disabled），本地点击即时生效。
import { useRef } from "react";
import { send, notify } from "../../store.js";

export default function ApprovalCard({ item }) {
  const inpRef = useRef(null);
  const choose = (opt) => {
    if (item.answer !== null) return;
    let answer = opt;
    if (item.editable) {
      if (opt === "提交") answer = inpRef.current.value.trim() || null; // 空输入按取消处理
      else answer = undefined;
    }
    item.answer = answer ?? opt;
    send({ type: "approval_response", requestId: item.requestId, answer });
    notify();
  };
  return (
    <div className="approval-card">
      <pre className="approval-title">{item.title}</pre>
      <div className="approval-buttons">
        {item.editable && (
          // 非受控输入：输入只写回 item.prefill（全量重绘时保住已输入内容），不触发重渲染
          <input
            type="text"
            className="approval-input"
            placeholder="输入后点提交…"
            defaultValue={item.prefill || ""}
            disabled={item.answer !== null}
            ref={inpRef}
            onChange={(e) => { item.prefill = e.target.value; }}
          />
        )}
        {item.options.map((opt) => (
          <button
            key={opt}
            disabled={item.answer !== null}
            className={item.answer === opt ? "chosen" : item.answer !== null ? "dim" : ""}
            onClick={() => choose(opt)}
          >
            {item.answer !== null && item.answer === opt ? `✓ ${opt}` : opt}
          </button>
        ))}
      </div>
    </div>
  );
}

