// 右栏：可关闭 tab 框架（子代理/Git Diff/文件/后台命令）、TODO 进程卡、
// Git Diff 树/平铺 + diff2html 详情、文件视图（整文件/文件树）、子代理卡片与流、后台命令列表。
import { $, S, send, toast, rightBodyEl, activeOpen, gitDiffCache, fileDiffCache, diskProjects, openSessions, unseenFinished, saveUnseen } from "./core.js";
import { renderToolItem } from "./tool-labels.js";
import { renderStepTitle, attachFadeMask, liftEl } from "./tool-rows.js";
import { escapeHtml } from "./markdown.js";
import { isRightCollapsed, setRightCollapsed, expandRightPanel } from "./shell.js";
import { confirmDialog } from "./settings/providers.js";
import { fmtAgo } from "./sidebar.js";
import { hideWelcomeScreen } from "./welcome.js";
export { isRightCollapsed, setRightCollapsed, expandRightPanel };

// 右栏 tab 栏：打开的 tab 有序列表 + 当前激活项；全部关闭后激活项为 null（起始页）
export const TAB_META = {
  subagent: { label: "子代理", icon: "agents" },
  gitdiff: { label: "Git Diff", icon: "branch" },
  bgcmd: { label: "后台命令", icon: "term" },
  file: { label: "文件", icon: "folderOpen" },
  tree: { label: "分支", icon: "fork" },
};
export const rightTabs = ["subagent"]; // 已打开 tab（有序）
export const rightState = {
  fileTreeDirs: new Map(), // 文件树懒加载缓存：目录路径 -> 子项列表（undefined = 未加载）
  fileTreeExpanded: new Set(), // 文件树展开中的目录路径
  fileTreePending: new Set(), // 已发出 list_dir 待回包的目录路径
  expandedDirs: new Set(), // gitdiff 树展开中的目录路径
  commitMsg: "", // Git Diff 页提交信息输入框（跨重绘保持，提交成功清空）
  sessionTree: null, // 分支树数据：{ sessionId, branches }（session_tree 回包写入，切会话后视为过期）
  sessionTreePending: false, // get_session_tree 已发出待回包（error 帧解除挂起）
  treeFor: null, // 发起 get_session_tree 时的会话 id（回包未带 sessionId 时归属用）
};
export function openRightTab(name) {
  if (!rightTabs.includes(name)) rightTabs.push(name);
  S.rightTab = name;
  renderRight();
}
export function closeRightTab(name) {
  const i = rightTabs.indexOf(name);
  if (i < 0) return;
  rightTabs.splice(i, 1);
  if (S.rightTab === name) S.rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  renderRight();
}
export function activateRightTab(name) {
  openRightTab(name);
}

export function renderRight() {
  const s = activeOpen();
  // 非 git 会话不保留 Git Diff tab（打开的列表与激活项都回落）
  if (!s?.isGit && rightTabs.includes("gitdiff")) {
    const i = rightTabs.indexOf("gitdiff");
    rightTabs.splice(i, 1);
    if (S.rightTab === "gitdiff") S.rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  }
  // 工具条 project 名
  $("wsName").textContent = s ? s.cwd.split("/").filter(Boolean).pop() : "—";
  // 进程状态卡（TODO）
  renderStatusCard();
  renderRightTabs();
  const isGitTab = S.rightTab === "gitdiff";
  $("gitRefresh").style.display = isGitTab ? "" : "none";
  $("gitViewToggle").style.display = isGitTab ? "" : "none";
  $("gitViewToggle").textContent = S.gitViewMode === "tree" ? "树" : "平铺";
  renderRightBody();
  updateBgTaskButton();
  updateBgSubagentButton();
}

// 右栏 tab 栏：每个 tab 圆角块 + hover 关闭钮（×），点击切换激活
function renderRightTabs() {
  const wrap = $("rightTabs");
  wrap.innerHTML = "";
  wrap.style.display = rightTabs.length ? "" : "none";
  for (const name of rightTabs) {
    const meta = TAB_META[name];
    const b = document.createElement("button");
    b.className = "rtab" + (name === S.rightTab ? " on" : "");
    b.title = meta.label;
    b.innerHTML = `<span class="rtab-ic">${icon(meta.icon, 12)}</span><span class="rtab-tx">${meta.label}</span>`;
    const x = document.createElement("span");
    x.className = "rtab-x";
    x.title = "关闭";
    x.innerHTML = icon("xmark", 10);
    x.onclick = (e) => {
      e.stopPropagation();
      closeRightTab(name);
    };
    b.appendChild(x);
    b.onclick = () => {
      if (S.rightTab !== name) {
        S.rightTab = name;
        renderRight();
      }
    };
    wrap.appendChild(b);
  }
}

export function renderStatusCard() {
  const card = $("statusCard");
  const capsule = $("capsule");
  const s = activeOpen();
  const phases = s?.todos ?? [];
  const all = phases.flatMap((p) => p.tasks);
  if (!s || all.length === 0) {
    card.classList.add("hidden");
    capsule.classList.add("hidden");
    return;
  }
  card.classList.toggle("hidden", S.todoCollapsed);
  capsule.classList.toggle("hidden", !S.todoCollapsed);
  const done = all.filter((t) => t.status === "completed").length;
  const frac = `${done}/${all.length}`;
  const current = all.find((t) => t.status === "in_progress")
    || all.find((t) => t.status !== "completed");
  const capLabel = current ? current.content : "全部完成";
  const capIcon = current
    ? (current.status === "in_progress" ? "→" : current.status === "blocked" ? "⊘" : "○")
    : "✓";
  capsule.replaceChildren();
  const ic = document.createElement("i");
  ic.className = "cap-ic";
  ic.textContent = capIcon;
  const tx = document.createElement("span");
  tx.className = "cap-tx";
  tx.textContent = capLabel;
  const n = document.createElement("span");
  n.className = "cap-n";
  n.textContent = frac;
  capsule.append(ic, tx, n);
  capsule.title = capLabel + "  " + frac;
  if (S.todoCollapsed) return;
  $("todoFrac").textContent = frac;
  const list = $("todoList");
  list.innerHTML = "";
  for (const phase of phases) {
    if (phase.tasks.length === 0) continue;
    if (phases.length > 1) {
      const h = document.createElement("div");
      h.className = "sc-phase";
      h.textContent = phase.name;
      list.appendChild(h);
    }
    for (const t of phase.tasks) {
      const row = document.createElement("div");
      row.className = "todo " + (t.status === "completed" ? "done" : t.status === "in_progress" ? "cur" : t.status === "blocked" ? "blocked" : "");
      const icon = document.createElement("i");
      icon.className = t.status === "completed" ? "ck" : t.status === "in_progress" ? "ar" : "ci";
      icon.textContent = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : t.status === "blocked" ? "⊘" : "○";
      const text = document.createElement(t.status === "completed" ? "s" : "span");
      text.textContent = t.content + (t.status === "blocked" && t.blocker ? `（${t.blocker}）` : "");
      row.append(icon, text);
      if (t.details) row.title = t.details;
      list.appendChild(row);
    }
  }
  // 智能体行（subagent 计数，点击切到子代理 tab）
  const agentsRow = $("agentsRow");
  const subs = [...(s?.subagents.values() ?? [])];
  agentsRow.style.display = "";
  const running = subs.filter((x) => x.streaming).length;
  $("agentsRv").textContent = subs.length === 0 ? "—" : running ? `${subs.length} · ${running} 运行中` : `${subs.length}`;
}

// ---------- Git Diff（树/平铺 + diff2html 详情） ----------
export function refreshGitDiff(force = false) {
  const s = activeOpen();
  if (!s || !s.isGit) return; // 非 git 仓库不请求，不触发宿主报错
  if (!force && gitDiffCache.cwd === s.cwd) return; // 已有该仓库数据不重拉
  gitDiffCache.loading = true;
  gitDiffCache.cwd = s.cwd;
  send({ type: "get_git_diff", cwd: s.cwd });
}

export function requestFileDiff(s, filePath) {
  S.selectedFile = filePath;
  fileDiffCache.loading = true;
  fileDiffCache.path = filePath;
  send({ type: "get_file_diff", cwd: s.cwd, path: filePath });
  renderRightBody();
}

export function renderRightBody() {
  rightBodyEl.innerHTML = "";
  if (S.rightTab === null) renderStartPage(); // tab 全部关闭：居中起始页
  else if (S.rightTab === "gitdiff") renderGitDiff();
  else if (S.rightTab === "bgcmd") renderBgCmdList();
  else if (S.rightTab === "file") renderFileView();
  else if (S.rightTab === "tree") renderBranchTree();
  else renderSubagentList();
}

// tab 全关后的起始页：标题 + 副文 + 卡片网格（整体居中；一行最多 3 张超出换行）
function renderStartPage() {
  const s = activeOpen();
  const wrap = document.createElement("div");
  wrap.className = "rt-start";
  const tt = document.createElement("div");
  tt.className = "rt-start-tt";
  tt.textContent = "打开标签页";
  const sub = document.createElement("div");
  sub.className = "rt-start-sub";
  sub.textContent = "选择要在侧边面板中打开的标签。";
  const grid = document.createElement("div");
  grid.className = "rt-grid";
  for (const name of ["subagent", "gitdiff", "file", "bgcmd", "tree"]) {
    const meta = TAB_META[name];
    const card = document.createElement("button");
    card.className = "rt-card";
    card.innerHTML = `<span class="rt-card-ic">${icon(meta.icon, 14)}</span><span class="rt-card-tx">${meta.label}</span>`;
    if (name === "gitdiff" && !s?.isGit) {
      card.classList.add("off");
      card.title = "当前项目不是 git 仓库";
    } else {
      card.onclick = () => openRightTab(name);
    }
    grid.appendChild(card);
  }
  wrap.append(tt, sub, grid);
  rightBodyEl.appendChild(wrap);
}

// ---------- Git Diff 写操作（暂存/取消暂存/丢弃/提交/推送） ----------
// 进行中的写操作标记：{ op, prev }（prev = 发起前的 rightState.gitWrite 引用）。
// core 对 git 写回包不保证触发重绘（成功路径的 refreshGitDiff 在 cwd 未变时不发请求），
// 这里以 120ms 轮询比对 gitWrite 引用变化闭环——本地 git 操作毫秒级、push 秒级，轮询生命周期极短
let gitBusy = null;
let gitBusyTimer = null;
const GIT_WRITE_REPLY = { stage: "git_staged", unstage: "git_unstaged", discard: "git_discarded", commit: "git_committed", push: "git_pushed" };
function startGitBusy(op) {
  gitBusy = { op, prev: rightState.gitWrite };
  renderRightBody();
  clearInterval(gitBusyTimer);
  gitBusyTimer = setInterval(() => {
    const w = rightState.gitWrite;
    if (!gitBusy || !w || w === gitBusy.prev || w.type !== GIT_WRITE_REPLY[gitBusy.op]) return;
    if (w.ok && gitBusy.op === "commit") rightState.commitMsg = ""; // 提交成功清空输入框
    gitBusy = null;
    clearInterval(gitBusyTimer);
    refreshGitDiff(true); // 强制重拉（core 的非 force 刷新在 cwd 未变时不发请求）
    renderRightBody();
  }, 120);
}

// 工具条：提交信息输入（值存 rightState.commitMsg 跨重绘保持）+ 提交（全部已暂存）+ 推送
function renderGdToolbar() {
  const s = activeOpen();
  if (!s) return;
  const bar = document.createElement("div");
  bar.className = "gd-bar";
  const busy = !!gitBusy;
  const hasStaged = gitDiffCache.files.some((f) => f.staged);
  const inp = document.createElement("input");
  inp.className = "inp gd-commit-inp";
  inp.type = "text";
  inp.placeholder = "提交信息";
  inp.value = rightState.commitMsg;
  const commitBtn = document.createElement("button");
  inp.addEventListener("input", () => {
    rightState.commitMsg = inp.value;
    commitBtn.disabled = !inp.value.trim() || !hasStaged || busy;
  });
  commitBtn.className = "save-btn";
  commitBtn.textContent = "提交";
  commitBtn.title = "提交全部已暂存的改动";
  commitBtn.disabled = !rightState.commitMsg.trim() || !hasStaged || busy;
  if (busy && gitBusy.op === "commit") {
    commitBtn.classList.add("busy");
    commitBtn.innerHTML = icon("refresh", 13);
  }
  commitBtn.onclick = () => {
    const message = rightState.commitMsg.trim();
    if (!message) return;
    send({ type: "git_commit", cwd: s.cwd, message }); // 不带 paths = 提交全部已暂存
    startGitBusy("commit");
  };
  const pushBtn = document.createElement("button");
  pushBtn.className = "save-btn";
  pushBtn.textContent = "推送";
  pushBtn.title = "推送当前分支";
  pushBtn.disabled = busy;
  if (busy && gitBusy.op === "push") {
    pushBtn.classList.add("busy");
    pushBtn.innerHTML = icon("refresh", 13);
  }
  pushBtn.onclick = () => {
    send({ type: "git_push", cwd: s.cwd });
    startGitBusy("push");
  };
  bar.append(inp, commitBtn, pushBtn);
  rightBodyEl.appendChild(bar);
}

function renderGitDiff() {
  const s = activeOpen();
  if (!s) {
    rightBodyEl.innerHTML = '<div class="placeholder">（无活跃会话）</div>';
    return;
  }
  if (!s.isGit) {
    rightBodyEl.innerHTML = '<div class="placeholder">（该 project 不是 git 仓库）</div>';
    return;
  }
  if (S.selectedFile) return renderGdFileDetail(s);
  renderGdToolbar(); // 列表上方工具条（提交/推送），加载中与干净态也显示
  if (gitDiffCache.cwd !== s.cwd || gitDiffCache.loading) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = gitDiffCache.loading ? "加载中…" : "点右上角 ⟳ 加载改动";
    rightBodyEl.appendChild(d);
    return;
  }
  if (gitDiffCache.files.length === 0) {
    rightBodyEl.innerHTML = '<div class="placeholder">（工作区干净）</div>';
    return;
  }
  if (S.gitViewMode === "flat") {
    for (const f of gitDiffCache.files) rightBodyEl.appendChild(gitFileRow(f, f.path, 0));
    return;
  }
  renderTreeLevel(buildTree(gitDiffCache.files), "", 0);
}

// 行内写操作小按钮：图标 + 悬停提示；discard 为破坏性操作走 danger 变体
function gitActBtn(iconName, label, disabled, onConfirm) {
  const b = document.createElement("button");
  b.className = "gd-act" + (iconName === "discard" ? " danger" : "");
  b.title = label;
  b.innerHTML = icon(iconName);
  b.disabled = disabled;
  b.onclick = (e) => {
    e.stopPropagation(); // 不触发行点击的进详情
    onConfirm();
  };
  return b;
}

function gitFileRow(f, displayPath, depth) {
  const row = document.createElement("div");
  row.className = "gd-row";
  row.style.paddingLeft = 4 + depth * 14 + 14 + "px";
  row.title = f.path;
  const badge = document.createElement("span");
  badge.className = "gd-badge " + badgeClass(f.code);
  badge.textContent = f.code.includes("A") || f.code === "?" ? "A" : f.code.includes("D") ? "D" : "M";
  const name = document.createElement("span");
  name.className = "gd-name";
  name.textContent = displayPath.split("/").pop();
  row.append(badge, name);
  // 行内操作（hover 显示，树/平铺两视图共用本行渲染）：暂存/取消暂存按 XY 拆分字段判定，丢弃需二次确认
  const busy = !!gitBusy;
  const acts = document.createElement("span");
  acts.className = "gd-acts";
  const gitCwd = () => {
    const s = activeOpen();
    return s ? s.cwd : null; // cwd 取法对齐 refreshGitDiff（activeOpen().cwd）
  };
  if (f.unstaged) {
    acts.appendChild(
      gitActBtn("stage", "暂存", busy, () => {
        const cwd = gitCwd();
        if (!cwd) return;
        send({ type: "git_stage", cwd, paths: [f.path] });
        startGitBusy("stage");
      }),
    );
  }
  if (f.staged) {
    acts.appendChild(
      gitActBtn("unstage", "取消暂存", busy, () => {
        const cwd = gitCwd();
        if (!cwd) return;
        send({ type: "git_unstage", cwd, paths: [f.path] });
        startGitBusy("unstage");
      }),
    );
  }
  acts.appendChild(
    gitActBtn("discard", "丢弃（不可恢复）", busy, async () => {
      const cwd = gitCwd();
      if (!cwd) return;
      const yes = await confirmDialog({
        title: "丢弃更改",
        message: `将丢弃 ${f.path} 的未提交更改，此操作不可恢复。`,
        confirmText: "丢弃",
        danger: true,
      });
      if (!yes) return;
      send({ type: "git_discard", cwd, paths: [f.path] });
      startGitBusy("discard");
    }),
  );
  row.appendChild(acts);
  row.onclick = () => {
    const s = activeOpen();
    if (s) requestFileDiff(s, f.path);
  };
  return row;
}

function badgeClass(code) {
  if (code.includes("A") || code === "?") return "add";
  if (code.includes("D")) return "del";
  return "mod";
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}

function renderTreeLevel(node, prefix, depth) {
  for (const [seg, dir] of node.dirs) {
    const dirPath = prefix ? prefix + "/" + seg : seg;
    const expanded = rightState.expandedDirs.has(dirPath);
    const row = document.createElement("div");
    row.className = "gd-row";
    row.style.paddingLeft = 4 + depth * 14 + "px";
    const caret = document.createElement("span");
    caret.className = "gd-caret" + (expanded ? " open" : "");
    caret.innerHTML = icon("chevronRight", 10);
    const name = document.createElement("span");
    name.className = "gd-name";
    name.textContent = seg;
    const count = document.createElement("span");
    count.className = "gd-count";
    count.textContent = countFiles(dir);
    row.append(caret, name, count);
    if (S.animateGdKids) {
      row.classList.add("kids-in");
      row.style.animationDelay = depth * 15 + "ms"; // 按目录深度错峰
    }
    row.onclick = () => {
      if (rightState.expandedDirs.has(dirPath)) {
        rightState.expandedDirs.delete(dirPath);
      } else {
        rightState.expandedDirs.add(dirPath);
        S.animateGdKids = true; // 本次 renderRightBody 的子行播放入场动画
      }
      renderRightBody();
      S.animateGdKids = false;
    };
    rightBodyEl.appendChild(row);
    if (expanded) renderTreeLevel(dir, dirPath, depth + 1);
  }
  for (const f of node.files) {
    const fr = gitFileRow(f, f.path, depth);
    if (S.animateGdKids) {
      fr.classList.add("kids-in");
      fr.style.animationDelay = depth * 15 + "ms";
    }
    rightBodyEl.appendChild(fr);
  }
}

function renderGdFileDetail(s) {
  const back = document.createElement("button");
  back.className = "sub-back";
  back.textContent = "‹ 返回列表";
  back.onclick = () => {
    S.selectedFile = null;
    renderRightBody();
  };
  rightBodyEl.appendChild(back);
  const title = document.createElement("div");
  title.className = "sub-title";
  title.textContent = S.selectedFile;
  rightBodyEl.appendChild(title);
  if (fileDiffCache.loading && fileDiffCache.path === S.selectedFile) {
    rightBodyEl.insertAdjacentHTML("beforeend", '<div class="placeholder">加载中…</div>');
    return;
  }
  if (fileDiffCache.path !== S.selectedFile || !fileDiffCache.diff) {
    rightBodyEl.insertAdjacentHTML("beforeend", '<div class="placeholder">（无差异内容）</div>');
    return;
  }
  const holder = document.createElement("div");
  holder.className = "fd-holder" + (document.documentElement.dataset.theme === "dark" ? " d2h-dark-color-scheme" : "");
  holder.innerHTML = window.Diff2Html.html(fileDiffCache.diff, {
    drawFileList: false,
    outputFormat: "line-by-line",
    matching: "words",
    highlight: true,
  });
  rightBodyEl.appendChild(holder);
}

// ---------- 文件页（读取行点击 / 文件树点击进入） ----------
const FILE_VIEW_MAX_LINES = 800; // 全文件超长时的展示窗口：有读取范围则以范围起始行开头，否则从头
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]); // 与宿主 read_image 白名单一致
function renderFileView() {
  if (S.fileView) renderFvDetail();
  else renderFileTree(); // 空态：当前项目文件树
}

// 文件页路径面包屑：项目内「项目名 › 相对段」，项目外全路径；分隔符用向右箭头图标
function buildFileCrumb(absPath) {
  const root = (activeOpen()?.cwd || "").replace(/\/+$/, "");
  const abs = absPath.replace(/\/+$/, "");
  let segs;
  if (root && abs.startsWith(root + "/")) {
    segs = [root.split("/").filter(Boolean).pop(), ...abs.slice(root.length + 1).split("/")];
  } else {
    segs = abs.split("/").filter(Boolean);
  }
  const crumb = document.createElement("div");
  crumb.className = "fv-crumb";
  crumb.title = absPath;
  segs.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "fv-sep";
      sep.innerHTML = icon("chevronRight", 10);
      crumb.appendChild(sep);
    }
    const sp = document.createElement("span");
    sp.className = "fv-seg";
    sp.textContent = seg;
    crumb.appendChild(sp);
  });
  return crumb;
}

// 文件详情：先渲染读取到的内容，read_file 回包后切整文件（请求范围行号高亮 + 起始行滚到顶部）
function renderFvDetail() {
  const fv = S.fileView;
  const back = document.createElement("button");
  back.className = "sub-back";
  back.textContent = "‹ 文件树";
  back.onclick = () => {
    S.fileView = null;
    renderRightBody();
  };
  rightBodyEl.appendChild(back);
  rightBodyEl.appendChild(buildFileCrumb(fv.path));
  // 图片预览：read_image 回包（core 存入 rightState.imageContent）到达后渲染，未到显示加载中
  if (fv.image) return renderFvImage(fv);
  if (!fv.text && !fv.error) {
    rightBodyEl.insertAdjacentHTML("beforeend", '<div class="placeholder">加载中…</div>');
    return;
  }
  if (fv.error) {
    const err = document.createElement("div");
    err.className = "fv-more";
    err.textContent = `（${fv.error}）`;
    rightBodyEl.appendChild(err);
    if (!fv.text) return;
  }
  const lines = fv.text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // 末尾换行不算一行
  const [reqStart, reqEnd] = fv.reqRange || [];
  // 全文件模式：超长时窗口起点对齐请求范围的起始行（无范围则从头）；读取内容阶段（回包前）原样展示
  let winStartLine = fv.startLine || 1;
  let shown = lines;
  if (fv.full && lines.length > FILE_VIEW_MAX_LINES) {
    const winStart = reqStart != null
      ? Math.max(0, Math.min(reqStart - 1, lines.length - FILE_VIEW_MAX_LINES))
      : 0;
    shown = lines.slice(winStart, winStart + FILE_VIEW_MAX_LINES);
    winStartLine = winStart + 1;
  }
  const body = document.createElement("div");
  body.className = "fv-body";
  const lineNoOf = (i) => (fv.lineNumbers ? fv.lineNumbers[i] : winStartLine + i);
  for (let i = 0; i < shown.length; i++) {
    const row = document.createElement("div");
    row.className = "fv-line";
    const no = document.createElement("span");
    no.className = "fv-ln";
    const n = lineNoOf(i);
    no.textContent = n == null ? "…" : String(n); // null = 工具省略的空洞行
    // 请求的行号范围内只高亮行号列，不动内容
    if (n != null && reqStart != null && n >= reqStart && n <= reqEnd) no.classList.add("hl");
    const tx = document.createElement("span");
    tx.className = "fv-tx";
    tx.textContent = shown[i] === "" ? " " : shown[i];
    row.append(no, tx);
    body.appendChild(row);
  }
  rightBodyEl.appendChild(body);
  if (fv.full && lines.length > shown.length) {
    const more = document.createElement("div");
    more.className = "fv-more";
    more.textContent = `文件共 ${lines.length} 行，当前展示第 ${winStartLine}–${winStartLine + shown.length - 1} 行`;
    rightBodyEl.appendChild(more);
  }
  // 全文件就绪后把读取范围起始行滚到可视区顶部
  if (fv.full && reqStart != null) {
    const first = body.querySelector(".fv-ln.hl");
    if (first) first.scrollIntoView({ block: "start" });
  }
}

// 图片详情：image_content 回包按 path 匹配（超限/失败回 error 时显示错误态文案）
function renderFvImage(fv) {
  const ic = rightState.imageContent;
  if (!ic || ic.path !== fv.path) {
    rightBodyEl.insertAdjacentHTML("beforeend", '<div class="placeholder">加载中…</div>');
    return;
  }
  if (ic.error) {
    const err = document.createElement("div");
    err.className = "fv-more";
    err.textContent = `（${ic.error}）`;
    rightBodyEl.appendChild(err);
    return;
  }
  const img = document.createElement("img");
  img.className = "fv-img";
  img.src = `data:${ic.mime};base64,${ic.data}`;
  img.alt = fv.path.split("/").pop();
  rightBodyEl.appendChild(img);
}

// 空态：当前项目文件树（懒加载单层展开；点击文件进详情）
function renderFileTree() {
  const s = activeOpen();
  if (!s) {
    rightBodyEl.innerHTML = '<div class="placeholder">（无活跃会话）</div>';
    return;
  }
  const rootRow = document.createElement("div");
  rootRow.className = "ft-row ft-root";
  rootRow.innerHTML = `<span class="ft-ic">${icon("folder", 14)}</span><span class="ft-name">${s.cwd.split("/").filter(Boolean).pop() || s.cwd}</span>`;
  rootRow.title = s.cwd;
  rightBodyEl.appendChild(rootRow);
  renderFileTreeLevel(s.cwd, 1);
}
function renderFileTreeLevel(dirPath, depth) {
  const entries = rightState.fileTreeDirs.get(dirPath);
  if (entries === undefined) {
    if (!rightState.fileTreePending.has(dirPath)) {
      rightState.fileTreePending.add(dirPath);
      send({ type: "list_dir", path: dirPath });
    }
    rightBodyEl.insertAdjacentHTML("beforeend", '<div class="placeholder">加载中…</div>');
    return;
  }
  for (const e of entries) {
    const full = dirPath + "/" + e.name;
    const row = document.createElement("div");
    row.className = "ft-row";
    row.style.paddingLeft = 6 + depth * 14 + "px";
    if (e.dir) {
      const expanded = rightState.fileTreeExpanded.has(full);
      const caret = document.createElement("span");
      caret.className = "ft-caret" + (expanded ? " open" : "");
      caret.innerHTML = icon("chevronRight", 10);
      const name = document.createElement("span");
      name.className = "ft-name";
      name.textContent = e.name;
      row.append(caret, name);
      row.onclick = () => {
        if (rightState.fileTreeExpanded.has(full)) rightState.fileTreeExpanded.delete(full);
        else rightState.fileTreeExpanded.add(full);
        renderRightBody();
      };
      rightBodyEl.appendChild(row);
      if (expanded) renderFileTreeLevel(full, depth + 1);
    } else {
      row.innerHTML = `<span class="ft-caret ft-file-ic">${icon("ftFile")}</span><span class="ft-name">${e.name.replace(/</g, "&lt;")}</span>`;
      row.title = full;
      row.onclick = () => {
        // 图片文件分叉：发 read_image 走图片预览（宿主 8MB 上限 + 后缀白名单），其余照旧 read_file
        if (IMAGE_EXTS.has(full.split(".").pop().toLowerCase())) {
          S.fileView = { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null, image: true };
          S.fileViewPending = full;
          send({ type: "read_image", path: full });
        } else {
          S.fileView = { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null };
          S.fileViewPending = full;
          send({ type: "read_file", path: full });
        }
        renderRightBody();
      };
      rightBodyEl.appendChild(row);
    }
  }
}

// ---------- 分支树（当前会话家族：get_session_tree 懒加载 + 树形渲染 + 点击切换） ----------
// 分支行标题：title → 磁盘列表首消息截断 → 「未命名分支」（分支刚建未入 list_sessions 时无首消息）
function branchLabel(b) {
  if (b.title && b.title.trim()) return b.title;
  const fm = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === b.path)?.firstMessage;
  if (fm && fm.trim()) return fm.length > 40 ? fm.slice(0, 40) + "…" : fm;
  return "未命名分支";
}

// 点击分支行切换会话：与侧栏列表点击同一套动作（已打开直接激活，否则走宿主 load_session）
function loadBranchSession(path) {
  S.isCreatingNew = false;
  hideWelcomeScreen();
  unseenFinished.delete(path);
  saveUnseen();
  if (openSessions.has(path)) {
    S.activePath = path;
    refreshGitDiff();
  } else {
    send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
    send({ type: "load_session", path });
  }
  S.selectedSubagent = null;
  S.selectedFile = null;
  renderAll();
}

function renderBranchTree() {
  const s = activeOpen();
  if (!s) {
    rightBodyEl.innerHTML = '<div class="placeholder">（无活跃会话）</div>';
    return;
  }
  const tree = rightState.sessionTree;
  const stale = !tree || tree.sessionId !== s.sessionId; // 切换会话后旧数据视为过期
  if (stale && !rightState.sessionTreePending) {
    rightState.sessionTreePending = true;
    rightState.treeFor = s.sessionId;
    send({ type: "get_session_tree", sessionId: s.sessionId });
  }
  if (stale) {
    rightBodyEl.innerHTML = '<div class="placeholder">加载中…</div>';
    return;
  }
  const branches = tree.branches ?? [];
  if (branches.length <= 1) {
    const d = document.createElement("div");
    d.className = "bt-empty";
    d.textContent = "暂无其他分支。把鼠标移到历史消息上，点分叉按钮可从该消息处创建新分支。";
    rightBodyEl.appendChild(d);
    return;
  }
  // 按 parentSession 组树：根支（无父或父不在家族列表）在顶层，子支随父缩进（深度不限，样式统一）
  const byId = new Map(branches.map((b) => [b.sessionId, b]));
  const kidsOf = new Map();
  const roots = [];
  for (const b of branches) {
    if (b.parentSession && byId.has(b.parentSession)) {
      if (!kidsOf.has(b.parentSession)) kidsOf.set(b.parentSession, []);
      kidsOf.get(b.parentSession).push(b);
    } else roots.push(b);
  }
  const byTime = (x, y) => Date.parse(y.modified || 0) - Date.parse(x.modified || 0); // 同级新的在前
  roots.sort(byTime);
  for (const l of kidsOf.values()) l.sort(byTime);
  const list = document.createElement("div");
  list.className = "bt-list";
  const renderLevel = (items, depth) => {
    const box = document.createElement("div");
    if (depth > 0) box.className = "bt-kids"; // 嵌套容器自带竖线引导线，逐级缩进
    for (const b of items) {
      const row = document.createElement("button");
      row.className = "bt-row" + (b.isCurrent ? " cur" : "");
      row.title = b.path;
      const name = document.createElement("span");
      name.className = "bt-name";
      name.textContent = branchLabel(b);
      const meta = document.createElement("span");
      meta.className = "bt-meta";
      meta.textContent = [b.messageCount != null ? `${b.messageCount} 条` : null, b.modified ? fmtAgo(b.modified) : null].filter(Boolean).join(" · ");
      row.append(name, meta);
      if (!b.isCurrent) row.onclick = () => loadBranchSession(b.path);
      box.appendChild(row);
      const kids = kidsOf.get(b.sessionId);
      if (kids?.length) box.appendChild(renderLevel(kids, depth + 1));
    }
    return box;
  };
  list.appendChild(renderLevel(roots, 0));
  rightBodyEl.appendChild(list);
}

// ---------- 子代理（卡片列表 + 点击进流） ----------
function renderSubagentList() {
  const s = activeOpen();
  if (!s || s.subagents.size === 0) {
    rightBodyEl.innerHTML = '<div class="placeholder">（暂无子代理）</div>';
    return;
  }
  if (S.selectedSubagent && s.subagents.has(S.selectedSubagent)) {
    const sub = s.subagents.get(S.selectedSubagent);
    const back = document.createElement("button");
    back.className = "sub-back";
    back.textContent = "‹ 返回列表";
    back.onclick = () => {
      S.selectedSubagent = null;
      // 收起：详情内容上收（0.3s）后重绘回列表
      for (const el of [...rightBodyEl.children]) el.classList.add("lift");
      setTimeout(() => renderRightBody(), 310);
    };
    rightBodyEl.appendChild(back);
    const title = document.createElement("div");
    title.className = "sub-title";
    title.textContent = `${sub.agent} · ${sub.status}`;
    rightBodyEl.appendChild(title);
    const stream = document.createElement("div");
    stream.className = "sub-stream";
    for (const t of sub.tools) {
      stream.appendChild(renderToolItem({ role: "tool", text: t.name, ...t }));
    }
    if (sub.text || sub.streaming) {
      const d = renderStepTitle(sub.text || "…");
      if (sub.streaming) d.classList.add("flash");
      stream.appendChild(d);
    }
    rightBodyEl.appendChild(stream);
    // 展开：详情内容入场动画（卡片 → 执行过程视图）
    if (S.animateSubKids) {
      back.classList.add("kids-in");
      title.classList.add("kids-in");
      stream.classList.add("kids-in");
    }
    return;
  }
  for (const [id, sub] of s.subagents) {
    const card = document.createElement("button");
    card.className = "sub-card " + (sub.streaming ? "running" : sub.status);
    const head = document.createElement("div");
    head.className = "sub-card-head";
    const dot = document.createElement("span");
    dot.className = "sub-dot";
    dot.textContent = sub.streaming ? "●" : sub.status === "completed" ? "✓" : sub.status === "failed" ? "✗" : "○";
    const name = document.createElement("span");
    name.textContent = sub.agent;
    head.append(dot, name);
    const desc = document.createElement("div");
    desc.className = "sub-desc";
    desc.textContent = sub.description || sub.text.slice(0, 60) || "…";
    card.append(head, desc);
    card.onclick = () => {
      S.selectedSubagent = id;
      S.animateSubKids = true; // 本次 renderRightBody 的详情内容播放入场动画
      renderRightBody();
      S.animateSubKids = false;
    };
    rightBodyEl.appendChild(card);
  }
}

// ---------- 后台命令（hub）数据聚合、底部终端按钮与右栏列表 ----------
function getBgTasksForSession(s) {
  if (!s || !Array.isArray(s.items)) return { tasks: [], runningCount: 0 };
  const tasks = [];
  const liveProcesses = new Map(); // procName -> taskRef

  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    if (it.role !== "tool") continue;
    const name = it.name || it.text || "";
    if (name === "hub") {
      const args = it.args || {};
      const op = args.op || "cmd";
      const procName = args.name || args.application || "";
      let taskCommand = "";
      if (args.application) {
        const aList = Array.isArray(args.args) ? args.args : args.args ? [args.args] : [];
        taskCommand = `${args.application} ${aList.join(" ")}`.trim();
      } else if (args.command) {
        taskCommand = args.command;
      } else if (args.text) {
        taskCommand = args.text;
      } else if (procName) {
        taskCommand = procName;
      } else {
        taskCommand = `hub ${op}`;
      }

      const taskItem = {
        id: it.toolCallId || `hub_${i}`,
        toolCallId: it.toolCallId,
        op,
        procName,
        command: taskCommand,
        args,
        output: it.output || "",
        details: it.details,
        running: false,
        statusText: "已完成",
        cwd: args.cwd || s.cwd,
        timeIndex: i,
        rawItem: it,
      };

      if (op === "start") {
        taskItem.running = true;
        taskItem.statusText = "运行中";
        if (procName) liveProcesses.set(procName, taskItem);
      } else if (op === "stop" || op === "cancel") {
        taskItem.running = false;
        taskItem.statusText = "已停止";
        if (procName && liveProcesses.has(procName)) {
          const started = liveProcesses.get(procName);
          started.running = false;
          started.statusText = "已停止";
          liveProcesses.delete(procName);
        }
      } else if (it.running) {
        taskItem.running = true;
        taskItem.statusText = "运行中";
      }

      tasks.push(taskItem);
    } else if (it.running && (name === "bash" || name === "shell" || name === "eval")) {
      tasks.push({
        id: it.toolCallId || `cmd_${i}`,
        toolCallId: it.toolCallId,
        op: "run",
        procName: name,
        command: it.args?.command || it.text || name,
        args: it.args || {},
        output: it.output || "",
        details: it.details,
        running: true,
        statusText: "运行中",
        cwd: s.cwd,
        timeIndex: i,
        rawItem: it,
      });
    }
  }

  const runningCount = tasks.filter((t) => t.running).length;
  tasks.reverse(); // 最新的排在上方
  return { tasks, runningCount };
}

export function updateBgTaskButton() {
  const btn = $("bgTaskBtn");
  const numEl = $("bgTaskNum");
  if (!btn || !numEl) return;
  const s = activeOpen();
  if (!s) {
    numEl.textContent = "0";
    btn.classList.remove("has-running", "on");
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const { runningCount } = getBgTasksForSession(s);
  numEl.textContent = String(runningCount);
  btn.classList.toggle("has-running", runningCount > 0);
  btn.classList.toggle("on", S.rightTab === "bgcmd" && !isRightCollapsed());
}

function getRunningSubagentCount(s) {
  if (!s || !s.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}

export function updateBgSubagentButton() {
  const btn = $("bgSubagentBtn");
  const numEl = $("bgSubagentNum");
  if (!btn || !numEl) return;
  const s = activeOpen();
  if (!s) {
    numEl.textContent = "0";
    btn.classList.remove("has-running", "on");
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const count = getRunningSubagentCount(s);
  numEl.textContent = String(count);
  btn.classList.toggle("has-running", count > 0);
  btn.classList.toggle("on", S.rightTab === "subagent" && !isRightCollapsed());
}

let bgcmdOpenRow = null;

function closeBgCmdRow(animate = false) {
  if (bgcmdOpenRow) {
    bgcmdOpenRow.classList.remove("on");
    const exp = bgcmdOpenRow.nextElementSibling;
    if (exp && exp.classList.contains("bgcmd-expand")) {
      if (animate) liftEl(exp, 310, 0.3); // 点击已展开行收起：高度收拢动画（右栏 0.3s）
      else exp.remove(); // 切换到其他行：立即移除，避免与新区块重叠
    }
    bgcmdOpenRow = null;
  }
}

function toggleBgCmdRow(row, task) {
  if (bgcmdOpenRow === row) {
    closeBgCmdRow(true);
    return;
  }
  closeBgCmdRow(false);
  row.classList.add("on");
  bgcmdOpenRow = row;

  const exp = document.createElement("div");
  exp.className = "bgcmd-expand";

  // 1. 卡片头 / 元信息栏
  const metaRow = document.createElement("div");
  metaRow.className = "bgcmd-meta-row";
  const opSpan = document.createElement("span");
  opSpan.innerHTML = `<b>操作:</b> ${escapeHtml(task.op)}`;
  metaRow.appendChild(opSpan);

  if (task.procName) {
    const nameSpan = document.createElement("span");
    nameSpan.innerHTML = `<b>名称:</b> ${escapeHtml(task.procName)}`;
    metaRow.appendChild(nameSpan);
  }

  const sp = document.createElement("span");
  sp.className = "sp";
  metaRow.appendChild(sp);

  const tagSpan = document.createElement("span");
  tagSpan.className = "bgcmd-meta-tag" + (task.running ? " running" : "");
  tagSpan.textContent = task.statusText;
  metaRow.appendChild(tagSpan);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "save-btn";
  closeBtn.textContent = "收起";
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    closeBgCmdRow();
  };
  metaRow.appendChild(closeBtn);
  exp.appendChild(metaRow);

  if (task.cwd) {
    const cwdRow = document.createElement("div");
    cwdRow.className = "bgcmd-meta-row";
    cwdRow.style.fontSize = "var(--ui-fs-xs)";
    cwdRow.innerHTML = `<span><b>工作目录:</b> <span class="path" title="${escapeHtml(task.cwd)}">${escapeHtml(task.cwd)}</span></span>`;
    exp.appendChild(cwdRow);
  }

  // 2. 命令行与参数
  if (task.command) {
    const cmdTitle = document.createElement("div");
    cmdTitle.className = "bgcmd-meta-row";
    cmdTitle.style.marginTop = "8px";
    cmdTitle.innerHTML = `<b>命令 / 输入:</b>`;
    const cmdBox = document.createElement("div");
    cmdBox.className = "bgcmd-code";
    cmdBox.textContent = task.command;
    exp.append(cmdTitle, attachFadeMask(cmdBox));
  } else if (task.args && Object.keys(task.args).length > 0) {
    const cmdTitle = document.createElement("div");
    cmdTitle.className = "bgcmd-meta-row";
    cmdTitle.style.marginTop = "8px";
    cmdTitle.innerHTML = `<b>参数:</b>`;
    const cmdBox = document.createElement("div");
    cmdBox.className = "bgcmd-code";
    cmdBox.textContent = JSON.stringify(task.args, null, 2);
    exp.append(cmdTitle, attachFadeMask(cmdBox));
  }

  // 3. 输出与执行结果
  const outTitle = document.createElement("div");
  outTitle.className = "bgcmd-meta-row";
  outTitle.style.marginTop = "8px";
  outTitle.innerHTML = `<b>输出 / 响应:</b>`;
  const outBox = document.createElement("pre");
  outBox.className = "bgcmd-out";
  outBox.textContent = task.output || (task.running ? "任务运行中…" : "（无输出）");
  exp.append(outTitle, attachFadeMask(outBox));

  row.after(exp);
}

function renderBgCmdList() {
  closeBgCmdRow();
  const s = activeOpen();
  if (!s) {
    rightBodyEl.innerHTML = '<div class="placeholder">（无活跃会话）</div>';
    return;
  }
  const { tasks } = getBgTasksForSession(s);
  if (tasks.length === 0) {
    rightBodyEl.innerHTML = '<div class="placeholder">当前会话暂无后台命令</div>';
    return;
  }

  const list = document.createElement("div");
  list.className = "slist";
  list.style.padding = "4px 0";

  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = "srow bgcmd-row";

    const dot = document.createElement("span");
    dot.className = "bgcmd-dot" + (task.running ? " running" : "");

    const stext = document.createElement("div");
    stext.className = "stext";

    const titleEl = document.createElement("div");
    titleEl.style.display = "flex";
    titleEl.style.alignItems = "center";
    titleEl.style.gap = "6px";

    const opTag = document.createElement("b");
    opTag.style.color = "var(--text)";
    opTag.textContent = task.op.toUpperCase();

    const nameEl = document.createElement("span");
    nameEl.className = "path";
    nameEl.textContent = task.procName || task.command || "后台命令";
    nameEl.title = task.command || task.procName || "";

    titleEl.append(opTag, nameEl);
    stext.appendChild(titleEl);

    const tag = document.createElement("span");
    tag.className = "bgcmd-meta-tag" + (task.running ? " running" : "");
    tag.textContent = task.statusText;

    const caret = document.createElement("span");
    caret.className = "bgcmd-caret";
    caret.innerHTML = icon("caretSlim");

    row.append(dot, stext, tag, caret);

    row.onclick = () => toggleBgCmdRow(row, task);
    list.appendChild(row);
  }

  rightBodyEl.appendChild(list);
}

export function initRight() {
  $("statusCard").addEventListener("click", (e) => {
    if (e.target.closest("#agentsRow")) return;
    S.todoCollapsed = true;
    renderStatusCard();
  });
  $("capsule").addEventListener("click", () => {
    S.todoCollapsed = false;
    renderStatusCard();
  });
  $("agentsRow").addEventListener("click", () => {
    activateRightTab("subagent");
    S.selectedSubagent = null;
    expandRightPanel();
    renderRight();
  });

  // 底部后台任务终端按钮点击事件：展开并切换到后台命令 tab，或 toggle 收起
  $("bgTaskBtn").addEventListener("click", () => {
    const s = activeOpen();
    if (!s) return;
    if (!isRightCollapsed() && S.rightTab === "bgcmd") {
      setRightCollapsed(true);
    } else {
      activateRightTab("bgcmd");
      S.selectedFile = null;
      S.selectedSubagent = null;
      expandRightPanel();
      renderRight();
    }
    updateBgTaskButton();
    updateBgSubagentButton();
  });

  // 底部子智能体按钮点击事件：展开并切换到子代理 tab，或 toggle 收起
  $("bgSubagentBtn").addEventListener("click", () => {
    const s = activeOpen();
    if (!s) return;
    if (!isRightCollapsed() && S.rightTab === "subagent") {
      setRightCollapsed(true);
    } else {
      activateRightTab("subagent");
      S.selectedFile = null;
      S.selectedSubagent = null;
      expandRightPanel();
      renderRight();
    }
    updateBgTaskButton();
    updateBgSubagentButton();
  });

  $("gitRefresh").addEventListener("click", (e) => {
    e.stopPropagation();
    const s = activeOpen();
    if (!s || !s.isGit) return;
    gitDiffCache.cwd = null; // 强制重拉
    refreshGitDiff();
    renderRightBody();
  });
  $("gitViewToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    S.gitViewMode = S.gitViewMode === "tree" ? "flat" : "tree";
    $("gitViewToggle").textContent = S.gitViewMode === "tree" ? "树" : "平铺";
    renderRightBody();
  });
}
