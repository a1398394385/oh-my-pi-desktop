// 动作行共享渲染工具：省略号截断 / 文件标签 / diff 展开收起 / 渐变遮掩 / 行数统计等。
// 各工具标签的映射与行渲染在 tool-labels.js（加减标签去那里改）。
import { S, send, activeOpen, briefDiffCache, fileDiffCache } from "./core.js";
import { activateRightTab, renderRight, expandRightPanel } from "./right.js";

export function uniqueFiles(files) {
  const out = [];
  for (const p of files || []) {
    if (typeof p !== "string" || !p) continue;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm;
  }
  return out;
}
function fileExt(name) {
  const base = String(name || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}
function fileTypeIcon(name) {
  const ext = fileExt(name);
  if (ext === "html" || ext === "htm") return icon("ftHtml");
  if (ext === "css") return icon("ftCss");
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "tsx") return icon("ftJs");
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return icon("ftImg");
  return icon("ftFile");
}
export function splitPath(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) };
}
export function fillInlineCode(el, text) {
  const parts = String(text || "").split(/(`[^`]+`)/);
  for (const p of parts) {
    if (p.length > 2 && p.startsWith("`") && p.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = p.slice(1, -1);
      el.appendChild(code);
    } else if (p) el.appendChild(document.createTextNode(p));
  }
}
// 「…」与前文字 3px 间距：原生 text-overflow:ellipsis 做不到，改为 文本段(e-tx) + 省略号段(e-dot) 结构，
// 文本段被裁切时省略号段才显示；ResizeObserver 跟随容器宽窄变化/界面缩放重算。
const eObs = new ResizeObserver((list) => { for (const e of list) syncDot(e.target); });
const eTxSet = new Set(); // 全量重绘会产生游离节点，超量时回收
function syncDot(tx) {
  const dot = tx.nextElementSibling;
  if (!dot || !dot.classList.contains("e-dot")) return;
  dot.style.display = tx.scrollWidth > tx.clientWidth + 1 ? "" : "none";
}
export function ellipsizable(span) {
  const wrap = document.createElement("span");
  wrap.className = (span.className + " e-wrap").trim();
  wrap.title = span.title || span.textContent;
  const tx = document.createElement("span");
  tx.className = "e-tx";
  tx.textContent = span.textContent;
  const dot = document.createElement("span");
  dot.className = "e-dot";
  dot.textContent = "…";
  dot.style.display = "none";
  wrap.append(tx, dot);
  eObs.observe(tx);
  eTxSet.add(tx);
  if (eTxSet.size > 1000) {
    for (const t of eTxSet) if (!t.isConnected) { eObs.unobserve(t); eTxSet.delete(t); }
  }
  requestAnimationFrame(() => syncDot(tx));
  return wrap;
}
export function fileChip(path, opts = {}) {
  const { name } = splitPath(path);
  const span = document.createElement("span");
  span.className = "f-ic";
  span.insertAdjacentHTML("beforeend", fileTypeIcon(name || path));
  const nm = document.createElement("span");
  nm.textContent = name || path;
  if (opts.nameClass) nm.className = opts.nameClass;
  if (opts.onNameClick) {
    nm.classList.add("lnk");
    nm.onclick = (e) => {
      e.stopPropagation(); // 不触发整行的内联展开
      opts.onNameClick(e);
    };
  }
  span.appendChild(nm);
  span.title = path;
  return span;
}

// 编辑类工具事件（edit / write / apply_patch）：把连续编辑事件合并成一个「更改」组的判定
export function isEditEvent(item) {
  return item.role === "tool" && ["edit", "write", "apply_patch"].includes(item.name || "");
}
// 更改组展开状态：以组内首个 item 对象为键（items 对象引用稳定，跨全量重绘保留）
export const chgExpand = new WeakMap();

// 行尾 +n/−n 行数变化（编辑行 / 更改组内行共用）
export function appendCounts(row, item) {
  if (item.added > 0) {
    const add = document.createElement("span");
    add.className = "add";
    add.textContent = `+${item.added}`;
    row.appendChild(document.createTextNode(" "));
    row.appendChild(add);
  }
  if (item.removed > 0) {
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = `−${item.removed}`;
    row.appendChild(document.createTextNode(" "));
    row.appendChild(del);
  }
}

// 收起动画：高度真实收拢（非 clip 裁剪），下方内容随高度过渡同步上移，避免节点移除时的突兀跳变。
// delay/dur 与动画时长一致：主对话区 0.2s（210ms），右栏 0.3s（310ms）
export function liftEl(el, delay = 210, dur = 0.2) {
  if (!el) return;
  el.style.height = el.offsetHeight + "px";
  el.style.overflow = "hidden";
  void el.offsetHeight; // 强制回流，让 height 从当前值开始过渡
  el.style.transition = `height ${dur}s ease-out, opacity ${dur}s ease-out, padding ${dur}s ease-out, margin ${dur}s ease-out`;
  el.style.height = "0px";
  el.style.opacity = "0";
  el.style.paddingTop = "0";
  el.style.paddingBottom = "0";
  el.style.marginBottom = "0"; // 边距随收拢归零，移除节点时无残留跳变
  setTimeout(() => el.remove(), delay);
}

// 点击行展开/收起内联 diff（编辑行与更改组内行共用）：行尾箭头原地旋转，展开体就地插入/移除
export function wireDiffToggle(row, item, path) {
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.diffExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  row.appendChild(arrow);
  row.style.cursor = "pointer";
  let briefEl = null;
  row.onclick = () => {
    item.diffExpanded = !item.diffExpanded;
    arrow.classList.toggle("open", item.diffExpanded); // 同元素原地旋转，不跳动
    // 首次展开时按需拉取该文件 diff（回包经 file_diff 写入 briefDiffCache 后重渲染）
    const s = activeOpen();
    if (item.diffExpanded && path && s?.isGit && briefDiffCache[path] === undefined && S.briefDiffPending !== path) {
      S.briefDiffPending = path;
      send({ type: "get_file_diff", cwd: s.cwd, path });
    }
    // 原地插入/移除展开体，不整行重建；全量重绘后闭包 briefEl 丢失，回退摘取紧邻的展开体节点
    if (item.diffExpanded && path) {
      if (!briefEl) {
        briefEl = buildEditBrief(path, true);
        row.after(briefEl);
      }
    } else {
      liftEl(briefEl ?? (row.nextElementSibling?.classList.contains("ed-brief") ? row.nextElementSibling : null));
      briefEl = null;
    }
  };
}

// 底部渐变遮掩：滚到底(或内容不足一屏)时加 .no-fade 解除遮掩（与 think-body 同手法）
export function attachFadeMask(el) {
  const sync = () => {
    el.classList.toggle("no-fade", el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  };
  el.addEventListener("scroll", sync, { passive: true });
  requestAnimationFrame(sync);
  return el;
}
// 编辑行内联展开的简略 diff 体；animate=true 时播放从上往下的揭示动画
export function buildEditBrief(path, animate = false) {
  const body = document.createElement("div");
  body.className = "ed-brief" + (animate ? " drop" : "") + (document.documentElement.dataset.theme === "dark" ? " d2h-dark-color-scheme" : "");
  const diff = briefDiffCache[path];
  if (diff === undefined) body.innerHTML = '<div class="placeholder">加载中…</div>';
  else if (!diff) body.innerHTML = '<div class="placeholder">（无差异内容）</div>';
  else {
    body.innerHTML = window.Diff2Html.html(diff, {
      drawFileList: false,
      outputFormat: "line-by-line",
      matching: "words",
      highlight: true,
    });
  }
  return attachFadeMask(body);
}
// 点击编辑行的文件名：右侧边栏切到 gitdiff 详情并展开面板
export function openFileDiffInSidebar(path) {
  const s = activeOpen();
  if (!s || !s.isGit) return;
  activateRightTab("gitdiff");
  S.selectedFile = path;
  fileDiffCache.loading = true;
  fileDiffCache.path = path;
  briefDiffCache[path] = undefined; // 详情与内联展开共用一次回包
  S.briefDiffPending = path;
  send({ type: "get_file_diff", cwd: s.cwd, path });
  expandRightPanel();
  renderRight();
}
export function renderStepTitle(text) {
  const div = document.createElement("div");
  div.className = "step-title";
  fillInlineCode(div, text);
  return div;
}
