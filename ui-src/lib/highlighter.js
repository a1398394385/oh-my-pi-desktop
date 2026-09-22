// 代码语法染色：移植 ZCode packages/ui/src/lib/shikiHighlighter.ts 的轻量路径——
// shiki codeToTokens 出 token（非 HTML），React 按行渲染 <span style=color>。
// 行底色/gutter 仍由调用方 CSS 负责，本模块只管行内 token 上色。
// 选型：createHighlighterCore + JS 正则引擎（免 oniguruma wasm，esbuild IIFE 直出）；
// 语言/主题按需注册，控制 bundle 体积。主题用 VSCode 同款 dark-plus/light-plus，
// 跟随 app 的 html[data-theme]，切换主题时按新主题重新 tokenize（缓存键含主题）。
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";
import langJs from "shiki/langs/javascript.mjs";
import langTs from "shiki/langs/typescript.mjs";
import langJsx from "shiki/langs/jsx.mjs";
import langTsx from "shiki/langs/tsx.mjs";
import langJson from "shiki/langs/json.mjs";
import langCss from "shiki/langs/css.mjs";
import langHtml from "shiki/langs/html.mjs";
import langXml from "shiki/langs/xml.mjs";
import langMarkdown from "shiki/langs/markdown.mjs";
import langPython from "shiki/langs/python.mjs";
import langRust from "shiki/langs/rust.mjs";
import langGo from "shiki/langs/go.mjs";
import langC from "shiki/langs/c.mjs";
import langCpp from "shiki/langs/cpp.mjs";
import langCsharp from "shiki/langs/csharp.mjs";
import langJava from "shiki/langs/java.mjs";
import langRuby from "shiki/langs/ruby.mjs";
import langPhp from "shiki/langs/php.mjs";
import langShell from "shiki/langs/shellscript.mjs";
import langYaml from "shiki/langs/yaml.mjs";
import langToml from "shiki/langs/toml.mjs";
import langSql from "shiki/langs/sql.mjs";
import langLua from "shiki/langs/lua.mjs";
import langSwift from "shiki/langs/swift.mjs";
import langKotlin from "shiki/langs/kotlin.mjs";
import langDiff from "shiki/langs/diff.mjs";
import langDocker from "shiki/langs/docker.mjs";
import langMake from "shiki/langs/make.mjs";
import langIni from "shiki/langs/ini.mjs";
import langVue from "shiki/langs/vue.mjs";
import langSvelte from "shiki/langs/svelte.mjs";
import langBash from "shiki/langs/bash.mjs";
import langScss from "shiki/langs/scss.mjs";
import langLess from "shiki/langs/less.mjs";
import langGraphql from "shiki/langs/graphql.mjs";
import langTex from "shiki/langs/latex.mjs";

// 超大内容不染色：tokenize 是纯 CPU 活，ZCode 轻量 diff 上限 120k 字符，沿用
export const HIGHLIGHT_MAX_CHARS = 120_000;

// 扩展名 → shiki 语言 id（不含点）。无映射/纯文本类返回 null = 不染色（直出原文，
// 避免 ZCode 踩过的坑：纯文本进 shiki 异步状态机只有开销没有收益）
const EXT_TO_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "vue", svelte: "svelte",
  md: "markdown", mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  java: "java",
  rb: "ruby",
  php: "php",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash",
  yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "ini",
  sql: "sql",
  lua: "lua",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  diff: "diff", patch: "diff",
  dockerfile: "docker",
  mk: "make", mak: "make",
  gql: "graphql", graphql: "graphql",
  tex: "latex", latex: "latex",
};

// 按文件名/扩展名取语言 id；Dockerfile/Makefile 这类无扩展名按文件名匹配
export function langOfPath(path) {
  const base = String(path || "").split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "docker";
  if (lower === "makefile" || lower === "gnumakefile") return "make";
  const i = lower.lastIndexOf(".");
  if (i < 0) return null;
  return EXT_TO_LANG[lower.slice(i + 1)] || null;
}

// app 明暗主题：shell.js 写 html[data-theme]=dark|light（system 时已解析成具体值）
export function currentCodeTheme() {
  return document.documentElement.dataset.theme === "light" ? "light-plus" : "dark-plus";
}

const LANG_MODULES = {
  javascript: langJs, typescript: langTs, jsx: langJsx, tsx: langTsx,
  json: langJson, css: langCss, html: langHtml, xml: langXml,
  markdown: langMarkdown, python: langPython, rust: langRust, go: langGo,
  c: langC, cpp: langCpp, csharp: langCsharp, java: langJava, ruby: langRuby,
  php: langPhp, shellscript: langShell, bash: langBash, yaml: langYaml,
  toml: langToml, sql: langSql, lua: langLua, swift: langSwift,
  kotlin: langKotlin, diff: langDiff, docker: langDocker, make: langMake,
  ini: langIni, vue: langVue, svelte: langSvelte, scss: langScss, less: langLess,
  graphql: langGraphql, latex: langTex,
};

// 主题名 → 主题定义（createHighlighterCore 不自带 bundledThemes）
const THEMES = { "dark-plus": darkPlus, "light-plus": lightPlus };

// 单例 highlighter： langs 懒注册（loadLanguage），引擎用 JS 正则（免 wasm 异步加载）
let highlighterPromise = null;
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [darkPlus, lightPlus],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

// 结果缓存：键 = 主题 + 语言 + 内容首尾各 100 字符 + 长度（ZCode 同款键，
// 避免整段 code 做键的内存翻倍）。无淘汰——条目小、上限由调用方字符封顶。
const tokensCache = new Map();
// 同键并发请求合并：首个请求完成后回调全部订阅者（组件 effect 注册）
const pending = new Map();

// 同步返回缓存的 token；未命中则启动异步 tokenize 并通过 callback 送回
// （React 组件在 effect 里调用，callback 里 setState；缓存命中也走 microtask，
// 避免渲染期同步 setState）。返回 null = 调用方先渲染纯文本。
// 返回结构：{ tokens: [[{content,color}...]...] }（按行）
export function highlightCode(code, lang, theme, callback) {
  if (!lang || !code || code.length > HIGHLIGHT_MAX_CHARS) return null;
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  const key = `${theme}:${lang}:${code.length}:${start}:${end}`;
  const cached = tokensCache.get(key);
  if (cached) {
    if (callback) queueMicrotask(() => callback(cached));
    return cached;
  }
  if (callback) {
    if (!pending.has(key)) pending.set(key, new Set());
    pending.get(key).add(callback);
  }
  if (pending.get(key)?.size > 1) return null; // 已有同键请求在飞，等它的回调

  getHighlighter()
    .then(async (h) => {
      if (!h.getLoadedLanguages().includes(lang)) {
        const mod = LANG_MODULES[lang];
        if (!mod) return; // 未注册的语言不染色（调用方回退纯文本）
        await h.loadLanguage(mod.default || mod);
      }
      // 两个主题已在 createHighlighterCore 注册，按名字取色即可（tokens 的 color 直接可用）
      const result = h.codeToTokens(code, { lang, theme });
      const tokens = result.tokens.map((line) =>
        line.map((t) => ({ content: t.content, color: t.color || "" })),
      );
      const tokenized = { tokens };
      tokensCache.set(key, tokenized);
      const subs = pending.get(key);
      if (subs) {
        for (const cb of subs) cb(tokenized);
        pending.delete(key);
      }
    })
    .catch(() => {
      pending.delete(key); // tokenize 失败：组件停留在纯文本态
    });
  return null;
}

// 主题跟随：shell.js 改 html[data-theme] 不发事件，这里用 MutationObserver
// 广播一次，hook 收到后拿新主题重新 tokenize（缓存键含主题，切回不重复算）
const themeListeners = new Set();
let themeObserved = null;
export function subscribeCodeTheme(listener) {
  themeListeners.add(listener);
  // happy-dom（smoke 环境）没有 MutationObserver：跳过观察，主题切换不触发重染即可
  if (!themeObserved && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    themeObserved = new MutationObserver(() => {
      for (const l of themeListeners) l(currentCodeTheme());
    });
    themeObserved.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return () => themeListeners.delete(listener);
}
