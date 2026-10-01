// 设置·使用统计页：token 总量/峰值/时长/连续天数热力图 + 14 天趋势曲线 + 模型分布环图。
// 逻辑 1:1 平移自旧版 ui/settings/stats.js，图形由 React 声明式生成（与旧版命令式 SVG 视觉一致）。
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, fmtDurationMs } from "../../../store";
import i18next, { t } from "../../../i18n";

// 使用统计负载（宿主 get_usage_stats 回包；usageStats 落 store，字段边界以宿主回包为准）
interface UsageStats {
  totalTokens?: number;
  peakTokens?: number;
  longestMs?: number;
  currentStreak?: number;
  longestStreak?: number;
  heat?: Record<string, number>;
  byDay?: Record<string, number>;
  byModel?: Record<string, number>;
}

// 与旧版一致的统计配色（图形专用色板，沿袭原设计）
const STAT_COLORS: string[] = ["#4a9eff", "#34c759", "#a86fe0", "#e05c5c", "#e5a14e", "#4ec9b0"];

// 紧凑 token 数格式化（旧版 fmtCompactTokens 平移）。
// zh keeps the Chinese large-number units (values from the pack); en uses the B/M/k decimal ladder.
function fmtCompactTokens(n: number | null | undefined): string {
  if (n == null || n <= 0) return "0";
  if (i18next.language === "zh-CN") {
    if (n >= 1e8) return (n / 1e8).toFixed(1) + t("settingsPage.stats.unitYi");
    if (n >= 1e4) return (n / 1e4).toFixed(1) + t("settingsPage.stats.unitWan");
  } else {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  }
  if (n >= 1024) return (n / 1024).toFixed(1) + "k";
  return String(n);
}

// 主题相关文字色（沿袭旧版按 data-theme 取色）
function themeTextColors(): { main: string; sub: string } {
  const light = document.documentElement.dataset.theme === "light";
  return { main: light ? "#1d1d21" : "#ededef", sub: light ? "#909098" : "#7b7b86" };
}

// Token 活动热力图：53 列 × 7 行，等级 0-4 对应 var(--hm0..--hm4)。
// Month labels via Intl short month (zh renders the same short form as the legacy
// UI; en gets Sep etc. for free).
function buildHeatmap(st: UsageStats): { months: string[]; cells: Array<{ key: string; v: number; lv: number }> } {
  const cols = 53;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const origin = new Date(today);
  origin.setUTCDate(origin.getUTCDate() - ((origin.getUTCDay() + 6) % 7) - (cols - 1) * 7);
  const months = [];
  const cells = [];
  const monthFmt = new Intl.DateTimeFormat(i18next.language, { month: "short", timeZone: "UTC" });
  let lastMonth = -1;
  for (let c = 0; c < cols; c++) {
    const d0 = new Date(origin);
    d0.setUTCDate(d0.getUTCDate() + c * 7);
    if (d0.getUTCMonth() !== lastMonth) {
      months.push(monthFmt.format(d0));
      lastMonth = d0.getUTCMonth();
    } else months.push("");
    for (let r = 0; r < 7; r++) {
      const d = new Date(origin);
      d.setUTCDate(d.getUTCDate() + c * 7 + r);
      const key = d.toISOString().slice(0, 10);
      const v = st.heat?.[key] ?? 0;
      const lv = v <= 0 ? 0 : v === 1 ? 1 : v < 4 ? 2 : v < 8 ? 3 : 4;
      cells.push({ key, v, lv });
    }
  }
  return { months, cells };
}

// 近 14 日趋势：Catmull-Rom 平滑曲线路径
function buildTrend(st: UsageStats): { days: string[]; dpath: string } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const pts = days.map((d, i) => {
    const v = st.byDay?.[d] ?? 0;
    return [12 + i * (736 / 13), v];
  });
  const max = Math.max(1, ...pts.map((p) => p[1]));
  const mapped = pts.map(([x, v]) => [x, 188 - (v / max) * 160]);
  let dpath = `M ${mapped[0][0]} ${mapped[0][1]}`;
  for (let i = 0; i < mapped.length - 1; i++) {
    const p0 = mapped[Math.max(0, i - 1)], p1 = mapped[i], p2 = mapped[i + 1], p3 = mapped[Math.min(mapped.length - 1, i + 2)];
    dpath += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
  }
  return { days, dpath };
}

// 模型用量环图：按用量取前 5，环形分段
function buildDonut(st: UsageStats): {
  entries: Array<[string, number]>;
  total: number;
  segs: Array<{ name: string; v: number; color: string; dasharray: string; dashoffset: string }>;
  r: number;
  cx: number;
  cy: number;
} {
  const entries = Object.entries(st.byModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const r = 62, cx = 90, cy = 90, C = 2 * Math.PI * r;
  let off = 0;
  const segs = entries.map(([name, v], i) => {
    const len = C * (v / total);
    const seg = {
      name,
      v,
      color: STAT_COLORS[i % STAT_COLORS.length],
      dasharray: `${len} ${C - len}`,
      dashoffset: String(-off),
    };
    off += len;
    return seg;
  });
  return { entries, total, segs, r, cx, cy };
}

export default function StatsPage() {
  const { t } = useTranslation();
  const st = useAppStore((s) => s.usageStats); // selector 订阅回包刷新

  // 进入页面即刷新统计（对应旧版 openSettings 里的 get_usage_stats）
  useEffect(() => {
    send({ type: "get_usage_stats" });
  }, []);

  const heat = useMemo(() => (st ? buildHeatmap(st) : null), [st]);
  const trend = useMemo(() => (st ? buildTrend(st) : null), [st]);
  const donut = useMemo(() => (st ? buildDonut(st) : null), [st]);
  const textColors = themeTextColors();

  return (
    <div className="set-page" id="pg-stats">
      <div className="set-tt">{t("settingsPage.nav.stats")} <span className="stag on">{t("settingsPage.stats.appUsage")}</span></div>
      <div className="set-card stats" id="statsCards">
        <div className="st"><b>{st ? fmtCompactTokens(st.totalTokens) : "—"}</b><span>{t("settingsPage.stats.totalTokens")}</span></div>
        <div className="st"><b>{st ? fmtCompactTokens(st.peakTokens) : "—"}</b><span>{t("settingsPage.stats.peakTokens")}</span></div>
        <div className="st"><b>{st ? fmtDurationMs(st.longestMs) : "—"}</b><span>{t("settingsPage.stats.longestChat")}</span></div>
        <div className="st"><b>{st ? t("settingsPage.stats.streakDays", { n: st.currentStreak || 0 }) : "—"}</b><span>{t("settingsPage.stats.currentStreak")}</span></div>
        <div className="st"><b>{st ? t("settingsPage.stats.streakDays", { n: st.longestStreak || 0 }) : "—"}</b><span>{t("settingsPage.stats.longestStreak")}</span></div>
      </div>
      <div className="set-card" style={{ marginTop: 16 }}>
        <div className="card-head">{t("settingsPage.stats.tokenActivity")}</div>
        <div id="heatmap">
          {heat && (
            <>
              <div className="hm-months">{heat.months.map((m, i) => <span key={i}>{m}</span>)}</div>
              <div className="hm-grid">
                {heat.cells.map((c) => (
                  <i key={c.key} className="hm-c" style={{ background: `var(--hm${c.lv})` }} title={t("settingsPage.stats.sessionCount", { date: c.key, count: c.v })} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.stats.trendGroup")}</div>
      <div className="set-card">
        <div className="card-head">{t("settingsPage.stats.trendHead")}</div>
        <div className="legend" id="trendLegend">
          <span className="lg"><span className="dot" style={{ background: "#4a9eff" }}></span>{t("settingsPage.stats.allModels")}</span>
        </div>
        <svg id="trend" viewBox="0 0 760 200" preserveAspectRatio="none">
          {trend && (
            <path d={trend.dpath} fill="none" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" />
          )}
        </svg>
        <div className="trend-x" id="trendX">
          {trend && trend.days.map((d) => <span key={d}>{new Intl.DateTimeFormat(i18next.language, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(d + "T00:00:00Z"))}</span>)}
        </div>
      </div>
      <div className="set-card" style={{ marginTop: 16 }}>
        <div className="card-head">{t("settingsPage.stats.modelUsage")}</div>
        <div className="donut-row">
          <svg id="donut" viewBox="0 0 180 180" width="170" height="170">
            {donut && donut.segs.map((s) => (
              <circle
                key={s.name}
                cx={donut.cx}
                cy={donut.cy}
                r={donut.r}
                fill="none"
                stroke={s.color}
                strokeWidth="24"
                strokeDasharray={s.dasharray}
                strokeDashoffset={s.dashoffset}
                transform={`rotate(-90 ${donut.cx} ${donut.cy})`}
              />
            ))}
            {donut && (
              <>
                <text x="90" y="88" textAnchor="middle" fill={textColors.main} fontSize="18" fontWeight="700">
                  {fmtCompactTokens(st!.totalTokens)} {/* donut 非空 ⇒ st 非空(见上方 useMemo) */}
                </text>
                <text x="90" y="106" textAnchor="middle" fill={textColors.sub} fontSize="11">tokens</text>
              </>
            )}
          </svg>
          <div className="donut-legend" id="donutLegend">
            {donut && (donut.entries.length === 0 ? (
              <div className="dl">{t("settingsPage.stats.noModelUsage")}</div>
            ) : (
              donut.entries.map(([name, v], i) => (
                <div className="dl" key={name}>
                  <span className="dot" style={{ background: STAT_COLORS[i % STAT_COLORS.length] }}></span>
                  {name}
                  <span className="rv">
                    {((v / donut.total) * 100).toFixed(1) + "%"}
                    <i>{fmtCompactTokens(v) + " tokens"}</i>
                  </span>
                </div>
              ))
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
