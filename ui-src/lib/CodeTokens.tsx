// Highlighting React binding: useCodeTokens fetches tokens asynchronously
// (first render plain text, repainted on completion; theme switches trigger a
// refetch under the new theme via MutationObserver; the cache key includes the
// theme, so no recomputation). <CodeTokens> renders one line of tokens as
// colored spans; tokens without color use the inherited color.
import { useEffect, useState } from "react";
import { highlightCode, currentCodeTheme, subscribeCodeTheme, type HighlightToken } from "./highlighter";

export function useCodeTokens(code: string, lang: string | null): HighlightToken[][] | null {
  const [theme, setTheme] = useState(currentCodeTheme);
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null);
  // setState inside an external event (DOM attribute observation) is safe; no
  // event means no render cost
  useEffect(() => subscribeCodeTheme(setTheme), []);
  useEffect(() => {
    setTokens(null);
    if (!lang || !code) return undefined;
    let cancelled = false;
    const apply = (r: { tokens: HighlightToken[][] }) => { if (!cancelled) setTokens(r.tokens); };
    const sync = highlightCode(code, lang, theme, apply);
    if (sync) setTokens(sync.tokens);
    return () => { cancelled = true; };
  }, [code, lang, theme]);
  return tokens;
}

export function CodeTokens({ line }: { line: HighlightToken[] | null }) {
  if (!line || line.length === 0) return null;
  return line.map((t, i) =>
    t.color ? (
      <span key={i} style={{ color: t.color }}>{t.content}</span>
    ) : (
      <span key={i}>{t.content}</span>
    ),
  );
}
