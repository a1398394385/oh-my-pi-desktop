// 侧栏工具（ui/sidebar.js 平移）：相对时间 / 时长格式化 / 会话标签 / 剪贴板复制。
// fmtDuration 供后续 chat-wave 消费（原版由 chat.js 引入）。
export function fmtAgo(iso: string): string {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return "刚刚";
  if (sec < 3600) return Math.floor(sec / 60) + "分";
  if (sec < 86400) return Math.floor(sec / 3600) + "小时";
  return Math.floor(sec / 86400) + "天";
}

export function fmtDuration(sec: number): string {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

// 会话标签所需的最小结构（与 SessionRow.SessionInfo 解耦，避免 util 反向依赖组件）
interface SessionLabelLike {
  title?: string | null; // 宿主 DiskSessionRow 为 string | null
  firstMessage?: string;
}

export function sessionLabel(s: SessionLabelLike): string {
  return s.title || s.firstMessage || "（空会话）";
}

// 复制到剪贴板（shell.js copyText 同款复刻，含 WKWebView 非安全上下文兜底）
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}
