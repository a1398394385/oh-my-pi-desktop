// Shared markdown machinery and surface: the single entry every markdown-rendering surface goes
// through (chat messages, tool cards, hub detail blocks). Previously the streamdown config
// (codePlugin/mdComponents/mdControls/linkSafety) was duplicated verbatim at three call sites
// and AssistantMsg.tsx carried it; unifying it here keeps every surface on the same
// parsing/rendering pipeline (engine = streamdown + cjk/code plugins — the web-native
// equivalent of the TUI's self-contained markdown core in tui/src/components/markdown.ts).
// Visual semantics live in CSS on the wrapper class chain: .md-surface carries the TUI-parity
// rules (ui/css/main-chat.css); surfaces needing their own font size or page height set them in
// their domain CSS (e.g. .cmd-card-cmd.task-md).
import { createElement, isValidElement, useMemo, useState, useEffect, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { CodeBlock, CodeBlockCopyButton, Streamdown, useIsCodeFenceIncomplete, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import type * as mermaidNs from "@streamdown/mermaid";
import type { DiagramPlugin } from "@streamdown/mermaid";
import type { Viz } from "@viz-js/viz";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import { t } from "../../i18n";
import { useAppStore } from "../../store";
import { CODE_PLUGINS, resolvePluginKey, type CodePluginKey } from "../../lib/code-plugin-registry";
import { getThemeById } from "../../theme-registry";
import { FileChip, openExternal, openImagePathPanel, openInBrowser } from "./parts";
import { modDown } from "../../platform";
import { IMAGE_EXTS } from "./util";
import { fixStrongAutolink } from "./strong-autolink";

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

// ```svg → sandboxed image. An <img> loading an SVG document cannot execute its
// scripts or fetch external resources (browser guarantee), so model output needs no sanitizer.
function SvgDiagram({ source }: { source: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([source], { type: "image/svg+xml" })), [source]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="md-diagram" src={url} alt="SVG diagram" />;
}

// Render-once mermaid sequence ids (mermaid's render() wants a unique id per call).
let mermaidSeq = 0;

function renderMermaid(source: string): Promise<string> {
  // mermaid (450KB+ with deps) loads on the first ```mermaid block, mirroring
  // the viz-js lazy pattern below.
  return mermaidForScheme()
    .then((plugin) => plugin.getMermaid().render(`mmd-${++mermaidSeq}`, source))
    .then((r) => r.svg);
}

// graphviz via viz-js (WASM); renderSVGElement throws on bad dot source
let vizPromise: Promise<Viz> | undefined;
function renderDot(source: string): Promise<string> {
  vizPromise ??= import("@viz-js/viz").then((m) => m.instance());
  return vizPromise.then((viz) => viz.renderSVGElement(source).outerHTML);
}

// Diagram → sandboxed <img> (same script-proof blob as ```svg). While rendering, or when
// the engine rejects the source, the caller's plain code block / fallback shows instead.
function AsyncDiagram({ source, render, alt, language }: { source: string; render: (src: string) => Promise<string>; alt: string; language: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    render(source)
      .then((out) => {
        if (alive) setSvg(out);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [source, render]);
  const url = useMemo(
    () => (svg ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : null),
    [svg],
  );
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  // Render failure (bad syntax): fall back to the highlighted code block
  if (failed) {
    return (
      <div className="md-code-block-frame">
        <CodeBlock className="md-streamdown-code" code={source} language={language} lineNumbers={false}>
          <CodeBlockCopyButton />
        </CodeBlock>
      </div>
    );
  }
  if (!url) return null; // render in flight
  return <img className="md-diagram" src={url} alt={alt} />;
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

  // Diagram blocks gated by the base's switches (undefined = on, the base default):
  // tui.renderSvg drives ```svg, tui.autoGraph drives ```mermaid and graphviz ```dot.
  // All stay plain code while the fence is streaming or when rendering is off/failed.
  const renderSvg = useAppStore((s) => s.hostSettings?.values?.["tui.renderSvg"] !== false);
  const autoGraph = useAppStore((s) => s.hostSettings?.values?.["tui.autoGraph"] !== false);
  const complete = !isIncomplete && source.trim().length > 0;
  if (language === "svg" && renderSvg && complete) return <SvgDiagram source={source} />;
  if (autoGraph && complete) {
    if (language === "mermaid") return <AsyncDiagram source={source} render={renderMermaid} alt="Mermaid diagram" language="mermaid" />;
    if (language === "dot" || language === "graphviz") return <AsyncDiagram source={source} render={renderDot} alt="Graphviz diagram" language="dot" />;
  }

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
  // Links: left click opens the right-panel built-in browser, ⌘/Ctrl+click the system one
  // via the opener plugin — Tauri's WebView silently ignores target=_blank new-window
  // requests, so a bare <a> never opens. The streamdown external-link confirm dialog stays
  // bypassed (same as before). Non-http(s) hrefs (anchors, relative file URLs) keep default
  // behavior: the manual view is an iframe and cannot load file:// targets.
  a: ({ node, href, ...rest }: ElProps<"a">) =>
    createElement("a", {
      ...rest,
      className: "md-link",
      onClick: (e: ReactMouseEvent<HTMLAnchorElement>) => {
        if (href && /^https?:\/\//i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          if (modDown(e)) void openExternal(href);
          else openInBrowser(href);
        }
      },
    }),
  // Images: remote/data URLs render inline (the Tauri webview has no CSP restrictions);
  // a local filesystem path cannot load in the webview, so render it as a clickable file
  // chip that opens the right-panel image preview (read_image) instead of a broken <img>.
  img: ({ node, src, alt, ...rest }: ElProps<"img">) => {
    if (
      typeof src === "string" &&
      !/^(https?:|data:|blob:)/i.test(src) &&
      IMAGE_EXTS[src.split(".").pop()?.toLowerCase() ?? ""]
    ) {
      return <FileChip path={src} onNameClick={() => openImagePathPanel(src)} />;
    }
    return <img {...rest} src={src} alt={alt} className="md-img" />;
  },
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

// Mermaid plugin per color scheme; a rendered diagram is a render-time snapshot, so a
// later theme switch re-colors only newly rendered diagrams (shiki re-themes via CSS
// variables, mermaid inlines colors — the known limitation).
const mermaidPlugins: { light?: DiagramPlugin; dark?: DiagramPlugin } = {};
let mermaidModule: Promise<typeof mermaidNs> | undefined;
function mermaidForScheme(): Promise<DiagramPlugin> {
  const theme = document.documentElement.dataset.theme || "dark";
  const light = getThemeById(theme)?.shikiTheme === "light-plus";
  const slot = light ? "light" : "dark";
  mermaidModule ??= import("@streamdown/mermaid");
  return mermaidModule.then((m) => {
    mermaidPlugins[slot] ??= m.createMermaidPlugin({
      config: { startOnLoad: false, securityLevel: "strict", theme: light ? "default" : "dark" },
    });
    return mermaidPlugins[slot]!;
  });
}

type MdSurfaceProps = { text: string } & Omit<JSX.IntrinsicElements["div"], "children">;

// Reference-stable plugin bundles per code-plugin key: streamdown compares the
// plugins object by reference on streaming frames, so an inline literal (or a
// fresh useMemo object) would reset its internal context every render.
const SURFACE_PLUGINS: Record<CodePluginKey, { code: (typeof CODE_PLUGINS)[CodePluginKey]; cjk: typeof cjk }> = {
  default: { code: CODE_PLUGINS.default, cjk },
  nord: { code: CODE_PLUGINS.nord, cjk },
};

// The single markdown entry: wrapper div carries the surface's classes (md-body + md-surface
// and any domain class); remaining props (style/data-*) pass through to the wrapper.
// The codePlugin switches per theme (default uses dark-plus, midnight uses nord) to match
// the theme's color intensity.
export default function MdSurface({ text, ...rest }: MdSurfaceProps) {
  const pluginKey = useActiveCodePlugin();
  const safeText = useMemo(() => fixStrongAutolink(text), [text]);

  return (
    <div {...rest}>
      <Streamdown
        key={pluginKey}
        plugins={SURFACE_PLUGINS[pluginKey]}
        components={mdComponents}
        lineNumbers={false}
        codeBlockMaxHeight={400}
        tableMaxHeight={0}
        controls={mdControls}
        linkSafety={MD_LINK_SAFETY_OFF}
      >
        {safeText}
      </Streamdown>
    </div>
  );
}
