// 窗口 shell：左右边栏折叠、主题、右键菜单、边栏拖宽、Cmd 缩放、placeMenu 坐标补偿、菜单协调。
import { $, S, tasklistEl, diskProjects, toast } from "./core.js";
import { closeProjPopups } from "./sidebar.js";
import { renderStatusCard } from "./right.js";
import { fitComposerBar } from "./composer.js";

// ---------- 菜单开合（原型同款：composer 内 absolute + 互斥） ----------
export function closeAllMenus() {
  closeCtxMenu();
  closeThemeMenu();
  closeProjPopups();
  document.querySelector(".wb-back-card")?.classList.remove("menu-open");
  $("wbProjectBtn")?.classList.remove("active");
  $("wbBranchBtn")?.classList.remove("active");
  for (const b of document.querySelectorAll(".pill-btn.active")) b.classList.remove("active");
  for (const m of document.querySelectorAll(".menu.open")) m.classList.remove("open");
}

// ---------- 左右侧边栏折叠 ----------
export function isSidebarCollapsed() {
  return $("sidebar").classList.contains("collapsed");
}
export function setSidebarCollapsed(off) {
  $("sidebar").classList.toggle("collapsed", off);
  const btn = $("sidebarToggle");
  if (btn) {
    btn.title = off ? "展开侧边栏 (⌘B)" : "收起侧边栏 (⌘B)";
    // 展开态显示「向左收起」，收起态显示「向右展开」
    btn.innerHTML = icon(off ? "collapseRight" : "collapseLeft");
  }
  try {
    localStorage.setItem("omp-sidebar-collapsed", off ? "1" : "0");
  } catch {}
}

export function isRightCollapsed() {
  return $("right").classList.contains("collapsed");
}
export function setRightCollapsed(off) {
  $("right").classList.toggle("collapsed", off);
  const btn = $("panelToggle");
  btn.title = off ? "展开侧边面板" : "收起侧边面板";
  // 展开态显示「向右收起」，收起态显示「向左展开」
  btn.innerHTML = icon(off ? "collapseLeft" : "collapseRight");
  if (!off) {
    S.todoCollapsed = true;
    renderStatusCard();
  }
}
export function expandRightPanel() {
  setRightCollapsed(false);
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
  const pvL = $("pvTagLight"), pvD = $("pvTagDark");
  if (pvL && pvD) {
    pvL.textContent = dark ? "浅色" : "当前生效";
    pvL.classList.toggle("on", !dark);
    pvD.textContent = dark ? "当前生效" : "深色";
    pvD.classList.toggle("on", dark);
  }
  const themeLabel = mode === "system" ? "◐ 跟随系统" : dark ? "🌙 深色" : "☀️ 浅色";
  const genLabel = mode === "system" ? "跟随系统" : dark ? "深色" : "浅色";
  const setSelLabel = (id, label) => {
    const el = $(id);
    if (!el) return;
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3) {
        n.textContent = label + " ";
        break;
      }
    }
  };
  setSelLabel("themeSel", themeLabel);
  setSelLabel("genThemeSel", genLabel);
  for (const menu of [$("themeMenu"), $("genThemeMenu")]) {
    if (!menu) continue;
    for (const mi of menu.querySelectorAll(".mi")) {
      const ck = mi.querySelector(".ck");
      if (ck) ck.textContent = mi.dataset.th === mode ? "✓" : "";
    }
  }
}

// 原生菜单「切换深浅色主题」：深浅互换（system 态按当前生效色归位后再切）
export function toggleTheme() {
  const dark = themeMode === "system" ? themeMq.matches : themeMode === "dark";
  applyTheme(dark ? "light" : "dark");
}

let themeMenu = null;
function closeThemeMenu() {
  themeMenu?.remove();
  themeMenu = null;
}

// ---------- 右键菜单：复制 sessionId / 会话文件路径 ----------
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // WKWebView 非安全上下文兜底
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

let ctxMenu = null;
function closeCtxMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

// ---------- 边栏拖动调宽 ----------
// 宽度走 CSS 变量，localStorage 记忆；保证中部卡片支持压缩至最小 30% 视口总宽度
function attachResizer(handleId, cssVar, min, invert) {
  const panel = handleId === "left-resizer" ? $("sidebar") : $("right");
  const apply = (w) => document.documentElement.style.setProperty(cssVar, w + "px");
  try {
    const saved = localStorage.getItem("omp-w-" + cssVar);
    if (saved) apply(+saved);
  } catch {}
  $(handleId).addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const move = (ev) => {
      const dx = (ev.clientX - startX) / S.zoomLevel;
      const wWin = document.documentElement.clientWidth || window.innerWidth || 1000;
      // 中部卡片最小宽度保证为应用总宽度的 30%（支持继续压缩至 30%）
      const minMainW = Math.max(240, Math.floor(wWin * 0.30));
      const otherPanel = invert ? $("sidebar") : $("right");
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

// ---------- Cmd +/-/0 缩放 ----------
// 只缩放三个布局容器：body 整体 zoom 会把 position:fixed 的菜单二次缩放，
// 导致右键菜单/主题菜单的渲染偏移与点击命中错位
// （zoomTargets 延迟初始化：模块顶层不可调用 core 的 $——循环 import 下 core 未完成会 TDZ）
let zoomTargets = null;
function applyZoom() {
  if (!zoomTargets) zoomTargets = ["sidebar", "main", "right"].map((id) => $(id));
  for (const el of zoomTargets) el.style.zoom = S.zoomLevel;
  // zoom 会改变布局宽度但不触发 ResizeObserver（Chrome/WebKit 行为），手动重算底栏收缩
  fitComposerBar();
  updateRailVisibility();
}
// 缩放动作：⌘+/-/0 快捷键与原生菜单 menu-action 共用同一应用路径
export function menuZoom(dir) {
  if (dir === "in") S.zoomLevel = Math.min(2, +(S.zoomLevel + 0.1).toFixed(2));
  else if (dir === "out") S.zoomLevel = Math.max(0.6, +(S.zoomLevel - 0.1).toFixed(2));
  else S.zoomLevel = 1;
  applyZoom();
}
// 对话区内容列宽度分段上限（占屏幕宽度的比例，而非 app 窗口）：
// 50% 为默认上限，35% 为第二段收缩目标。窗口从宽往窄收时边距先持续缩小，
// 钉到 75px/边后内容缩到 35% 屏幕宽，边距再缩到 20px/边，最后内容继续缩。
// 由 JS 读 screen.width 写入 --col-max / --col-max-35。
function updateContentColMax() {
  const w = window.screen.width;
  document.documentElement.style.setProperty("--col-max", Math.round(w * 0.5) + "px");
  document.documentElement.style.setProperty("--col-max-35", Math.round(w * 0.35) + "px");
}
// 实测内容列边距（dock 左缘 − 主卡片左缘），边距 < 65px 时隐藏左侧消息轨道
export function updateRailVisibility() {
  const main = $("main");
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

// 仅左栏禁用原生右键响应（选词高亮 + 系统菜单），其余区域照常响应系统右键（同 zcode）。
// WebKit 的选词发生在 contextmenu 默认行为阶段（拦 mousedown 无效，Chromium 才吃这套），
// 故记录右键前选区，contextmenu 后对比：仅撤销本次右键新产生的选词，用户已有选区保留。
let selBeforeCtx = null;
const inSidebar = (e) => e.target.closest("#sidebar");

export function initShell() {
  $("sidebarToggle")?.addEventListener("click", () => {
    setSidebarCollapsed(!isSidebarCollapsed());
  });
  try {
    if (localStorage.getItem("omp-sidebar-collapsed") === "1") {
      setSidebarCollapsed(true);
    }
  } catch {}
  $("panelToggle").addEventListener("click", () => {
    setRightCollapsed(!isRightCollapsed());
  });
  themeMq.addEventListener("change", () => {
    if (themeMode === "system") applyTheme("system");
  });
  try {
    const saved = localStorage.getItem("omp-theme");
    if (saved) applyTheme(saved);
  } catch {}

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 2 || !inSidebar(e)) return;
    e.preventDefault();
    const s = window.getSelection();
    selBeforeCtx = s ? s.toString() : null;
  });
  document.addEventListener("contextmenu", (e) => {
    if (!inSidebar(e)) return; // 左栏之外保留 WKWebView 原生右键菜单（复制/查询等）
    e.preventDefault();
    requestAnimationFrame(() => {
      const s = window.getSelection();
      if (s && !s.isCollapsed && s.toString() !== selBeforeCtx) s.removeAllRanges();
    });
  });

  tasklistEl.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".task[data-path]");
    if (!el) return;
    e.preventDefault();
    closeAllMenus();
    const path = el.dataset.path;
    const entry = diskProjects.flatMap((p) => p.sessions).find((s) => s.path === path);
    if (!entry) return;
    ctxMenu = document.createElement("div");
    ctxMenu.className = "ctx-menu";
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 80);
    placeMenu(ctxMenu, x, y);
    for (const [label, value] of [
      ["复制 sessionId", entry.id ?? ""],
      ["复制会话文件路径", entry.path],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => {
        copyText(value);
        toast(`已复制：${label}`);
        closeCtxMenu();
      };
      ctxMenu.appendChild(b);
    }
    document.body.appendChild(ctxMenu);
  });

  attachResizer("left-resizer", "--left-w", 180, false);
  attachResizer("right-resizer", "--right-w", 200, true);

  updateContentColMax();
  window.addEventListener("resize", updateContentColMax);
  // 窗口跨屏拖动不一定触发 resize，兜底周期同步
  setInterval(updateContentColMax, 2000);
  new ResizeObserver(updateRailVisibility).observe($("main"));
  document.addEventListener("keydown", (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "=" || e.key === "+") menuZoom("in");
    else if (e.key === "-") menuZoom("out");
    else if (e.key === "0") menuZoom("reset");
    else return;
    e.preventDefault();
  });

  // 菜单开合的全局协调
  window.addEventListener("click", closeAllMenus);
  window.addEventListener("blur", closeAllMenus);
  // 窗口尺寸变化时，打开中的 composer 菜单锚点随按钮位置改变而失效，直接收起
  window.addEventListener("resize", () => {
    const composer = $("composer");
    if (composer?.querySelector(".menu.open")) closeAllMenus();
  });

  // ⌘B 切换左侧边栏
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      setSidebarCollapsed(!isSidebarCollapsed());
    }
  });
}
