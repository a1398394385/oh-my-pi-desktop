// Assistant message: markdown rendering goes through streamdown (P6: replaces the
// ui/markdown.js regex pipeline).
// streamdown still emits standard markdown elements; components here re-attach the existing
// .md-* classes so the .md-body rules in style.css keep hitting; code blocks / table shells
// / images are streamdown's deeply customized structures (marked with data-streamdown
// attributes), styled by the P6 block at the end of style.css.
// The streaming variant (streaming tail) additionally carries the streaming-draft class.
//
// Performance red line (2026-09-21 freeze incident): React.memo must stay here —
// a delta-frame-induced full-tree re-render would rerun the markdown parsing pipeline for
// every historical message; in long sessions the main thread gets saturated by 10-per-second
// full reparses and the app appears dead (the compositor thread keeps animating).
// With memo, historical messages with unchanged props are skipped outright; only the one
// still streaming re-parses.
import { createElement, isValidElement, memo, useState } from "react";
import type { JSX } from "react";
import { CodeBlock, CodeBlockCopyButton, Streamdown, useIsCodeFenceIncomplete, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import { t } from "../../i18n";

// Code highlight plugin singleton (caches a Shiki highlighter internally; JS regex engine,
// no wasm): themes = [light, dark], using the VSCode-matching light-plus / dark-plus (same
// palette as the file view's ui-src/lib/highlighter.ts, but each holds its own highlighter
// instance without interference).
// Token colors land on inline CSS variables (--sdm-c / --shiki-dark); theme switching is
// handled by P6 CSS re-reading the variables per html[data-theme], taking effect instantly
// at runtime without re-rendering.
// Exported for reuse by secondary markdown surfaces (e.g. the hub detail page's Task block).
export const codePlugin = createCodePlugin({ themes: ["light-plus", "dark-plus"] });

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

// Props shape for the element mapping: the hast node is a non-DOM attribute attached by
// react-markdown; destructure it away before passing through
type ElProps<K extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[K] & { node?: unknown };

// Element factory that re-attaches .md-* classes. mdComponents must be a module-level
// constant to stay reference-stable — streamdown memoizes per block and compares the
// components reference; an inline literal would punch through the cache.
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
          aria-label={wrapLongLines ? t("chat.disableWordWrap") : t("chat.enableWordWrap")}
          aria-pressed={wrapLongLines}
          title={wrapLongLines ? t("chat.disableWordWrap") : t("chat.enableWordWrap")}
          onClick={() => setWrapLongLines((wrapped) => !wrapped)}
        >
          <Icon name="wrapText" size={14} />
        </button>
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  );
}

// Reference-stable element map shared with secondary markdown surfaces (hub detail Task).
export const mdComponents: Components = {
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
  // Links: keep the old pipeline behavior (open in a new tab; streamdown's external-link
  // confirm dialog hangs on its internal a component and is naturally bypassed by this override)
  a: ({ node, ...rest }: ElProps<"a">) =>
    createElement("a", { ...rest, className: "md-link", target: "_blank", rel: "noopener noreferrer" }),
  // Task-list checkboxes: type/disabled hardcoded explicitly (not relying on upstream
  // attribute pass-through); the class hits .md-task-cb
  input: ({ node, ...rest }: ElProps<"input">) =>
    createElement("input", { ...rest, type: "checkbox", disabled: true, className: "md-task-cb" }),
  code: mdCodeBlock,
  inlineCode: mdTag("code", "md-inline-code"),
};

// streamdown config constants (kept reference-stable to avoid resetting its internal
// context on streaming frames): line numbers and height caps all off (matching the old
// .md-code-block visuals); controls keep only the code-block copy button.
// Exported alongside mdComponents for secondary markdown surfaces.
export const mdControls = { code: { copy: true, download: false }, table: false, image: false };
export const MD_LINK_SAFETY_OFF = { enabled: false };

// Strip ACP <dcp-message-id> tags: the host strips them from persisted text before pushing
// frames, but tag fragments during streaming text_delta reach rendering directly (the host
// cannot reliably split tags across deltas); this is the fallback cleanup.
// Same pattern as REF_TAG_RE in host/acp-context.ts.
const DCP_TAG_RE = /<dcp-message-id>m\d{1,5}<\/dcp-message-id>\n?/g;
function stripDcpTags(s: string): string {
  const out = s.replace(DCP_TAG_RE, "");
  return out === s ? s : out.trim();
}

function AssistantMsgImpl({ text, fk, streaming }: { text?: string; fk?: string; streaming?: boolean }) {
  const plain = text ? stripDcpTags(text) : text;
  return (
    <div
      className={"msg assistant md-body" + (streaming ? " streaming-draft" : "")}
      data-fk={fk || undefined}
      style={plain ? undefined : { display: "none" }}
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
        {plain || ""}
      </Streamdown>
    </div>
  );
}

export default memo(AssistantMsgImpl);
