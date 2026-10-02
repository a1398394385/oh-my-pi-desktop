// Quota window display (shared by the CtxCard popup and the model page
// ModelPage; semantics/colors defined only here).
// Unified "remaining allowance" semantics: both the number and the progress bar
// express the remaining percentage (remainingPercent from host limits/core.js is
// always present, usedPercent is the true used percentage; they complement each
// other).
// Colors tier by remaining amount (classic traffic light, tokens only): >=50%
// remaining green, 20%~50% yellow, <20% red.

/** Quota window (an element of limits_result / provider_limits_result windows;
 *  every field may be absent) */
export interface LimitWindow {
  label?: string;
  kind?: string;
  metric?: string; // "credits" balance-type windows render no progress bar
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetsAt?: string | number | null;
}

// Limit window labels: Record rather than a literal union; raw is any window
// name delivered by the host
const LIMIT_LABELS: Record<string, string> = { "5-hour": "5小时", "5h": "5小时", weekly: "每周", daily: "每日", session: "会话" };

/** Limit window -> display item: remaining allowance rounded; resetIn = time
 *  until reset (<=1h "xxm", <=1d "xxh xxm", longer "xxd xxh") */
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

/** Remaining-allowance tier color (classic traffic light): >=50% green,
 *  20%~50% yellow, <20% red; unknown gets neutral gray */
export function limitTone(remaining: number | null): string {
  if (remaining == null) return "var(--faint)";
  return remaining >= 50 ? "var(--green)" : remaining >= 20 ? "var(--yellow)" : "var(--red)";
}
