// 代码语法染色：移植 ZCode packages/ui/src/lib/shikiHighlighter.ts 的轻量路径——
// shiki codeToTokens 出 token（非 HTML），React 按行渲染 <span style=color>。
// 行底色/gutter 仍由调用方 CSS 负责，本模块只管行内 token 上色。
// 选型：createHighlighterCore + JS 正则引擎（免 oniguruma wasm，esbuild IIFE 直出）；
// 语言/主题按需注册，控制 bundle 体积。主题用 VSCode 同款 dark-plus/light-plus，
// 跟随 app 的 html[data-theme]，切换主题时按新主题重新 tokenize（缓存键含主题）。
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { pathBase } from "../store/utils";
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

// 行内染色 token：color 缺省（空串/undefined）时调用方走继承色
export interface HighlightToken {
  content: string;
  color?: string;
}
// highlightCode 的返回结构：按行的 token 二维数组
export interface HighlightResult {
  tokens: HighlightToken[][];
}

// 超大内容不染色：tokenize 是纯 CPU 活，ZCode 轻量 diff 上限 120k 字符，沿用
export const HIGHLIGHT_MAX_CHARS = 120_000;

// 扩展名 → shiki 语言 id（不含点）。无映射/纯文本类返回 null = 不染色（直出原文，
// 避免 ZCode 踩过的坑：纯文本进 shiki 异步状态机只有开销没有收益）
const EXT_TO_LANG: Record<string, string> = {
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
export function langOfPath(path: string | null | undefined): string | null {
  const base = pathBase(path);
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "docker";
  if (lower === "makefile" || lower === "gnumakefile") return "make";
  const i = lower.lastIndexOf(".");
  if (i < 0) return null;
  return EXT_TO_LANG[lower.slice(i + 1)] || null;
}

// app 明暗主题：shell.js 写 html[data-theme]=dark|light（system 时已解析成具体值）
export function currentCodeTheme(): string {
  return document.documentElement.dataset.theme === "light" ? "light-plus" : "dark-plus";
}

// shiki/langs/*.mjs 的默认导出即 LanguageRegistration 数组(静态 import 已是解包后的数组;
// 原写法把模块类型标成 { default: [...] } 且运行期取 mod.default = undefined,loadLanguage
// 收不到语言注册表,懒注册静默失败回退纯文本——此处一并修正为直接传数组)
const LANG_MODULES: Record<string, LanguageRegistration[]> = {
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
let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [darkPlus, lightPlus],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

// 结果缓存：键 = 主题 + 语言 + 完整内容的 64 位哈希。
// 早期沿用 ZCode 的「长度 + 首尾各 100 字符」做键，中段不同的代码块会撞键——调用方
// （CodeTokens）直接渲染 token.content，撞键即显示成另一个代码块的原文（不只是配色错）。
// 整段内容直接做键会让 Map 再留一份字符串副本，故走哈希。
const tokensCache = new Map<string, { tokenized: HighlightResult; chars: number }>();
// 缓存内容总字符上限（超出按最久未用淘汰）：tokens 的内存开销是原文的数倍，
// 长会话里读过的每个文件/diff 都留一份会持续增长。
const TOKENS_CACHE_MAX_CHARS = 2_000_000;
let tokensCacheChars = 0;
// 同键并发请求合并：首个请求完成后回调全部订阅者（组件 effect 注册）
const pending = new Map<string, Set<(result: HighlightResult) => void>>();

// 双种子 FNV-1a 拼 64 位：单 32 位在数万个代码块下碰撞概率已到千分之几，双种子可忽略。
// 逐码元遍历，120k 字符上限下耗时 <1ms，相对随后的 tokenize 可忽略。
function hashCode(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

// 写入并按总字符数淘汰最久未用（Map 保持插入序，队首即最旧）
function cacheTokens(key: string, tokenized: HighlightResult, chars: number): void {
  tokensCache.set(key, { tokenized, chars });
  tokensCacheChars += chars;
  while (tokensCacheChars > TOKENS_CACHE_MAX_CHARS && tokensCache.size > 1) {
    const oldest = tokensCache.keys().next().value as string;
    if (oldest === key) break; // 单条即超上限：留着它，避免清空后立刻又算一遍
    tokensCacheChars -= tokensCache.get(oldest)!.chars;
    tokensCache.delete(oldest);
  }
}

// 同步返回缓存的 token；未命中则启动异步 tokenize 并通过 callback 送回
// （React 组件在 effect 里调用，callback 里 setState；缓存命中也走 microtask，
// 避免渲染期同步 setState）。返回 null = 调用方先渲染纯文本。
// 返回结构：{ tokens: [[{content,color}...]...] }（按行）
export function highlightCode(
  code: string,
  lang: string | null,
  theme: string,
  callback?: (result: HighlightResult) => void,
): HighlightResult | null {
  if (!lang || !code || code.length > HIGHLIGHT_MAX_CHARS) return null;
  const key = `${theme}:${lang}:${hashCode(code)}`;
  const cached = tokensCache.get(key);
  if (cached) {
    // LRU touch：命中即移到队尾（Map 插入序），否则热点块会被新块挤出
    tokensCache.delete(key);
    tokensCache.set(key, cached);
    if (callback) queueMicrotask(() => callback(cached.tokenized));
    return cached.tokenized;
  }
  if (callback) {
    if (!pending.has(key)) pending.set(key, new Set());
    pending.get(key)!.add(callback);
  }
  if ((pending.get(key)?.size ?? 0) > 1) return null; // 已有同键请求在飞，等它的回调

  const scheduleTokenize = () => {
    getHighlighter()
      .then(async (h) => {
        if (!h.getLoadedLanguages().includes(lang)) {
          const mod = LANG_MODULES[lang];
          if (!mod) return; // 未注册的语言不染色（调用方回退纯文本）
          await h.loadLanguage(mod);
        }
        // 切到宏任务执行耗时 tokenize，给 UI 交互和滚动留出渲染间隙
        setTimeout(() => {
          try {
            // 两个主题已在 createHighlighterCore 注册，按名字取色即可（tokens 的 color 直接可用）
            const result = h.codeToTokens(code, { lang, theme });
            const tokens = result.tokens.map((line) =>
              line.map((t) => ({ content: t.content, color: t.color || "" })),
            );
            const tokenized = { tokens };
            cacheTokens(key, tokenized, code.length);
            const subs = pending.get(key);
            if (subs) {
              for (const cb of subs) cb(tokenized);
              pending.delete(key);
            }
          } catch {
            pending.delete(key);
          }
        }, 0);
      })
      .catch(() => {
        pending.delete(key); // tokenize 失败：组件停留在纯文本态
      });
  };

  // 优先通过 rAF 延迟到首帧 DOM Paint 之后，保证点击展开入场动画（0ms 感官）不被长文本 tokenize 阻塞
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => setTimeout(scheduleTokenize, 0));
  } else {
    setTimeout(scheduleTokenize, 0);
  }
  return null;
}

// 主题跟随：shell.js 改 html[data-theme] 不发事件，这里用 MutationObserver
// 广播一次，hook 收到后拿新主题重新 tokenize（缓存键含主题，切回不重复算）
const themeListeners = new Set<(theme: string) => void>();
let themeObserved: MutationObserver | null = null;
export function subscribeCodeTheme(listener: (theme: string) => void): () => void {
  themeListeners.add(listener);
  // happy-dom（smoke 环境）没有 MutationObserver：跳过观察，主题切换不触发重染即可
  if (!themeObserved && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    themeObserved = new MutationObserver(() => {
      for (const l of themeListeners) l(currentCodeTheme());
    });
    themeObserved.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  // React effect 清理函数要求 void 返回(Set.delete 返回 boolean,包一层丢弃)
  return () => {
    themeListeners.delete(listener);
  };
}
