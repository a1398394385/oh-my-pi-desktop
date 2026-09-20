// 设置·统计页：token 总量/峰值/时长/连续天数热力图 + 14 天趋势曲线 + 模型分布环图。
import { $, S } from "../core.js";

const STAT_COLORS = ["#4a9eff", "#34c759", "#a86fe0", "#e05c5c", "#e5a14e", "#4ec9b0"];

function fmtCompactTokens(n) {
  if (n == null || n <= 0) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  if (n >= 1024) return (n / 1024).toFixed(1) + "k";
  return String(n);
}
function fmtDurationMs(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "秒";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "分" + (s % 60) + "秒";
  const h = Math.floor(m / 60);
  return h + "小时" + (m % 60) + "分钟";
}

export function renderStatsPage() {
  const st = S.usageStats;
  if (!st) return;
  $("stTokens").textContent = fmtCompactTokens(st.totalTokens);
  $("stPeak").textContent = fmtCompactTokens(st.peakTokens);
  $("stLongest").textContent = fmtDurationMs(st.longestMs);
  $("stStreak").textContent = (st.currentStreak || 0) + " 天";
  $("stLongStreak").textContent = (st.longestStreak || 0) + " 天";
  const heatEl = $("heatmap");
  const cols = 53;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const origin = new Date(today);
  origin.setUTCDate(origin.getUTCDate() - ((origin.getUTCDay() + 6) % 7) - (cols - 1) * 7);
  const months = [];
  let cells = "";
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
      cells += `<i class="hm-c" style="background:var(--hm${lv})" title="${key} · ${v} 会话"></i>`;
    }
  }
  heatEl.innerHTML = `<div class="hm-months">${months.map((m) => `<span>${m}</span>`).join("")}</div><div class="hm-grid">${cells}</div>`;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  $("trendX").innerHTML = days.map((d) => `<span>${d.slice(5).replace("-", "月")}日</span>`).join("");
  const svg = $("trend");
  while (svg.lastChild) svg.removeChild(svg.lastChild);
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
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", dpath);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#4a9eff");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  $("trendLegend").innerHTML = '<span class="lg"><span class="dot" style="background:#4a9eff"></span>全部模型</span>';
  const entries = Object.entries(st.byModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const donut = $("donut");
  while (donut.lastChild) donut.removeChild(donut.lastChild);
  const r = 62, cx = 90, cy = 90, C = 2 * Math.PI * r;
  let off = 0;
  entries.forEach(([, v], i) => {
    const len = C * (v / total);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", cx);
    circle.setAttribute("cy", cy);
    circle.setAttribute("r", r);
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", STAT_COLORS[i % STAT_COLORS.length]);
    circle.setAttribute("stroke-width", "24");
    circle.setAttribute("stroke-dasharray", `${len} ${C - len}`);
    circle.setAttribute("stroke-dashoffset", String(-off));
    circle.setAttribute("transform", `rotate(-90 ${cx} ${cy})`);
    donut.appendChild(circle);
    off += len;
  });
  const t1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t1.setAttribute("x", cx);
  t1.setAttribute("y", cy - 2);
  t1.setAttribute("text-anchor", "middle");
  t1.setAttribute("fill", document.documentElement.dataset.theme === "light" ? "#1d1d21" : "#ededef");
  t1.setAttribute("font-size", "18");
  t1.setAttribute("font-weight", "700");
  t1.textContent = fmtCompactTokens(st.totalTokens);
  const t2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t2.setAttribute("x", cx);
  t2.setAttribute("y", cy + 16);
  t2.setAttribute("text-anchor", "middle");
  t2.setAttribute("fill", document.documentElement.dataset.theme === "light" ? "#909098" : "#7b7b86");
  t2.setAttribute("font-size", "11");
  t2.textContent = "tokens";
  donut.appendChild(t1);
  donut.appendChild(t2);
  const legend = $("donutLegend");
  legend.replaceChildren();
  if (!entries.length) {
    const dl = document.createElement("div");
    dl.className = "dl";
    dl.textContent = "暂无模型用量";
    legend.appendChild(dl);
  } else {
    for (const [i, [name, v]] of entries.entries()) {
      const dl = document.createElement("div");
      dl.className = "dl";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = STAT_COLORS[i % STAT_COLORS.length];
      dl.appendChild(dot);
      dl.appendChild(document.createTextNode(name));
      const rv = document.createElement("span");
      rv.className = "rv";
      rv.appendChild(document.createTextNode(((v / total) * 100).toFixed(1) + "%"));
      const ii = document.createElement("i");
      ii.textContent = fmtCompactTokens(v) + " tokens";
      rv.appendChild(ii);
      dl.appendChild(rv);
      legend.appendChild(dl);
    }
  }
}
