// 左栏：任务列表（项目 / 最近 双视图）+ 置顶图钉 + 项目管理（移除/删除/手动添加）。
import {
  $, S, send, toast, tasklistEl, diskProjects, openSessions, unseenFinished,
  pinnedSessions, expandedProjects, projectLimits, activeOpen, saveUnseen,
} from "./core.js";
import { closeAllMenus, placeMenu } from "./shell.js";
import { showWelcomeScreen, hideWelcomeScreen, getAvailableProjects, initNewSessionModel } from "./welcome.js";
import { settingsOpen } from "./settings/index.js";
import { invoke, renderAll } from "./core.js";
import { refreshGitDiff } from "./right.js";

// 置顶图钉（极简线条，悬停会话行时浮现于左侧）
let projMenu = null; // 项目行「⋯」弹出菜单（fixed 定位，zoom 补偿走 placeMenu）
let projAddPop = null; // 「项目」标题栏 ＋ 手动添加弹层
export function closeProjPopups() {
  projMenu?.remove();
  projMenu = null;
  projAddPop?.remove();
  projAddPop = null;
}

// —— 项目拖拽排序（Pointer Events 自绘：拖组跟手浮起，其余组实时滑移让位，松手提交顺序） ——
let projDrag = null; // 拖动会话态：{ cwd, pointerId, startClientY, groups }（groups 为 null 表示尚未过拖动阈值）
let suppressProjClick = false; // 拖动结束后抑制一次 click，避免误触发折叠/展开

// 收集顶层项目组（组头 + 可选的展开会话容器），并量出各自布局坐标/高度
// offsetTop/offsetHeight 是布局坐标，天然免疫 zoom；baseY 取相对首组的偏移，避开置顶区/标题行
function measureProjGroups() {
  const groups = [];
  for (const head of tasklistEl.querySelectorAll(":scope > .proj")) {
    const kids = head.nextElementSibling?.classList.contains("proj-kids") ? head.nextElementSibling : null;
    groups.push({ cwd: head.dataset.cwd, head, kids, baseY: 0, h: 0 });
  }
  const top0 = groups[0]?.head.offsetTop ?? 0;
  for (const g of groups) {
    g.baseY = g.head.offsetTop - top0;
    g.h = g.head.offsetHeight + (g.kids?.offsetHeight ?? 0);
  }
  return groups;
}

function beginProjDrag(e) {
  const d = projDrag;
  d.groups = measureProjGroups();
  // 拖动期间全列表禁文本选中：划过展开组的会话行会触发 WebKit 选中，
  // 选中又会驱动滚动容器自动滚动，与按起始布局算的位移叠加造成跳动
  tasklistEl.classList.add("proj-dragging");
  window.getSelection()?.removeAllRanges();
  for (const g of d.groups) {
    for (const el of g.kids ? [g.head, g.kids] : [g.head]) el.classList.add("shift-anim");
  }
  const self = d.groups.find((g) => g.cwd === d.cwd);
  for (const el of self.kids ? [self.head, self.kids] : [self.head]) el.classList.add("drag-float");
  updateProjDrag(e);
}

// 拖组中点落到某组前半 → 占位插到该组前；其余组按「拖组占位插入」的目标布局算 translateY
function updateProjDrag(e) {
  const d = projDrag;
  const z = S.zoomLevel || 1; // 指针位移是视觉坐标，换算回布局坐标
  const dy = (e.clientY - d.startClientY) / z;
  const self = d.groups.find((g) => g.cwd === d.cwd);
  const dragMid = self.baseY + dy + self.h / 2;
  const others = d.groups.filter((g) => g.cwd !== d.cwd);
  let idx = others.length;
  for (let i = 0, acc = 0; i < others.length; i++) {
    if (dragMid < acc + others[i].h / 2) { idx = i; break; }
    acc += others[i].h;
  }
  let y = 0;
  for (let i = 0; i < others.length; i++) {
    if (i === idx) y += self.h; // 拖组在此占位
    const ty = `translateY(${y - others[i].baseY}px)`;
    others[i].head.style.transform = ty;
    if (others[i].kids) others[i].kids.style.transform = ty;
    y += others[i].h;
  }
  const ty = `translateY(${dy}px)`;
  self.head.style.transform = ty;
  if (self.kids) self.kids.style.transform = ty;
  d.insertIndex = idx;
}

function endProjDrag(commit) {
  const d = projDrag;
  projDrag = null;
  if (!d?.groups) return;
  tasklistEl.classList.remove("proj-dragging");
  window.getSelection()?.removeAllRanges();
  for (const g of d.groups) {
    for (const el of g.kids ? [g.head, g.kids] : [g.head]) {
      el.classList.remove("shift-anim", "drag-float");
      el.style.transform = "";
    }
  }
  suppressProjClick = true; // 拖动结束后抑制随后到来的 click（无论是否换位，都避免误触发折叠/展开）
  setTimeout(() => { suppressProjClick = false; }, 0);
  if (!commit) return;
  // 提交：DOM 顺序按拖组占位插入 insertIndex 重排，顺序持久化到 omp-desktop.json allProjects
  const order = d.groups.filter((g) => g.cwd !== d.cwd).map((g) => g.cwd);
  order.splice(d.insertIndex, 0, d.cwd);
  for (const c of order) if (!S.allProjects.includes(c)) S.allProjects.unshift(c); // 磁盘兜底项目先并入
  const arr = [...order, ...S.allProjects.filter((c) => !order.includes(c))];
  const unchanged = arr.length === S.allProjects.length && arr.every((c, i) => c === S.allProjects[i]);
  S.allProjects = arr;
  send({ type: "reorder_projects", order: arr });
  if (!unchanged) renderList();
}

// 全局二次确认弹窗：严格遵照 ring-pop 视觉规范与 ringpop 动效
export function showConfirmDialog({ title, message, confirmText = "确定", cancelText = "取消", danger = false, onConfirm }) {
  document.querySelector(".confirm-mask")?.remove();
  const mask = document.createElement("div");
  mask.className = "confirm-mask";
  const box = document.createElement("div");
  box.className = "confirm-box";
  if (title) {
    const t = document.createElement("div");
    t.className = "confirm-title";
    t.textContent = title;
    box.appendChild(t);
  }
  if (message) {
    const d = document.createElement("div");
    d.className = "confirm-desc";
    d.textContent = message;
    box.appendChild(d);
  }
  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "confirm-btn";
  cancelBtn.textContent = cancelText;
  const okBtn = document.createElement("button");
  okBtn.className = "confirm-btn" + (danger ? " danger" : "");
  okBtn.textContent = confirmText;

  const close = () => {
    mask.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") {
      close();
      onConfirm?.();
    }
  };
  cancelBtn.onclick = close;
  okBtn.onclick = () => {
    close();
    onConfirm?.();
  };
  mask.addEventListener("click", (e) => {
    if (e.target === mask) close();
  });
  actions.append(cancelBtn, okBtn);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  document.addEventListener("keydown", onKey);
  okBtn.focus();
}

// 手动添加项目：全路径输入。宿主负责把命中已移除列表的项移回所有项目列表
function openProjAddPop(btn) {
  closeAllMenus();
  projAddPop = document.createElement("div");
  projAddPop.className = "proj-add-pop";
  // 弹层内点击不透传到 window（否则会触发 closeAllMenus 把弹层关掉）
  projAddPop.addEventListener("click", (e) => e.stopPropagation());
  const input = document.createElement("input");
  input.className = "approval-input";
  input.placeholder = "项目全路径，如 /Users/x/code";
  const ok = document.createElement("button");
  ok.className = "pa-btn";
  ok.textContent = "添加";
  const submit = () => {
    const cwd = input.value.trim();
    if (!cwd) return;
    send({ type: "add_project", cwd });
    closeProjPopups();
  };
  ok.onclick = submit;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") closeProjPopups();
  });
  projAddPop.append(input, ok);
  const r = btn.getBoundingClientRect();
  const w = 330;
  placeMenu(projAddPop, Math.max(4, Math.min(r.right - w, window.innerWidth - w - 8)), r.bottom + 4);
  document.body.appendChild(projAddPop);
  input.focus();
}

// 构建项目的会话容器（grid 行高过渡做整组收起动画）；animate 时逐行播放入场动画
function buildProjKids(p, animate = false) {
  const kids = document.createElement("div");
  kids.className = "proj-kids";
  const kidsIn = document.createElement("div");
  kidsIn.className = "proj-kids-in";
  kids.appendChild(kidsIn);
  // 管理模式下显示全部会话；默认 5 条，按需每次多加载 5 条
  const limit = S.isProjectManageMode ? Infinity : (projectLimits.get(p.cwd) ?? 5);
  const visibleSessions = p.sessions.slice(0, limit);
  for (const [i, s] of visibleSessions.entries()) {
    const row = taskRow(s, { sub: true });
    if (animate) {
      row.classList.add("kids-in");
      row.style.animationDelay = i * 25 + "ms"; // 逐行错峰展开
    }
    kidsIn.appendChild(row);
  }
  if (!S.isProjectManageMode && p.sessions.length > visibleSessions.length) {
    const moreLink = document.createElement("button");
    moreLink.className = "more-link";
    moreLink.textContent = "显示更多";
    moreLink.onclick = () => {
      projectLimits.set(p.cwd, visibleSessions.length + 5);
      renderList();
    };
    if (animate) moreLink.classList.add("kids-in");
    kidsIn.appendChild(moreLink);
  }
  if (p.sessions.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "暂无任务";
    if (animate) hint.classList.add("kids-in");
    kidsIn.appendChild(hint);
  }
  return kids;
}

export function fmtAgo(iso) {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return "刚刚";
  if (sec < 3600) return Math.floor(sec / 60) + "分";
  if (sec < 86400) return Math.floor(sec / 3600) + "小时";
  return Math.floor(sec / 86400) + "天";
}
export function fmtDuration(sec) {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}
export function sessionLabel(s) {
  return s.title || s.firstMessage || "（空会话）";
}

function taskRow(s, { sub, showRepo, pinnedList } = {}) {
  const b = document.createElement("button");
  b.className = "task" + (sub ? " sub" : "") + (s.path === S.activePath ? " on" : "");
  b.dataset.path = s.path;
  // 置顶图钉:悬停浮现(置顶列表中常显),点击切换置顶,持久化到 omp-desktop.json
  const pinned = pinnedSessions.has(s.path);
  const pin = document.createElement("button");
  pin.className = "tpin" + (pinned || pinnedList ? " on" : "");
  pin.innerHTML = icon("pin");
  pin.title = pinned ? "取消置顶" : "置顶会话";
  pin.onclick = (e) => {
    e.stopPropagation();
    const on = !pinnedSessions.has(s.path);
    if (on) pinnedSessions.add(s.path);
    else pinnedSessions.delete(s.path);
    send({ type: "set_session_pinned", path: s.path, pinned: on });
    renderList();
  };
  b.appendChild(pin);
  const open = openSessions.get(s.path);
  if (open?.streaming) {
    const sp = document.createElement("span");
    sp.className = "mini-spin";
    sp.title = "运行中";
    b.appendChild(sp);
  } else if (unseenFinished.has(s.path)) {
    const dot = document.createElement("span");
    dot.className = "seen-dot";
    dot.title = "有新结果";
    b.appendChild(dot);
  }
  if (sub) {
    const tt = document.createElement("span");
    tt.className = "tt";
    tt.textContent = sessionLabel(s);
    b.appendChild(tt);
  } else {
    const tt = document.createElement("span");
    tt.className = "tt";
    tt.textContent = sessionLabel(s) + (showRepo ? `  ·  ${s.repo}` : "");
    b.appendChild(tt);
  }
  if (S.isProjectManageMode) {
    const del = document.createElement("button");
    del.className = "task-del-btn";
    del.textContent = "删除";
    del.title = "删除会话";
    del.onclick = (e) => {
      e.stopPropagation();
      const sTitle = s.title || s.firstMessage || s.id || "未命名会话";
      showConfirmDialog({
        title: "删除会话",
        message: `确定要永久删除此会话吗？此操作无法撤销。\n\n会话：${sTitle}`,
        confirmText: "删除",
        danger: true,
        onConfirm: () => {
          send({ type: "delete_session", path: s.path });
          if (S.activePath === s.path) {
            openSessions.delete(s.path);
            S.activePath = null;
            showWelcomeScreen(s.cwd || S.newSessionProject);
          }
        },
      });
    };
    b.appendChild(del);
  } else {
    const tm = document.createElement("span");
    tm.className = "tm";
    tm.textContent = fmtAgo(s.modified);
    b.appendChild(tm);
  }
  b.onclick = () => {
    S.isCreatingNew = false;
    hideWelcomeScreen();
    unseenFinished.delete(s.path);
    saveUnseen();
    if (openSessions.has(s.path)) {
      S.activePath = s.path;
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
      send({ type: "load_session", path: s.path });
    }
    S.selectedSubagent = null;
    S.selectedFile = null;
    renderAll();
  };
  return b;
}

export function renderList() {
  tasklistEl.innerHTML = "";
  if (S.viewMode === "project") {
    // 置顶列表:跨项目聚合,位于项目列表上方;磁盘上已不存在的置顶自动忽略
    const pinnedRows = diskProjects
      .flatMap((p) => p.sessions)
      .filter((s) => pinnedSessions.has(s.path))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    if (pinnedRows.length) {
      const plabel = document.createElement("div");
      plabel.className = "sec-label";
      plabel.textContent = "置顶";
      tasklistEl.appendChild(plabel);
      for (const s of pinnedRows) tasklistEl.appendChild(taskRow(s, { pinnedList: true }));
    }
    const label = document.createElement("div");
    label.className = "sec-label";
    const lt = document.createElement("span");
    lt.textContent = "项目";
    label.appendChild(lt);
    const secActions = document.createElement("div");
    secActions.className = "sec-actions";
    const secAdd = document.createElement("button");
    secAdd.className = "sec-add";
    secAdd.textContent = "＋";
    secAdd.title = "添加项目";
    secAdd.onclick = (e) => {
      e.stopPropagation();
      if (projAddPop) { closeProjPopups(); return; }
      // Tauri 环境弹系统目录选择框；纯浏览器开发环境退回手动输入弹层
      if (invoke) {
        closeAllMenus();
        invoke("plugin:dialog|open", { options: { directory: true, title: "选择项目文件夹" } })
          .then((p) => { if (p) send({ type: "add_project", cwd: p }); })
          .catch(() => openProjAddPop(secAdd));
      } else {
        openProjAddPop(secAdd);
      }
    };
    secActions.appendChild(secAdd);
    const secTrash = document.createElement("button");
    secTrash.className = "sec-trash" + (S.isProjectManageMode ? " active" : "");
    secTrash.innerHTML = icon("trash", 12);
    secTrash.title = S.isProjectManageMode ? "退出清理模式" : "清理项目与会话";
    secTrash.onclick = (e) => {
      e.stopPropagation();
      S.isProjectManageMode = !S.isProjectManageMode;
      if (S.isProjectManageMode) {
        for (const pr of visible) {
          expandedProjects.add(pr.cwd);
          projectLimits.set(pr.cwd, Infinity);
        }
      }
      renderList();
    };
    secActions.appendChild(secTrash);
    label.appendChild(secActions);
    tasklistEl.appendChild(label);
    // 可见项目 = 所有项目列表 - 已移除；历史里的项目兜底并入（兼容旧宿主）
    const visible = getAvailableProjects();
    for (const p of visible) {
      const proj = document.createElement("div");
      proj.className = "proj" + (expandedProjects.has(p.cwd) ? "" : " collapsed");
      proj.dataset.cwd = p.cwd; // 重绘后按此找回组头（展开/收起动画定位容器用）
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.innerHTML = icon("caret");
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
      name.title = p.cwd;
      if (S.isProjectManageMode) {
        const rm = document.createElement("button");
        rm.className = "proj-rm-btn";
        rm.textContent = "移除";
        rm.title = `移除项目 ${p.cwd}`;
        rm.onclick = (e) => {
          e.stopPropagation();
          const projName = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
          showConfirmDialog({
            title: "移除项目",
            message: `确定要将项目「${projName}」从项目列表中移除吗？\n\n项目目录：${p.cwd}\n（会话仍保留在历史中，可在最近视图中查看）`,
            confirmText: "移除",
            danger: true,
            onConfirm: () => {
              send({ type: "remove_project", cwd: p.cwd });
            },
          });
        };
        proj.append(caret);
        proj.insertAdjacentHTML("beforeend", expandedProjects.has(p.cwd) ? icon("folderOpen") : icon("folder"));
        proj.append(name, rm);
      } else {
        const add = document.createElement("button");
        add.className = "padd";
        add.textContent = "＋";
        add.title = `在 ${p.cwd} 新建会话`;
        add.onclick = (e) => {
          e.stopPropagation();
          showWelcomeScreen(p.cwd);
        };
        const more = document.createElement("button");
        more.className = "pmore";
        more.innerHTML = icon("dots");
        more.title = "更多";
        more.onclick = (e) => {
          e.stopPropagation();
          if (projMenu) {
            closeProjPopups();
            return;
          }
          closeAllMenus();
          projMenu = document.createElement("div");
          projMenu.className = "ctx-menu";
          const rm = document.createElement("button");
          rm.textContent = "移除";
          rm.onclick = () => {
            closeProjPopups();
            const projName = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
            showConfirmDialog({
              title: "移除项目",
              message: `确定要将项目「${projName}」从项目列表中移除吗？\n\n项目目录：${p.cwd}\n（会话仍保留在历史中，可在最近视图中查看）`,
              confirmText: "移除",
              danger: true,
              onConfirm: () => {
                send({ type: "remove_project", cwd: p.cwd });
              },
            });
          };
          projMenu.appendChild(rm);
          projMenu.addEventListener("click", (ev) => ev.stopPropagation());
          document.body.appendChild(projMenu);
          projMenu.style.zoom = S.zoomLevel;
          const r = more.getBoundingClientRect();
          const mr = projMenu.getBoundingClientRect();
          const top = Math.min(Math.max(r.top + r.height / 2 - mr.height / 2, 8), window.innerHeight - mr.height - 8);
          const left = Math.max(8, Math.min(r.right + 4, window.innerWidth - mr.width - 8));
          placeMenu(projMenu, left, top);
        };
        proj.append(caret);
        proj.insertAdjacentHTML("beforeend", expandedProjects.has(p.cwd) ? icon("folderOpen") : icon("folder"));
        proj.append(name, add, more);
      }
      // 拖拽排序：仅收起状态的组头是拖柄（展开组整组跟手太笨重，先收起再拖）；移动超阈值进入拖动态，其余组实时滑移让位，松手提交
      proj.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return; // 行内按钮（＋/⋯/移除）不受影响
        if (expandedProjects.has(p.cwd)) return; // 展开的项目不可拖
        projDrag = { cwd: p.cwd, pointerId: e.pointerId, startClientY: e.clientY, groups: null, insertIndex: -1 };
        proj.setPointerCapture(e.pointerId);
      });
      proj.addEventListener("pointermove", (e) => {
        const d = projDrag;
        if (!d || d.pointerId !== e.pointerId || d.cwd !== p.cwd) return;
        if (!d.groups) {
          if (Math.abs(e.clientY - d.startClientY) / (S.zoomLevel || 1) < 5) return; // 5px 阈值内算点击
          beginProjDrag(e);
          return;
        }
        updateProjDrag(e);
      });
      const finishProjDrag = (e, commit) => {
        const d = projDrag;
        if (!d || d.pointerId !== e.pointerId || d.cwd !== p.cwd) return;
        endProjDrag(commit);
      };
      proj.addEventListener("pointerup", (e) => finishProjDrag(e, true));
      proj.addEventListener("pointercancel", (e) => finishProjDrag(e, false));
      // 点击组头折叠/展开；增量更新只动当前项目的容器，不重绘全列表（避免其他展开组闪烁）；展开态写入宿主 omp-desktop.json（收起即从配置移除，未记录的默认收起）；再展开时分页重置回默认 5 条
      proj.onclick = () => {
        if (suppressProjClick) return; // 刚结束拖动，忽略本次 click
        const on = !expandedProjects.has(p.cwd);
        // 组头图标随状态切换（caret 旋转走 .collapsed 类，folder/folderOpen 是行内 svg 需手动换）
        const folderSvg = proj.querySelector(":scope > svg");
        if (on) {
          expandedProjects.add(p.cwd);
          projectLimits.delete(p.cwd);
          send({ type: "set_project_expanded", cwd: p.cwd, expanded: true });
          proj.classList.remove("collapsed");
          if (folderSvg) folderSvg.outerHTML = icon("folderOpen");
          // 容器高度 0→auto 展开（grid 行高过渡），与逐行 kids-in 错峰叠加
          const kids = buildProjKids(p, true);
          proj.after(kids);
          kids.style.gridTemplateRows = "0fr";
          requestAnimationFrame(() => requestAnimationFrame(() => { kids.style.gridTemplateRows = ""; }));
        } else {
          expandedProjects.delete(p.cwd);
          send({ type: "set_project_expanded", cwd: p.cwd, expanded: false });
          proj.classList.add("collapsed");
          if (folderSvg) folderSvg.outerHTML = icon("folder");
          // 收起：容器高度收拢到 0（0.3s）后移除，同样不动其他组
          const kids = proj.nextElementSibling;
          if (kids?.classList.contains("proj-kids")) {
            kids.classList.add("closing");
            setTimeout(() => kids.remove(), 310);
          }
        }
      };
      tasklistEl.appendChild(proj);
      if (!expandedProjects.has(p.cwd)) continue;
      tasklistEl.appendChild(buildProjKids(p));
    }
    if (visible.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "暂无项目，点击「项目」右侧 ＋ 添加";
      tasklistEl.appendChild(hint);
    }
  } else {
    const label = document.createElement("div");
    label.className = "sec-label";
    label.textContent = "最近任务";
    tasklistEl.appendChild(label);
    const flat = diskProjects
      .flatMap((p) => p.sessions.map((s) => ({ ...s, repo: p.cwd.split("/").filter(Boolean).pop() })))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
      .slice(0, 50);
    for (const s of flat) tasklistEl.appendChild(taskRow(s, { showRepo: true }));
    if (flat.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "暂无任务";
      tasklistEl.appendChild(hint);
    }
  }
}

export function initSidebar() {
  // 左栏 seg 视图切换 + 新建
  $("seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.viewMode = b.dataset.view;
    for (const x of $("seg").querySelectorAll("button")) x.classList.toggle("on", x === b);
    renderList();
  });
  // 点新建（含已在欢迎页时再点）：明确回到配置文件默认——清手选标记 + 强制重校准
  function newTaskAction() {
    if (S.isCreatingNew) {
      S.newSessionDirty = false;
      initNewSessionModel(true);
      renderAll();
    }
    showWelcomeScreen(activeOpen()?.cwd);
  }
  $("navNew").addEventListener("click", newTaskAction);

  // ⌘N 新建任务
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (typeof settingsOpen === "function" && settingsOpen()) return;
      newTaskAction();
    }
  });
}
