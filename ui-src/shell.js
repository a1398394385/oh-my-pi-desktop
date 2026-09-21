// 窗口 shell：主题（深/浅/跟随系统）、⌘ 与菜单缩放、菜单协调、左右边栏拖宽、
// 内容列宽度分段、消息轨道显隐、fixed 菜单坐标补偿、railToolText。
// 1:1 平移自 ui/shell.js + ui/ringpop.js 的 railToolText 段，不依赖 ui/ 旧模块。
// DOM 副作用保持命令式；React 组件经 omp:close-menus / omp:zoom 自定义事件协作。
import { S } from "./store.js";

// ---------- 菜单协调 ----------
// React 侧消费者（Composer 菜单等 state 态）监听 omp:close-menus 关闭自身；
// 设置页 Sel 下拉（ModelPage/McpPage/SkillsPage 等）的 .menu.open 为 DOM class 态，
// 直接摘 class（旧版 closeAllMenus 同款收尾）。
export function closeAllMenus() {
  document.dispatchEvent(new CustomEvent("omp:close-menus"));
  for (const m of document.querySelectorAll(".menu.open")) m.classList.remove("open");
  for (const b of document.querySelectorAll(".pill-btn.active")) b.classList.remove("active");
}

// ---------- 主题（深色 / 浅色 / 跟随系统） ----------
let themeMode = "dark";
const themeMq = matchMedia("(prefers-color-scheme: dark)");
export function applyTheme(mode) {
  themeMode = mode;
  const dark = mode === "system" ? themeMq.matches : mode === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem("omp-theme", mode);
  } catch {}
  for (const h of document.querySelectorAll(".fd-holder")) h.classList.toggle("d2h-dark-color-scheme", dark);
  // 设置页主题 Sel 的选中标签是各页面组件内 state（AppearancePage/GeneralPage 自有平移），
  // 它们以 dataset.theme 为唯一事实来源，此处不碰 DOM 标签。
}

// 原生菜单「切换深浅色主题」：深浅互换（system 态按当前生效色归位后再切）
export function toggleTheme() {
  const dark = themeMode === "system" ? themeMq.matches : themeMode === "dark";
  applyTheme(dark ? "light" : "dark");
}

// ---------- 边栏拖动调宽 ----------
// 宽度走 CSS 变量，localStorage 记忆；保证中部卡片支持压缩至最小 30% 视口总宽度。
// 首次调用即恢复 localStorage 里的记忆宽度（omp-w-*）。
export function attachResizer(handleId, cssVar, min, invert) {
  const panel = handleId === "left-resizer" ? document.getElementById("sidebar") : document.getElementById("right");
  if (!panel) return;
  const apply = (w) => document.documentElement.style.setProperty(cssVar, w + "px");
  try {
    const saved = localStorage.getItem("omp-w-" + cssVar);
    if (saved) apply(+saved);
  } catch {}
  document.getElementById(handleId)?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const move = (ev) => {
      const dx = (ev.clientX - startX) / S.zoomLevel;
      const wWin = document.documentElement.clientWidth || window.innerWidth || 1000;
      // 中部卡片最小宽度保证为应用总宽度的 30%（支持继续压缩至 30%）
      const minMainW = Math.max(240, Math.floor(wWin * 0.30));
      const otherPanel = invert ? document.getElementById("sidebar") : document.getElementById("right");
      const otherW = (otherPanel && !otherPanel.classList.contains("collapsed")) ? otherPanel.offsetWidth : 0;
      const totalGaps = 32;
      const maxAllowed = Math.max(min, wWin - minMainW - otherW - totalGaps);

      let targetW = invert ? (startW - dx) : (startW + dx);
      targetW = Math.max(min, Math.min(targetW, maxAllowed));
      const w = Math.round(targetW);
      apply(w);
      try {
        localStorage.setItem("omp-w-" + cssVar, w);
      } catch {}
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ---------- Cmd +/-/0 与原生菜单缩放 ----------
// 只缩放三个布局容器：body 整体 zoom 会把 position:fixed 的菜单二次缩放，
// 导致右键菜单/主题菜单的渲染偏移与点击命中错位
// （zoomTargets 延迟初始化：App 挂载前 #sidebar/#main/#right 尚不存在）
let zoomTargets = null;
function applyZoom() {
  if (!zoomTargets) zoomTargets = ["sidebar", "main", "right"].map((id) => document.getElementById(id));
  for (const el of zoomTargets) if (el) el.style.zoom = S.zoomLevel;
  // zoom 会改变布局宽度但不触发 ResizeObserver（Chrome/WebKit 行为），通知 composer 重算底栏收缩
  window.dispatchEvent(new CustomEvent("omp:zoom"));
  updateRailVisibility();
}
// 缩放动作：⌘+/-/0 快捷键与原生菜单 zoom-in/out/reset 共用同一应用路径。
// dir：1 放大 / -1 缩小 / 0 复位（兼容旧版 "in"/"out"/"reset" 字符串）
export function menuZoom(dir) {
  if (dir === 1 || dir === "in") S.zoomLevel = Math.min(2, +(S.zoomLevel + 0.1).toFixed(2));
  else if (dir === -1 || dir === "out") S.zoomLevel = Math.max(0.6, +(S.zoomLevel - 0.1).toFixed(2));
  else S.zoomLevel = 1;
  applyZoom();
}

// 对话区内容列宽度分段上限（占屏幕宽度的比例，而非 app 窗口）：
// 50% 为默认上限，35% 为第二段收缩目标。窗口从宽往窄收时边距先持续缩小，
// 钉到 75px/边后内容缩到 35% 屏幕宽，边距再缩到 20px/边，最后内容继续缩。
// 由 JS 读 screen.width 写入 --col-max / --col-max-35。
export function updateContentColMax() {
  const w = window.screen.width;
  document.documentElement.style.setProperty("--col-max", Math.round(w * 0.5) + "px");
  document.documentElement.style.setProperty("--col-max-35", Math.round(w * 0.35) + "px");
}
// 实测内容列边距（dock 左缘 − 主卡片左缘），边距 < 65px 时隐藏左侧消息轨道
export function updateRailVisibility() {
  const main = document.getElementById("main");
  const dock = document.querySelector(".dock");
  if (!main || !dock || dock.classList.contains("hidden")) return;
  const m = dock.getBoundingClientRect().left - main.getBoundingClientRect().left;
  main.classList.toggle("rail-off", m < 65);
}
// fixed 菜单坐标补偿：先设 zoom 再除回
export function placeMenu(menu, visualLeft, visualTop) {
  menu.style.zoom = S.zoomLevel;
  menu.style.left = visualLeft / S.zoomLevel + "px";
  menu.style.top = visualTop / S.zoomLevel + "px";
}

// ---------- 消息轨道工具摘要（ui/ringpop.js railToolText 平移） ----------
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

// ---------- 全局壳监听（App 挂载后调用一次） ----------
export function initShell() {
  themeMq.addEventListener("change", () => {
    if (themeMode === "system") applyTheme("system");
  });
  try {
    const saved = localStorage.getItem("omp-theme");
    if (saved) applyTheme(saved);
  } catch {}

  attachResizer("left-resizer", "--left-w", 180, false);
  attachResizer("right-resizer", "--right-w", 200, true);

  updateContentColMax();
  window.addEventListener("resize", () => {
    updateContentColMax();
    // 窗口尺寸变化时，打开中的 composer 菜单锚点随按钮位置改变而失效，直接收起
    if (document.getElementById("composer")?.querySelector(".menu.open")) closeAllMenus();
  });
  // 窗口跨屏拖动不一定触发 resize，兜底周期同步
  // .unref?.()：浏览器返回 number 无副作用；happy-dom 冒烟（Node 事件循环）下不阻止进程退出
  const colMaxTimer = setInterval(updateContentColMax, 2000);
  colMaxTimer.unref?.();
  const mainEl = document.getElementById("main");
  if (mainEl && typeof ResizeObserver !== "undefined") new ResizeObserver(updateRailVisibility).observe(mainEl);
  document.addEventListener("keydown", (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "=" || e.key === "+") menuZoom(1);
    else if (e.key === "-") menuZoom(-1);
    else if (e.key === "0") menuZoom(0);
    else return;
    e.preventDefault();
  });

  // 菜单开合的全局协调（旧版 window click/blur → closeAllMenus 平移；
  // React state 态菜单经 omp:close-menus 事件关闭，stopPropagation 的开关钮不受影响）
  window.addEventListener("click", closeAllMenus);
  window.addEventListener("blur", closeAllMenus);
}
