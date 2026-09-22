// 染色 React 绑定：useCodeTokens 异步取 tokens（首渲染纯文本，完成后重绘；
// 主题切换经 MutationObserver 触发按新主题重取，缓存键含主题不重复计算）。
// <CodeTokens> 把一行 token 渲染成带色 span；无 color 的 token 走继承色。
import { useEffect, useState } from "react";
import { highlightCode, currentCodeTheme, subscribeCodeTheme } from "./highlighter.js";

export function useCodeTokens(code, lang) {
  const [theme, setTheme] = useState(currentCodeTheme);
  const [tokens, setTokens] = useState(null);
  // 外部事件（DOM 属性观察）里 setState 安全；无事件即无渲染开销
  useEffect(() => subscribeCodeTheme(setTheme), []);
  useEffect(() => {
    setTokens(null);
    if (!lang || !code) return undefined;
    let cancelled = false;
    const apply = (r) => { if (!cancelled) setTokens(r.tokens); };
    const sync = highlightCode(code, lang, theme, apply);
    if (sync) setTokens(sync.tokens);
    return () => { cancelled = true; };
  }, [code, lang, theme]);
  return tokens;
}

export function CodeTokens({ line }) {
  if (!line || line.length === 0) return null;
  return line.map((t, i) =>
    t.color ? (
      <span key={i} style={{ color: t.color }}>{t.content}</span>
    ) : (
      <span key={i}>{t.content}</span>
    ),
  );
}
