// Code syntax highlighting: ports the lightweight path of ZCode
// packages/ui/src/lib/shikiHighlighter.ts -- shiki codeToTokens emits tokens
// (not HTML), React renders lines of <span style=color>.
// Line backgrounds/gutters remain the caller's CSS job; this module only
// colors inline tokens.
// Choices: createHighlighterCore + the JS regex engine (no oniguruma wasm,
// esbuild IIFE output stays direct); languages/themes registered on demand to
// keep the bundle small. Themes are VSCode's dark-plus/light-plus, following
// the app's html[data-theme]; on theme switch, re-tokenize under the new theme
// (the cache key includes the theme).
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { pathBase } from "../store/utils";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";
import nord from "shiki/themes/nord.mjs";
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

// Inline highlighting token: when color is absent (empty string/undefined) the
// caller falls back to the inherited color
export interface HighlightToken {
  content: string;
  color?: string;
}
// Return structure of highlightCode: a per-line two-dimensional token array
export interface HighlightResult {
  tokens: HighlightToken[][];
}

// Do not highlight oversized content: tokenize is pure CPU work; ZCode's
// lightweight diff caps at 120k chars, kept as-is
export const HIGHLIGHT_MAX_CHARS = 120_000;

// Extension -> shiki language id (no dot). Unmapped/plain-text returns null =
// no highlighting (render the original text directly; this avoids a pitfall ZCode
// hit: feeding plain text into shiki's async state machine is pure overhead with
// no payoff)
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

// Take the language id from the file name/extension; extension-less files like
// Dockerfile/Makefile match by file name
export function langOfPath(path: string | null | undefined): string | null {
  const base = pathBase(path);
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "docker";
  if (lower === "makefile" || lower === "gnumakefile") return "make";
  const i = lower.lastIndexOf(".");
  if (i < 0) return null;
  return EXT_TO_LANG[lower.slice(i + 1)] || null;
}

// App light/dark theme: shell.js writes html[data-theme]=dark|light|midnight|... (system is
// already resolved to a concrete value). Custom themes use softer Shiki themes.
export function currentCodeTheme(): string {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light") return "light-plus";
  if (theme === "midnight") return "nord";  // softer colors for midnight
  return "dark-plus";
}

// The default export of shiki/langs/*.mjs is already a LanguageRegistration
// array (static imports are the unwrapped arrays; the previous typing marked
// the module as { default: [...] } and read mod.default = undefined at runtime,
// so loadLanguage never received the registration, lazy registration silently
// failed and fell back to plain text -- fixed here by passing the array directly)
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


// Singleton highlighter: langs are lazy-registered (loadLanguage), the engine is
// JS regex (no wasm async loading)
let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [darkPlus, lightPlus, nord],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

// Result cache: key = theme + language + a 64-bit hash of the full content.
// Early on, ZCode's key of "length + first/last 100 chars" was reused, and code
// blocks differing in the middle collided on it -- the caller (CodeTokens)
// renders token.content directly, so a collision displays another block's
// original text (not just wrong colors). Keying on the whole content would make
// the Map hold another copy of the string, hence the hash.
const tokensCache = new Map<string, { tokenized: HighlightResult; chars: number }>();
// Total character cap for cached content (evict least-recently-used beyond it):
// tokens cost several times the memory of the source text; keeping a copy of
// every file/diff read in long sessions would grow unbounded.
const TOKENS_CACHE_MAX_CHARS = 2_000_000;
let tokensCacheChars = 0;
// Merge concurrent requests for the same key: once the first request completes,
// all subscribers are called back (registered by component effects)
const pending = new Map<string, Set<(result: HighlightResult) => void>>();

// Dual-seed FNV-1a stitched to 64 bits: with a single 32-bit seed, collision
// probability reaches tenths of a percent over tens of thousands of code blocks;
// dual seeds make it negligible. Iterates code points one by one; under the 120k
// char cap it takes <1ms, negligible compared to the tokenize that follows.
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

// Write and evict least-recently-used by total chars (Map keeps insertion
// order, the head is the oldest)
function cacheTokens(key: string, tokenized: HighlightResult, chars: number): void {
  tokensCache.set(key, { tokenized, chars });
  tokensCacheChars += chars;
  while (tokensCacheChars > TOKENS_CACHE_MAX_CHARS && tokensCache.size > 1) {
    const oldest = tokensCache.keys().next().value as string;
    if (oldest === key) break; // a single entry already over the cap: keep it, avoid re-tokenizing right after a wipe
    tokensCacheChars -= tokensCache.get(oldest)!.chars;
    tokensCache.delete(oldest);
  }
}

// Return cached tokens synchronously; on a miss, kick off async tokenize and
// deliver via callback (React components call this in an effect and setState in
// the callback; cache hits also go through a microtask, avoiding synchronous
// setState during render). Returning null = the caller renders plain text first.
// Return structure: { tokens: [[{content,color}...]...] } (per line)
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
    // LRU touch: move a hit to the tail (Map insertion order), otherwise hot
    // blocks get pushed out by new ones
    tokensCache.delete(key);
    tokensCache.set(key, cached);
    if (callback) queueMicrotask(() => callback(cached.tokenized));
    return cached.tokenized;
  }
  if (callback) {
    if (!pending.has(key)) pending.set(key, new Set());
    pending.get(key)!.add(callback);
  }
  if ((pending.get(key)?.size ?? 0) > 1) return null; // a request for the same key is already in flight; wait for its callback

  const scheduleTokenize = () => {
    getHighlighter()
      .then(async (h) => {
        if (!h.getLoadedLanguages().includes(lang)) {
          const mod = LANG_MODULES[lang];
          if (!mod) return; // unregistered languages are not highlighted (caller falls back to plain text)
          await h.loadLanguage(mod);
        }
        // Move the costly tokenize onto a macrotask, leaving render gaps for UI
        // interaction and scrolling
        setTimeout(() => {
          try {
            // Both themes are registered in createHighlighterCore; take colors
            // by name (token colors are directly usable)
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
        pending.delete(key); // tokenize failed: the component stays in plain-text state
      });
  };

  // Prefer deferring via rAF past the first-frame DOM paint, so the click-to-expand
  // entrance animation (0ms perceived) is not blocked by long-text tokenize
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => setTimeout(scheduleTokenize, 0));
  } else {
    setTimeout(scheduleTokenize, 0);
  }
  return null;
}

// Theme following: shell.js changes html[data-theme] without emitting an event,
// so broadcast once via MutationObserver; hooks re-tokenize under the new theme
// on receipt (the cache key includes the theme, switching back costs no recompute)
const themeListeners = new Set<(theme: string) => void>();
let themeObserved: MutationObserver | null = null;
export function subscribeCodeTheme(listener: (theme: string) => void): () => void {
  themeListeners.add(listener);
  // happy-dom (smoke environment) lacks MutationObserver: skip observing, theme
  // switches simply do not trigger re-highlighting
  if (!themeObserved && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    themeObserved = new MutationObserver(() => {
      for (const l of themeListeners) l(currentCodeTheme());
    });
    themeObserved.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  // React effect cleanup functions require a void return (Set.delete returns
  // boolean; wrap and discard it)
  return () => {
    themeListeners.delete(listener);
  };
}

// Cold-start warmup: the first highlight of a language pays engine creation +
// grammar registration + first tokenize on the main thread, which users feel as a
// stall when it lands on the first read-row expansion. Warming the common
// languages during startup idle moves that cost off the interaction path. Cheap
// by design: one tiny sample per language, results enter the normal cache.
export function warmupHighlighter(langs: string[]): void {
  const warm = () => {
    void getHighlighter()
      .then(async (h) => {
        for (const lang of langs) {
          const mod = LANG_MODULES[lang];
          if (!mod || h.getLoadedLanguages().includes(lang)) continue;
          await h.loadLanguage(mod);
        }
        h.codeToTokens("const x = 1;", { lang: langs[0], theme: currentCodeTheme() });
      })
      .catch(() => {}); // warmup is best-effort; failures surface on first real use
  };
  if (typeof requestIdleCallback !== "undefined") requestIdleCallback(warm, { timeout: 2000 });
  else setTimeout(warm, 800);
}
