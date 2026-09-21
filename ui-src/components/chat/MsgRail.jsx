// 消息轨道：主对话区左侧竖向刻度条，每条用户消息一道刻度，hover 弹出消息卡片。
// 迁移自 ui/ringpop.js 的 buildMsgRail/paintRailAt/showRailPop——刻度定位依赖
// getBoundingClientRect 实测布局，交互（mousemove 连续山峰/hover 宽限弹卡/点击滚动）
// 依赖命令式监听，故整体保留命令式实现，包在 useLayoutEffect 里（paint 前完成，不闪烁）。
import { useEffect, useLayoutEffect, useRef } from "react";
import { placeMenu } from "../../../ui/shell.js";

const RAIL_ROLE_LABEL = { user: "用户", assistant: "助手", thinking: "思考", tool: "工具", meta: "系统", approval: "确认", err: "错误" };
const RAIL_SNIPPET_LEN = 280;
const RAIL_W_BASE = 37.5; // 刻度默认长 37.5 个屏幕物理像素（水平长度）
const RAIL_W_PEAK = 2.5; // 山峰峰顶倍率（最接近鼠标的线）
const RAIL_FALLOFF = 24; // 高斯衰减半径（CSS px）：约 30px 间距下邻条 ≈1.9、隔条 ≈1.3

// 模块级轨道状态（刻度元素被 effect 全量重建，引用不随 React 渲染走）
let railPopEl = null; // 当前弹出的消息卡
let railHovering = false; // 指针在轨道附近期间重绘不重建刻度（「移开即弃」策略）
let railLeaveTimer = null; // 刻度→卡 间隙宽限定时器
let railSessionId = null; // 已绘制刻度所属会话，切换会话强制重建并收卡
let railTicks = []; // 当前刻度元素（连续山峰按鼠标 Y 与刻度中心距离逐个计算）
let railTickCY = []; // 刻度中心相对轨道顶的 Y（重建时预计算，mousemove 热路径零矩形读取）

// 刻度宽换算：尺寸单位是屏幕物理像素（Retina 下 1 CSS px = 2 设备像素）
function railBaseW() {
  return RAIL_W_BASE / (window.devicePixelRatio || 1);
}

// 连续山峰：按鼠标 Y 与每根刻度中心的距离连续分配长度（高斯衰减），峰顶=最近线加亮。
// 不依赖离散 hover 状态——指针在刻度间缝隙移动时动画天然连续不断
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

function dismissRailPop() {
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

// entries：{ key, role, text }（items.jsx 随遍历收集）；按 data-fk 锚点定位每条消息
export default function MsgRail({ entries, sessionId, streamRef }) {
  const railRef = useRef(null);

  // 重建刻度：每次消息列表/布局变化后（原 buildMsgRail；hover 中跳过，避免重绘打断
  // hover 态与进行中的宽度动画）
  useLayoutEffect(() => {
    const rail = railRef.current;
    const streamEl = streamRef.current;
    if (!rail || !streamEl) return;
    const userEntries = entries.filter((e) => e.role === "user");
    if (sessionId !== railSessionId) {
      railSessionId = sessionId;
      dismissRailPop();
    }
    if (userEntries.length <= 4) {
      // 用户消息 ≤ 4 条不显示轨道竖线
      rail.hidden = true;
      rail.innerHTML = "";
      dismissRailPop();
      return;
    }
    rail.hidden = false;
    rail.style.top = streamEl.offsetTop + "px";
    rail.style.height = streamEl.clientHeight + "px";
    if (railHovering) return;
    rail.innerHTML = "";
    railTicks = [];
    railTickCY = [];
    const railH = streamEl.clientHeight;
    const streamTop = streamEl.getBoundingClientRect().top;
    const dpr = window.devicePixelRatio || 1;
    const pitchBase = 30 / dpr; // 相邻刻度间隔 30 个屏幕物理像素
    const pitch = userEntries.length > 1 ? Math.min(pitchBase, (railH - 6) / (userEntries.length - 1)) : pitchBase;
    const startTop = Math.max(0, (railH - (userEntries.length - 1) * pitch) / 2); // 自中线向两边排
    const baseW = railBaseW();
    const tickH = 3.9 / dpr; // 线粗细 3.9 个屏幕物理像素（3 的 130%）
    userEntries.forEach((en, i) => {
      const anchor = streamEl.querySelector(`[data-fk="${en.key}"]`);
      if (!anchor) return; // 锚点未挂载（steer 气泡渲染延后等）：跳过本道刻度
      const r = anchor.getBoundingClientRect();
      const topDoc = r.top - streamTop + streamEl.scrollTop; // 消息在全文中的位置（点击定位用）
      const tick = document.createElement("div");
      tick.className = "rail-tick t-" + en.role;
      tick.style.top = startTop + i * pitch + "px";
      tick.style.height = tickH + "px";
      tick.style.borderRadius = tickH + "px"; // 胶囊端：半径超过半高会被钳制，保证两端全圆角
      tick.style.width = baseW + "px";
      railTickCY.push(startTop + i * pitch + tickH / 2); // 中心相对轨道顶，mousemove 热路径直接取用
      let hoverTimer = null; // 悬停 150ms 静止后才弹卡，划过不打扰
      tick.addEventListener("mouseenter", () => {
        railHovering = true; // 锁定重建：流式重绘不得销毁刻度，否则宽度动画被打断
        clearTimeout(railLeaveTimer); // 从邻刻度滑入：取消上一个刻度的收卡宽限
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => showRailPop(en, i, userEntries.length, tick), 150);
      });
      tick.addEventListener("mouseleave", (e) => {
        clearTimeout(hoverTimer); // 未停够 150ms 就离开：不弹卡
        if (railPopEl?.contains(e.relatedTarget)) return; // 直接移入卡片，由卡片 mouseleave 关闭
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
  });

  // 指针在轨道附近（含刻度间缝隙）：锁定重建并连续跟随；离开轨道且卡未弹出：立即回退。
  // 同步执行（计算量 = 每根刻度一次指数运算，远轻于一次重排），不依赖 rAF
  useEffect(() => {
    const onMove = (e) => {
      if (!railTicks.length) return;
      const rail = railRef.current;
      const streamEl = streamRef.current;
      if (!rail || !streamEl || rail.hidden) return;
      const rr = rail.getBoundingClientRect();
      const inside = e.clientX >= rr.left - 6 && e.clientX <= rr.right + 6 && e.clientY >= rr.top - 4 && e.clientY <= rr.bottom + 4;
      if (inside) {
        railHovering = true;
        paintRailAt(e.clientY, rr.top);
      } else if (!railPopEl) {
        railHovering = false;
        clearRailProfile();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      dismissRailPop();
    };
  }, [streamRef]);

  return <div id="msgRail" ref={railRef} hidden />;
}
