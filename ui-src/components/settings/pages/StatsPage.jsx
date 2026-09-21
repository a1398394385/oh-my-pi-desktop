// 设置·使用统计页：token 总量/峰值/时长/连续天数热力图 + 14 天趋势曲线 + 模型分布环图。
// 逻辑 1:1 平移自旧版 ui/settings/stats.js，图形由 React 声明式生成（与旧版命令式 SVG 视觉一致）。
import { useEffect, useMemo } from "react";
import { S, useStore, send } from "../../../store.js";

// 与旧版一致的统计配色（图形专用色板，沿袭原设计）
const STAT_COLORS = ["#4a9eff", "#34c759", "#a86fe0", "#e05c5c", "#e5a14e", "#4ec9b0"];

// 紧凑 token 数格式化（旧版 fmtCompactTokens 平移）
function fmtCompactTokens(n) {
  if (n == null || n <= 0) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  if (n >= 1024) return (n / 1024).toFixed(1) + "k";
  return String(n);
}

// 时长格式化（旧版 fmtDurationMs 平移）
function fmtDurationMs(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "秒";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "分" + (s % 60) + "秒";
  const h = Math.floor(m / 60);
  return h + "小时" + (m % 60) + "分钟";
}

// 主题相关文字色（沿袭旧版按 data-theme 取色）
function themeTextColors() {
  const light = document.documentElement.dataset.theme === "light";
  return { main: light ? "#1d1d21" : "#ededef", sub: light ? "#909098" : "#7b7b86" };
}

// Token 活动热力图：53 列 × 7 行，等级 0-4 对应 var(--hm0..--hm4)
function buildHeatmap(st) {
  const cols = 53;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const origin = new Date(today);
  origin.setUTCDate(origin.getUTCDate() - ((origin.getUTCDay() + 6) % 7) - (cols - 1) * 7);
  const months = [];
  const cells = [];
  let lastMonth = -1;
  for (let c = 0; c < cols; c++) {
    const d0 = new Date(origin);
    d0.setUTCDate(d0.getUTCDate() + c * 7);
    if (d0.getUTCMonth() !== lastMonth) {
      months.push((d0.getUTCMonth() + 1) + "月");
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
function buildTrend(st) {
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
function buildDonut(st) {
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
  useStore(); // S.usageStats 更新时重渲染
  const st = S.usageStats;

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
      <div className="set-tt">使用统计 <span className="stag on">应用用量</span></div>
      <div className="set-card stats" id="statsCards">
        <div className="st"><b>{st ? fmtCompactTokens(st.totalTokens) : "—"}</b><span>累计 Token 数</span></div>
        <div className="st"><b>{st ? fmtCompactTokens(st.peakTokens) : "—"}</b><span>峰值 Token 数</span></div>
        <div className="st"><b>{st ? fmtDurationMs(st.longestMs) : "—"}</b><span>最长聊天时长</span></div>
        <div className="st"><b>{st ? (st.currentStreak || 0) + " 天" : "—"}</b><span>当前连续天数</span></div>
        <div className="st"><b>{st ? (st.longestStreak || 0) + " 天" : "—"}</b><span>最长连续天数</span></div>
      </div>
      <div className="set-card" style={{ marginTop: 16 }}>
        <div className="card-head">Token 活动</div>
        <div id="heatmap">
          {heat && (
            <>
              <div className="hm-months">{heat.months.map((m, i) => <span key={i}>{m}</span>)}</div>
              <div className="hm-grid">
                {heat.cells.map((c) => (
                  <i key={c.key} className="hm-c" style={{ background: `var(--hm${c.lv})` }} title={`${c.key} · ${c.v} 会话`} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="set-group-tt">近 14 日 Token 趋势</div>
      <div className="set-card">
        <div className="card-head">每日 Token 趋势图</div>
        <div className="legend" id="trendLegend">
          <span className="lg"><span className="dot" style={{ background: "#4a9eff" }}></span>全部模型</span>
        </div>
        <svg id="trend" viewBox="0 0 760 200" preserveAspectRatio="none">
          {trend && (
            <path d={trend.dpath} fill="none" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" />
          )}
        </svg>
        <div className="trend-x" id="trendX">
          {trend && trend.days.map((d) => <span key={d}>{d.slice(5).replace("-", "月")}日</span>)}
        </div>
      </div>
      <div className="set-card" style={{ marginTop: 16 }}>
        <div className="card-head">模型用量</div>
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
                  {fmtCompactTokens(st.totalTokens)}
                </text>
                <text x="90" y="106" textAnchor="middle" fill={textColors.sub} fontSize="11">tokens</text>
              </>
            )}
          </svg>
          <div className="donut-legend" id="donutLegend">
            {donut && (donut.entries.length === 0 ? (
              <div className="dl">暂无模型用量</div>
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
