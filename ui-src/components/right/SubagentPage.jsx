// 子代理页：卡片列表 + 点击进详情。
// 详情骨架（今日定稿，必须保留）：#rightBody 加 detail 类，rb-head 固定（返回 + 名字/状态），
// sub-stream rb-scroll 滚动承载过程流。
import { useRef } from "react";
import { S, useStore, notify, activeOpen } from "../../store.js";
import { inlineCodeHtml } from "./helpers.js";
import { Spin } from "../chat/parts.jsx";

export default function SubagentPage() {
  useStore();
  const s = activeOpen();
  if (!s || s.subagents.size === 0) {
    return <div className="placeholder">（暂无子代理）</div>;
  }
  if (S.selectedSubagent && s.subagents.has(S.selectedSubagent)) {
    return <SubagentDetail sub={s.subagents.get(S.selectedSubagent)} />;
  }
  return (
    <>
      {[...s.subagents].map(([id, sub]) => (
        <button
          key={id}
          className={"sub-card " + (sub.streaming ? "running" : sub.status)}
          onClick={() => {
            S.selectedSubagent = id;
            // 入场动画标记：notify 触发的重渲染读 true 加 kids-in，宏任务里复位
            // （S 未预声明该字段——store 禁改，运行时挂上，语义同原 core.js）
            S.animateSubKids = true;
            notify();
            setTimeout(() => {
              S.animateSubKids = false;
            }, 0);
          }}
        >
          <div className="sub-card-head">
            <span className="sub-dot">
              {sub.streaming ? "●" : sub.status === "completed" ? "✓" : sub.status === "failed" ? "✗" : "○"}
            </span>
            <span>{sub.agent}</span>
          </div>
          <div className="sub-desc">{sub.description || sub.text.slice(0, 60) || "…"}</div>
        </button>
      ))}
    </>
  );
}

// 详情：返回 + 名字/状态固定在顶，过程流（工具行 + 当前文本）滚动
function SubagentDetail({ sub }) {
  const headRef = useRef(null);
  const scrollRef = useRef(null);
  const kids = !!S.animateSubKids; // 渲染时读取（notify 后首帧为 true，setTimeout 复位）
  const back = () => {
    // 收起：详情内容上收（0.3s）后切回列表
    for (const el of [headRef.current, scrollRef.current]) el?.classList.add("lift");
    setTimeout(() => {
      S.selectedSubagent = null;
      notify();
    }, 310);
  };
  return (
    <>
      <div ref={headRef} className={"rb-head" + (kids ? " kids-in" : "")}>
        <button className="sub-back" onClick={back}>
          ‹ 返回列表
        </button>
        <div className="sub-title">
          {sub.agent} · {sub.status}
        </div>
      </div>
      <div ref={scrollRef} className={"sub-stream rb-scroll" + (kids ? " kids-in" : "")}>
        {sub.tools.map((t, i) => (
          <ToolLine key={i} t={t} />
        ))}
        {(sub.text || sub.streaming) && (
          <div
            className={"step-title" + (sub.streaming ? " flash" : "")}
            dangerouslySetInnerHTML={{ __html: inlineCodeHtml(sub.text || "…") }}
          />
        )}
      </div>
    </>
  );
}

// 工具行轻量摘要：命令 / 路径 / 模式等首个可读参数
function toolSummary(t) {
  const a = t.args || {};
  return a.command || a.path || a.pattern || a.files?.[0] || t.files?.[0] || "";
}

// TODO(tool-row-wave)：完整工具行视觉（tool-labels.js 各标签渲染）依赖旧 core.js，
// 待主对话区（chat-wave）翻译后统一复用；此处先以「标签 + 摘要」行呈现
function ToolLine({ t }) {
  const sum = toolSummary(t);
  return (
    <div className="act read">
      <span className="lbl">{t.name}</span>
      {sum ? (
        <span className="path" title={sum}>
          {sum}
        </span>
      ) : null}
      {t.running ? <Spin /> : null}
    </div>
  );
}
