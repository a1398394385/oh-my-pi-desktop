// assistant 消息：markdown → HTML 注入。渲染引擎复用 ui/markdown.js 的纯函数
// （renderMarkdownToHtml；其内部的代码复制按钮走 window.copyCodeBlock 全局，模块加载即挂载）。
// streaming 变体（流式尾巴）多挂 streaming-draft 类。
import { renderMarkdownToHtml } from "../../../ui/markdown.js";

export default function AssistantMsg({ text, fk, streaming }) {
  const html = renderMarkdownToHtml(text || "");
  return (
    <div
      className={"msg assistant md-body" + (streaming ? " streaming-draft" : "")}
      data-fk={fk || undefined}
      style={html ? undefined : { display: "none" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
