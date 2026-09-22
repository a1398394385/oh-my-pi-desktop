// assistant 消息：markdown → HTML 注入。渲染引擎复用 ui/markdown.js 的纯函数
// （renderMarkdownToHtml；其内部的代码复制按钮走 window.copyCodeBlock 全局，模块加载即挂载）。
// streaming 变体（流式尾巴）多挂 streaming-draft 类。
//
// 性能红线（2026-09-21 卡死事故）：此处必须保持 React.memo + useMemo——
// delta 帧触发的全树重渲染会让每条历史消息重跑 markdown 正则管线，
// 长会话下主线程被 10 次/秒的全量重解析占满，应用假死（合成线程动画照转）。
// memo 后历史消息 props 不变直接跳过，只有流式中的那条重解析。
import { memo, useMemo } from "react";
import { renderMarkdownToHtml } from "../../../ui/markdown.js";

function AssistantMsgImpl({ text, fk, streaming }) {
  const html = useMemo(() => renderMarkdownToHtml(text || ""), [text]);
  return (
    <div
      className={"msg assistant md-body" + (streaming ? " streaming-draft" : "")}
      data-fk={fk || undefined}
      style={html ? undefined : { display: "none" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(AssistantMsgImpl);
