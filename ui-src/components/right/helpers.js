// 右栏共享小工具：escapeHtml / fmtAgo / inlineCodeHtml。
// markdown.js（escapeHtml）、sidebar.js（fmtAgo）、tool-rows.js（fillInlineCode）的同名实现
// 均 import 旧 core.js——esbuild 打包会把整个命令式 UI 树的顶层副作用（window.onerror 等）
// 拖进 React bundle，与 store.js 冲突，故在此等价实现。
/** HTML 转义（markdown.js escapeHtml 等价实现） */
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 相对时间（sidebar.js fmtAgo 等价实现）：刚刚 / N分 / N小时 / N天 */
export function fmtAgo(iso) {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return "刚刚";
  if (sec < 3600) return Math.floor(sec / 60) + "分";
  if (sec < 86400) return Math.floor(sec / 3600) + "小时";
  return Math.floor(sec / 86400) + "天";
}

/** `反引号` 片段转 <code>（tool-rows.js fillInlineCode 的 html 版，step-title 经 innerHTML 注入用） */
export function inlineCodeHtml(text) {
  return String(text || "")
    .split(/(`[^`]+`)/)
    .map((p) =>
      p.length > 2 && p.startsWith("`") && p.endsWith("`")
        ? `<code>${escapeHtml(p.slice(1, -1))}</code>`
        : escapeHtml(p),
    )
    .join("");
}
