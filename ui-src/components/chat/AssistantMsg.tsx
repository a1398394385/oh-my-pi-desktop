// assistant 消息：markdown 渲染走 streamdown（P6：替换 ui/markdown.js 正则管线）。
// streamdown 输出的仍是标准 markdown 元素，这里经 components 把既有 .md-* 类挂回
// 各元素，style.css 的 .md-body 规则继续命中；代码块/表格壳/图片是 streamdown 深度
// 定制结构（带 data-streamdown 属性标记），样式由 style.css 末尾 P6 块接管。
// streaming 变体（流式尾巴）多挂 streaming-draft 类。
//
// 性能红线（2026-09-21 卡死事故）：此处必须保持 React.memo——
// delta 帧触发的全树重渲染会让每条历史消息重跑 markdown 解析管线，
// 长会话下主线程被 10 次/秒的全量重解析占满，应用假死（合成线程动画照转）。
// memo 后历史消息 props 不变直接跳过，只有流式中的那条重解析。
import { createElement, isValidElement, memo, useState } from "react";
import type { JSX } from "react";
import { CodeBlock, CodeBlockCopyButton, Streamdown, useIsCodeFenceIncomplete, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";

// 代码高亮插件单例（内部缓存 Shiki highlighter，JS 正则引擎免 wasm）：
// themes = [light, dark]，取 VSCode 同款 light-plus / dark-plus（与文件页
// ui-src/lib/highlighter.ts 同款配色，但各持各的 highlighter 实例互不影响）。
// token 颜色落在行内 CSS 变量（--sdm-c / --shiki-dark），主题切换由 P6 CSS 按
// html[data-theme] 换读变量，运行时即时生效、无需重新渲染。
const codePlugin = createCodePlugin({ themes: ["light-plus", "dark-plus"] });

const CODE_LANGUAGE_EXTENSIONS: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  rust: "rs",
  shell: "sh",
  bash: "sh",
  yaml: "yml",
  markdown: "md",
  plaintext: "txt",
  text: "txt",
};

// 元素映射的 props 形状：hast node 是 react-markdown 附加的非 DOM 属性，解构剥掉再透传
type ElProps<K extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[K] & { node?: unknown };

// 挂回 .md-* 类的元素工厂。mdComponents 必须是模块级常量保持引用稳定——
// streamdown 内部按 block memo 并比较 components 引用，内联字面量会击穿缓存。
function mdTag<K extends keyof JSX.IntrinsicElements>(tag: K, className: string) {
  return ({ node, ...rest }: ElProps<K>) => createElement(tag, { ...rest, className });
}

function mdCodeBlock({ className, children }: ElProps<"code">) {
  const [wrapLongLines, setWrapLongLines] = useState(false);
  const isIncomplete = useIsCodeFenceIncomplete();
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() || "text";
  const nestedCode = isValidElement<{ children?: unknown }>(children) && typeof children.props.children === "string"
    ? children.props.children
    : null;
  const source = (typeof children === "string" ? children : nestedCode || "").replace(/\n+$/, "");
  const extension = CODE_LANGUAGE_EXTENSIONS[language] || language;

  return (
    <div className="md-code-block-frame">
      <span className="md-code-language-icon" aria-hidden="true">
        <Icon name={fileTypeIcon(`snippet.${extension}`)} size={14} />
      </span>
      <CodeBlock
        className="md-streamdown-code"
        code={source}
        data-wrap={wrapLongLines ? "on" : "off"}
        isIncomplete={isIncomplete}
        language={language}
        lineNumbers={false}
      >
        <button
          type="button"
          data-streamdown="code-block-wrap-button"
          aria-label={wrapLongLines ? "关闭自动换行" : "开启自动换行"}
          aria-pressed={wrapLongLines}
          title={wrapLongLines ? "关闭自动换行" : "开启自动换行"}
          onClick={() => setWrapLongLines((wrapped) => !wrapped)}
        >
          <Icon name="wrapText" size={14} />
        </button>
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  );
}

const mdComponents: Components = {
  p: mdTag("p", "md-p"),
  h1: mdTag("h1", "md-h md-h1"),
  h2: mdTag("h2", "md-h md-h2"),
  h3: mdTag("h3", "md-h md-h3"),
  h4: mdTag("h4", "md-h md-h4"),
  h5: mdTag("h5", "md-h md-h5"),
  h6: mdTag("h6", "md-h md-h6"),
  ul: mdTag("ul", "md-ul"),
  ol: mdTag("ol", "md-ol"),
  blockquote: mdTag("blockquote", "md-quote"),
  hr: mdTag("hr", "md-hr"),
  table: mdTag("table", "md-table"),
  // 链接：沿用旧管线行为（新标签页打开；streamdown 的外链确认弹窗挂在内部 a 组件上，覆盖后自然绕开）
  a: ({ node, ...rest }: ElProps<"a">) =>
    createElement("a", { ...rest, className: "md-link", target: "_blank", rel: "noopener noreferrer" }),
  // 任务列表勾选框：type/disabled 显式写死（不依赖上游属性透传），类命中 .md-task-cb
  input: ({ node, ...rest }: ElProps<"input">) =>
    createElement("input", { ...rest, type: "checkbox", disabled: true, className: "md-task-cb" }),
  code: mdCodeBlock,
  inlineCode: mdTag("code", "md-inline-code"),
};

// streamdown 配置常量（保持引用稳定，避免流式帧重置其内部 context）：
// 行号/限高全关（对齐旧 .md-code-block 视觉），控件只留代码块复制按钮
const mdControls = { code: { copy: true, download: false }, table: false, image: false };
const MD_LINK_SAFETY_OFF = { enabled: false };

function AssistantMsgImpl({ text, fk, streaming }: { text?: string; fk?: string; streaming?: boolean }) {
  return (
    <div
      className={"msg assistant md-body" + (streaming ? " streaming-draft" : "")}
      data-fk={fk || undefined}
      style={text ? undefined : { display: "none" }}
    >
      <Streamdown
        plugins={{ code: codePlugin, cjk }}
        components={mdComponents}
        lineNumbers={false}
        codeBlockMaxHeight={400}
        tableMaxHeight={0}
        controls={mdControls}
        linkSafety={MD_LINK_SAFETY_OFF}
      >
        {text || ""}
      </Streamdown>
    </div>
  );
}

export default memo(AssistantMsgImpl);
