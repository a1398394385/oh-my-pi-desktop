// Shared markdown machinery and surface: the single entry every markdown-rendering surface goes
// through (chat messages, tool cards, hub detail blocks). Previously the streamdown config
// (codePlugin/mdComponents/mdControls/linkSafety) was duplicated verbatim at three call sites
// and AssistantMsg.tsx carried it; unifying it here keeps every surface on the same
// parsing/rendering pipeline (engine = streamdown + cjk/code plugins — the web-native
// equivalent of the TUI's self-contained markdown core in tui/src/components/markdown.ts).
// Visual semantics live in CSS on the wrapper class chain: .md-surface carries the TUI-parity
// rules (ui/css/main-chat.css); surfaces needing their own font size or page height set them in
// their domain CSS (e.g. .cmd-card-cmd.task-md).
import { createElement, isValidElement, useState, useEffect, type JSX } from "react";
import { CodeBlock, CodeBlockCopyButton, Streamdown, useIsCodeFenceIncomplete, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import { t } from "../../i18n";
import { CODE_PLUGINS, resolvePluginKey, type CodePluginKey } from "../../lib/code-plugin-registry";

// Subscribe to theme changes and switch the active plugin key when the concrete theme changes.
// Reads from html[data-theme] (the resolved theme: "dark"/"light"/"midnight"/etc.) rather than
// uiPrefs.theme (which may be "system"), ensuring the plugin matches the actual displayed theme.
function useActiveCodePlugin() {
  const [pluginKey, setPluginKey] = useState<CodePluginKey>(() =>
    resolvePluginKey(document.documentElement.dataset.theme || "dark")
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const concreteTheme = document.documentElement.dataset.theme || "dark";
      const newKey = resolvePluginKey(concreteTheme);
      setPluginKey(newKey);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return pluginKey;
}

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

// Reference-stable element map for every markdown surface.
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
export const mdControls = { code: { copy: true, download: false }, table: false, image: false };
export const MD_LINK_SAFETY_OFF = { enabled: false };

type MdSurfaceProps = { text: string } & Omit<JSX.IntrinsicElements["div"], "children">;

// The single markdown entry: wrapper div carries the surface's classes (md-body + md-surface
// and any domain class); remaining props (style/data-*) pass through to the wrapper.
// The codePlugin switches per theme (default uses dark-plus, midnight uses nord) to match
// the theme's color intensity.
export default function MdSurface({ text, ...rest }: MdSurfaceProps) {
  const pluginKey = useActiveCodePlugin();
  const codePlugin = CODE_PLUGINS[pluginKey];

  return (
    <div {...rest}>
      <Streamdown
        key={pluginKey}
        plugins={{ code: codePlugin, cjk }}
        components={mdComponents}
        lineNumbers={false}
        codeBlockMaxHeight={400}
        tableMaxHeight={0}
        controls={mdControls}
        linkSafety={MD_LINK_SAFETY_OFF}
      >
        {text}
      </Streamdown>
    </div>
  );
}
