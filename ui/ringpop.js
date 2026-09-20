// 锚点 hover 弹卡（ring-pop 系）：上下文明细卡 + 主对话区左侧消息轨道。
// 弹卡设计规范见仓库 AGENTS.md「弹出卡片设计规范（ring-pop 系）」，本文件是其参考实现。
import { $, S, send, streamEl, activeOpen, fmtTokens } from "./core.js";
import { placeMenu } from "./shell.js";

// ---------- 上下文明细卡（hover 上下文环弹出，移开隐藏） ----------
let ringPop = null;
let ringHovering = false;
let ringLeaveTimer = null; // 环→卡 7px 间隙宽限定时器:移向卡片途中不关闭
let ringDetail = null; // 最近一次 context_detail（重绘限额段时保留）
let ringLimits = null; // 最近一次 limits_result

// 限额窗口 → 展示项:百分比取整,重置时间 24h 内给时刻、否则给月日
const LIMIT_LABELS = { "5-hour": "5小时", "5h": "5小时", weekly: "每周", daily: "每日", session: "会话" };
function fmtLimitWindow(w) {
  const pct = w.usedPercent != null ? Math.round(w.usedPercent) : w.remainingPercent != null ? 100 - Math.round(w.remainingPercent) : null;
  let reset = "";
  if (w.resetsAt) {
    const t = new Date(w.resetsAt);
    const withinDay = t.getTime() - Date.now() < 24 * 3600 * 1000;
    reset = withinDay
      ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
      : `${t.getMonth() + 1}月${t.getDate()}日`;
  }
  const raw = w.label || w.kind;
  return { label: LIMIT_LABELS[raw.toLowerCase()] ?? raw, pct, reset };
}

export function buildLimitsSection(limits) {
  const sec = document.createElement("div");
  sec.className = "cx-sec lx-sec";
  const head = document.createElement("div");
  head.className = "lx-head";
  const t = document.createElement("b");
  t.textContent = "剩余额度";
  const prov = document.createElement("span");
  prov.className = "lx-prov";
  prov.textContent = limits.label ?? "";
  head.append(t, prov);
  sec.appendChild(head);
  const body = document.createElement("div");
  body.className = "lx-body";
  if (limits.unsupported) {
    body.textContent = "该供应商暂不支持限额查询";
  } else if (limits.status === "notConfigured") {
    body.textContent = "未配置该供应商凭证";
  } else if (!limits.windows?.length && !limits.balance) {
    body.textContent = "限额暂不可用";
  } else {
    // 余额类供应商(host 侧 synthesize 的 metric:'credits' 窗口 + balance)只显示余额数字,
    // 不渲染进度条和百分比;有百分比窗口的供应商仍按窗口渲染
    const pctWindows = limits.windows.filter((w) => w.metric !== "credits");
    if (!pctWindows.length && limits.balance?.amount != null) {
      const bal = document.createElement("div");
      bal.className = "lx-bal";
      bal.textContent = `余额 ${limits.balance.amount} ${limits.balance.currency ?? ""}`.trim();
      body.appendChild(bal);
    } else if (!pctWindows.length) {
      body.textContent = "限额暂不可用";
    } else {
      const grid = document.createElement("div");
      grid.className = "lx-grid";
      const colors = ["#4a9eff", "#8b5cf6", "#f97316", "#22c55e"];
      pctWindows.slice(0, 4).forEach((w, i) => {
        const item = fmtLimitWindow(w);
        const col = document.createElement("div");
        col.className = "lx-col";
        const top = document.createElement("div");
        top.className = "lx-top";
        const lab = document.createElement("span");
        lab.textContent = item.label;
        top.appendChild(lab);
        const mid = document.createElement("div");
        mid.className = "lx-mid";
        mid.textContent = item.pct != null ? `${item.pct}%` : "—";
        if (item.reset) {
          const rs = document.createElement("span");
          rs.textContent = ` · ${item.reset}`;
          mid.appendChild(rs);
        }
        const bar = document.createElement("div");
        bar.className = "lx-bar";
        bar.innerHTML = `<i style="width:${item.pct != null ? Math.min(100, item.pct) : 0}%;background:${colors[i % colors.length]}"></i>`;
        col.append(top, mid, bar);
        grid.appendChild(col);
      });
      body.appendChild(grid);
      if (limits.balance?.amount != null) {
        const bal = document.createElement("div");
        bal.className = "lx-bal";
        bal.textContent = `余额 ${limits.balance.amount} ${limits.balance.currency ?? ""}`.trim();
        body.appendChild(bal);
      }
    }
  }
  sec.appendChild(body);
  return sec;
}

function buildCtxCard(detail, limits) {
  const pop = document.createElement("div");
  pop.className = "ring-pop";
  const b = detail?.breakdown;
  if (b) {
    const head = document.createElement("div");
    head.className = "cx-head";
    const t = document.createElement("b");
    t.textContent = "上下文";
    // 右侧数字与下方分类行同款:数值 | 百分比,竖线分隔、右对齐
    const total = document.createElement("span");
    total.className = "cx-total";
    const val = document.createElement("span");
    val.className = "cx-val";
    val.textContent = fmtTokens(b.usedTokens);
    const sep = document.createElement("i");
    sep.className = "cx-sep";
    const pc = document.createElement("span");
    pc.className = "cx-pct";
    pc.textContent = ((b.usedTokens / b.contextWindow) * 100).toFixed(1) + "%";
    total.append(val, sep, pc);
    head.append(t, total);
    pop.appendChild(head);
    const bar = document.createElement("div");
    bar.className = "cx-bar";
    bar.innerHTML = `<i style="width:${Math.min(100, (b.usedTokens / b.contextWindow) * 100).toFixed(1)}%"></i>`;
    pop.appendChild(bar);
    // 组成行固定 6 项(ZCode 同款分类):右侧数值与百分比等宽右对齐,中间虚线分隔。
    // MCP 工具 = mcp__ 前缀工具的 schema token(host 单独估算);其他 = 系统上下文注入
    const mcpTokens = b.mcpToolsTokens ?? 0;
    const pct = (v) => (b.usedTokens > 0 ? ((v / b.usedTokens) * 100).toFixed(1) : "0.0") + "%";
    const rows = [
      ["系统工具", Math.max(0, b.systemToolsTokens - mcpTokens), "#6fa8dc"],
      ["MCP 工具", mcpTokens, "#4a9eff"],
      ["系统提示词", b.systemPromptTokens, "#557fb8"],
      ["技能", b.skillsTokens, "#47699e"],
      ["消息", b.messagesTokens, "#3d5a85"],
      ["其他", b.systemContextTokens, "#6296cc"],
    ];
    for (const [label, v, color] of rows) {
      const r = document.createElement("div");
      r.className = "cx-row";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      const lab = document.createElement("span");
      lab.textContent = label;
      const val = document.createElement("span");
      val.className = "cx-val";
      val.textContent = fmtTokens(v);
      const sep = document.createElement("i");
      sep.className = "cx-sep";
      const pc = document.createElement("span");
      pc.className = "cx-pct";
      pc.textContent = pct(v);
      r.append(dot, lab, val, sep, pc);
      pop.appendChild(r);
    }
  }
  if (limits) {
    const sec = buildLimitsSection(limits);
    // 无上下文段(如新建会话页仅配额)时,限额段是唯一内容:去掉顶部横线,避免悬空分隔线
    if (!b) sec.classList.add("no-div");
    pop.appendChild(sec);
  }
  if (!pop.childNodes.length) pop.textContent = "上下文用量暂无数据";
  return pop;
}

// 弹层出现在环 hover 底板正上方:底边距底板顶 7px(2px 间隙 + 5px 偏移),水平中心对齐;
// 视觉坐标经 placeMenu 除以 zoomLevel 补偿(fixed + zoom 二次缩放坑)
function placeRingPop() {
  if (!ringPop) return;
  const r = $("ctxRing").getBoundingClientRect();
  const w = ringPop.offsetWidth;
  const h = ringPop.offsetHeight;
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
  const top = Math.max(r.top - h - 7, 8);
  placeMenu(ringPop, left, top);
}

// 关闭卡片:离开环且未进入卡片(含宽限超时)时调用
function dismissRingPop() {
  ringHovering = false;
  clearTimeout(ringLeaveTimer);
  ringLeaveTimer = null;
  ringPop?.remove();
  ringPop = null;
}

// 挂载卡片:定位 + 接管卡片自身 hover(进入取消宽限关闭,离开关闭;卡片区域外不再保持)
function mountRingPop(pop) {
  ringPop = pop;
  document.body.appendChild(pop);
  placeRingPop();
  pop.addEventListener("mouseenter", () => clearTimeout(ringLeaveTimer));
  pop.addEventListener("mouseleave", () => dismissRingPop());
}

function showRingPop() {
  ringPop?.remove();
  const pop = buildCtxCard(ringDetail, ringLimits);
  if (!pop.childNodes.length) pop.textContent = "加载中…";
  mountRingPop(pop);
}

// 数据到达:鼠标仍悬停在环/卡片上才重绘(移开即弃)
function refreshRingPop() {
  if (!ringHovering || !ringPop) return;
  const pop = buildCtxCard(ringDetail, ringLimits);
  ringPop.replaceWith(pop);
  mountRingPop(pop); // 重新定位(内容高度变化)并重新接管 hover
}

export function fillCtxCard(detail) {
  ringDetail = detail;
  refreshRingPop();
}

export function fillLimits(limits) {
  ringLimits = limits;
  refreshRingPop();
}

// ---------- 消息轨道（主对话区左侧刻度条：每条用户消息一道刻度，hover 弹消息卡） ----------
let railPopEl = null; // 当前弹出的消息卡（复用 ring-pop 样式与 ringpop 动画）
let railHovering = false; // 指针在轨道附近期间重绘不重建刻度（与 ring-pop「移开即弃」同款策略）
let railLeaveTimer = null; // 刻度→卡 间隙宽限定时器
let railSessionId = null; // 已绘制刻度所属会话，切换会话强制重建并收卡
let railTicks = []; // 当前刻度元素（连续山峰按鼠标 Y 与刻度中心距离逐个计算）
let railTickCY = []; // 刻度中心相对轨道顶的 Y（重建时预计算，mousemove 热路径零矩形读取）

const RAIL_ROLE_LABEL = { user: "用户", assistant: "助手", thinking: "思考", tool: "工具", meta: "系统", approval: "确认", err: "错误" };
const RAIL_SNIPPET_LEN = 280;
const RAIL_W_BASE = 37.5; // 刻度默认长 37.5 个屏幕物理像素（水平长度）
const RAIL_W_PEAK = 2.5; // 山峰峰顶倍率（最接近鼠标的线）
const RAIL_FALLOFF = 24; // 高斯衰减半径（CSS px）：约 30px 间距下邻条 ≈1.9、隔条 ≈1.3

// 刻度宽换算：尺寸单位是屏幕物理像素（Retina 下 1 CSS px = 2 设备像素），CSS px = 设备像素 / devicePixelRatio
function railBaseW() {
  return RAIL_W_BASE / (window.devicePixelRatio || 1);
}

// 连续山峰：按鼠标 Y 与每根刻度中心的距离连续分配长度（高斯衰减），峰顶=最近线加亮。
// 不依赖离散 hover 状态——指针在刻度间缝隙移动时动画天然连续不断。
// 刻度中心在重建时预计算（railTickCY，相对轨道顶），mousemove 内不做矩形读取，零强制布局，实时跟手
function paintRailAt(clientY, railTop) {
  const base = railBaseW();
  let best = -1;
  let bestD = Infinity;
  railTicks.forEach((t, j) => {
    const d = Math.abs(clientY - (railTop + railTickCY[j]));
    if (d < bestD) {
      bestD = d;
      best = j;
    }
    const f = 1 + (RAIL_W_PEAK - 1) * Math.exp(-((d / RAIL_FALLOFF) ** 2));
    t.style.width = base * f + "px";
  });
  railTicks.forEach((t, j) => t.classList.toggle("on", j === best));
}

function clearRailProfile() {
  const base = railBaseW();
  railTicks.forEach((t) => {
    t.style.width = base + "px";
    t.classList.remove("on");
  });
}

// 工具消息摘要：工具名 + 命令/文件，逗号连接
export function railToolText(item) {
  if (item.group) return ["更改", ...item.group.flatMap((g) => g.files || [])].filter(Boolean).join(" · ");
  const parts = [item.text];
  if (item.args?.command) parts.push(String(item.args.command));
  if (item.name === "hub") {
    const op = item.args?.op || "";
    const n = item.args?.name || item.args?.application || "";
    if (op || n) parts.push(`${op} ${n}`.trim());
  }
  if (item.files?.length) parts.push(item.files.join("、"));
  return parts.filter(Boolean).join(" · ");
}

export function dismissRailPop() {
  railHovering = false;
  clearTimeout(railLeaveTimer);
  railLeaveTimer = null;
  railPopEl?.remove();
  railPopEl = null;
  clearRailProfile(); // 收卡同时山峰回退
}

// 弹卡：刻度右侧 8px、垂直居中对齐刻度，视口内收 8px；fixed 坐标经 placeMenu 除 zoom 补偿
function showRailPop(entry, idx, total, tick) {
  railHovering = true;
  railPopEl?.remove();
  const pop = document.createElement("div");
  pop.className = "ring-pop rail-pop";
  const head = document.createElement("div");
  head.className = "rp-head";
  const role = document.createElement("b");
  role.className = "rp-role";
  role.textContent = RAIL_ROLE_LABEL[entry.role] ?? entry.role;
  const idxEl = document.createElement("span");
  idxEl.className = "rp-idx";
  idxEl.textContent = `${idx + 1} / ${total}`;
  head.append(role, idxEl);
  const body = document.createElement("div");
  body.className = "rp-body";
  let text = (entry.text || "").trim();
  if (text.length > RAIL_SNIPPET_LEN) text = text.slice(0, RAIL_SNIPPET_LEN) + " …";
  body.textContent = text || "（无文本内容）";
  pop.append(head, body);
  pop.addEventListener("mouseenter", () => clearTimeout(railLeaveTimer));
  pop.addEventListener("mouseleave", () => dismissRailPop());
  document.body.appendChild(pop);
  railPopEl = pop;
  const r = tick.getBoundingClientRect();
  const top = Math.min(Math.max(r.top + r.height / 2 - pop.offsetHeight / 2, 8), window.innerHeight - pop.offsetHeight - 8);
  placeMenu(pop, r.right + 8, Math.max(8, top));
}

// 刻度尺寸单位是设备物理像素（Retina 下 1 CSS px = 2 设备像素），换算：CSS px = 设备像素 / devicePixelRatio；
// 从轨道中线向两边等距扩张（数量撑不下时等比压缩间距）；点击刻度滚动定位到该消息
export function buildMsgRail(entries, sessionId) {
  const rail = $("msgRail");
  if (sessionId !== railSessionId) {
    railSessionId = sessionId;
    dismissRailPop();
  }
  if (entries.length <= 4) { // 用户消息 ≤ 4 条不显示轨道竖线
    rail.hidden = true;
    rail.innerHTML = "";
    dismissRailPop();
    return;
  }
  rail.hidden = false;
  rail.style.top = streamEl.offsetTop + "px";
  rail.style.height = streamEl.clientHeight + "px";
  if (railHovering) return; // hover 中不重排，避免重绘打断 hover 态与进行中的宽度动画
  rail.innerHTML = "";
  railTicks = [];
  railTickCY = [];
  const railH = streamEl.clientHeight;
  const streamTop = streamEl.getBoundingClientRect().top;
  const dpr = window.devicePixelRatio || 1;
  const pitchBase = 30 / dpr; // 相邻刻度间隔 30 个屏幕物理像素
  const pitch = entries.length > 1 ? Math.min(pitchBase, (railH - 6) / (entries.length - 1)) : pitchBase;
  const startTop = Math.max(0, (railH - (entries.length - 1) * pitch) / 2); // 自中线向两边排
  const baseW = railBaseW();
  const tickH = 3.9 / dpr; // 线粗细 3.9 个屏幕物理像素（3 的 130%）
  entries.forEach((en, i) => {
    const r = en.el.getBoundingClientRect();
    const topDoc = r.top - streamTop + streamEl.scrollTop; // 消息在全文中的位置（点击定位用）
    const tick = document.createElement("div");
    tick.className = "rail-tick t-" + en.role;
    tick.style.top = startTop + i * pitch + "px";
    tick.style.height = tickH + "px"; // 长度（水平宽）见 RAIL_W_BASE
    tick.style.borderRadius = tickH + "px"; // 胶囊端：半径超过半高会被钳制，保证两端全圆角
    tick.style.width = baseW + "px";
    railTickCY.push(startTop + i * pitch + tickH / 2); // 中心相对轨道顶，mousemove 热路径直接取用
    let hoverTimer = null; // 悬停 150ms 静止后才弹卡，划过不打扰（线动画由全局 mousemove 连续驱动）
    tick.addEventListener("mouseenter", () => {
      railHovering = true; // 锁定重建：流式重绘不得销毁刻度，否则宽度动画被打断、短灰线复现
      clearTimeout(railLeaveTimer); // 从邻刻度滑入：取消上一个刻度的收卡宽限
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => showRailPop(en, i, entries.length, tick), 150);
    });
    tick.addEventListener("mouseleave", (e) => {
      clearTimeout(hoverTimer); // 未停够 150ms 就离开：不弹卡（150ms 仅约束卡片，不约束线动画）
      if (railPopEl?.contains(e.relatedTarget)) return; // 直接移入卡片，由卡片 mouseleave 关闭
      // 线动画/山峰保持由全局 mousemove 按指针位置接管：缝隙中连续不断，离开轨道带时统一回退
      clearTimeout(railLeaveTimer);
      railLeaveTimer = setTimeout(() => {
        if (railPopEl && !railPopEl.matches(":hover")) dismissRailPop();
      }, 200);
    });
    tick.addEventListener("click", () => {
      streamEl.scrollTo({ top: Math.max(0, topDoc - streamEl.clientHeight / 2 + r.height / 2), behavior: "smooth" });
    });
    rail.appendChild(tick);
    railTicks.push(tick);
  });
}

export function initRingpop() {
  $("ctxRing").addEventListener("mouseenter", () => {
    const s = activeOpen();
    ringHovering = true;
    ringDetail = null;
    ringLimits = null; // 限额段先显示加载中,结果到达后补
    showRingPop();
    if (s) {
      send({ type: "get_context_detail", sessionId: s.sessionId });
      send({ type: "get_limits", sessionId: s.sessionId });
    } else {
      // 不在会话中也允许弹出:不显示上下文明细,仅按当前输入框所选模型的供应商显示配额
      // 模型 id 为 "provider/model" 格式(host modelsPayload),直接取首段,不依赖模型设置页的 modelCatalog
      const prov = S.newSessionModel ? S.newSessionModel.split("/")[0] : "";
      if (prov) send({ type: "get_limits", provider: prov });
      else ringPop.textContent = "暂无可用模型";
    }
  });
  $("ctxRing").addEventListener("mouseleave", (e) => {
    if (ringPop?.contains(e.relatedTarget)) return; // 直接移入卡片,由卡片 mouseleave 关闭
    clearTimeout(ringLeaveTimer);
    // 仅当向上朝卡片区域离开时才宽限(环↔卡 7px 间隙,途中 relatedTarget 可能为空);
    // 往旁边/下方离开立即收回
    const r = $("ctxRing").getBoundingClientRect();
    const pr = ringPop?.getBoundingClientRect();
    const towardCard = !!pr && e.clientY <= r.top + 2 && e.clientX >= pr.left - 12 && e.clientX <= pr.right + 12;
    if (!towardCard) {
      dismissRingPop();
      return;
    }
    ringLeaveTimer = setTimeout(() => {
      if (ringPop && !ringPop.matches(":hover")) dismissRingPop();
    }, 250);
  });

  // 指针在轨道附近（含刻度间缝隙）：锁定重建并连续跟随；离开轨道且卡未弹出：立即回退。
  // 同步执行（计算量 = 每根刻度一次矩形读取 + 指数运算，远轻于一次重排），不依赖 rAF——后台/无帧环境也即时响应
  window.addEventListener("mousemove", (e) => {
    if (!railTicks.length) return;
    const rail = $("msgRail");
    if (!rail || rail.hidden) return;
    const rr = rail.getBoundingClientRect();
    const inside = e.clientX >= rr.left - 6 && e.clientX <= rr.right + 6 && e.clientY >= rr.top - 4 && e.clientY <= rr.bottom + 4;
    if (inside) {
      railHovering = true;
      paintRailAt(e.clientY, rr.top);
    } else if (!railPopEl) {
      railHovering = false;
      clearRailProfile();
    }
  });
}
