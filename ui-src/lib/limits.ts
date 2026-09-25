// 配额窗口展示（弹卡 CtxCard 与模型页 ModelPage 共用，语义/配色只此一处定义）。
// 统一「剩余额度」语义：数值与进度条都表示剩余百分比（host limits/core.js 的
// remainingPercent 恒有值，usedPercent 为真实已用百分比，二者互补）。
// 颜色按剩余分档（经典红绿灯，只用 token）：剩余 ≥50% 绿、20%~50% 黄、<20% 红。

/** 配额单窗口（limits_result / provider_limits_result 的 windows 元素，字段均可能缺省） */
export interface LimitWindow {
  label?: string;
  kind?: string;
  metric?: string; // "credits" 余额类窗口不渲染进度条
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetsAt?: string | number | null;
}

// 限额窗口标签：Record 而非字面量联合，raw 为任意 host 下发的窗口名
const LIMIT_LABELS: Record<string, string> = { "5-hour": "5小时", "5h": "5小时", weekly: "每周", daily: "每日", session: "会话" };

/** 限额窗口 → 展示项：剩余额度取整；resetIn = 距重置还需多久（≤1h "xxm"、≤1d "xxh xxm"、更久 "xxd xxh"） */
export function fmtLimitWindow(w: LimitWindow): { label: string; remaining: number | null; resetIn: string } {
  const remaining =
    w.remainingPercent != null ? Math.round(w.remainingPercent) : w.usedPercent != null ? 100 - Math.round(w.usedPercent) : null;
  let resetIn = "";
  if (w.resetsAt) {
    const mins = Math.ceil((new Date(w.resetsAt).getTime() - Date.now()) / 60000);
    if (mins <= 60) resetIn = `${Math.max(0, mins)}m`;
    else if (mins <= 24 * 60) resetIn = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    else resetIn = `${Math.floor(mins / (24 * 60))}d ${Math.floor((mins % (24 * 60)) / 60)}h`;
  }
  const raw = w.label || w.kind || "";
  return { label: LIMIT_LABELS[raw.toLowerCase()] ?? raw, remaining, resetIn };
}

/** 剩余额度分档色（经典红绿灯）：≥50% 绿、20%~50% 黄、<20% 红；未知给中性灰 */
export function limitTone(remaining: number | null): string {
  if (remaining == null) return "var(--faint)";
  return remaining >= 50 ? "var(--green)" : remaining >= 20 ? "var(--yellow)" : "var(--red)";
}
