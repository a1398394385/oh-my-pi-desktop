// omp desktop 前端：视觉与交互 1:1 仿照 prototype/session-view.html（kimi28 原型），
// 数据源换成本仓 WebSocket 宿主协议（host/host.ts）。
// 协议：命令 {create_session|load_session|list_sessions|prompt|get_messages|
//   set_approval_mode|approval_response|set_model|set_thinking|get_git_diff|
//   get_file_diff|get_context_detail}，事件见 onMessage。
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const streamEl = $("stream");
const tasklistEl = $("tasklist");
const inputEl = $("input");
const statusEl = $("conn-status");
const rightBodyEl = $("rightBody");
const composerEl = $("composer");
const modelBtn = $("modelBtn");
const thinkBtn = $("thinkBtn");
const modeBtn = $("modeBtn");

let rightTab = "subagent"; // subagent | gitdiff
let gitViewMode = "tree"; // tree | flat
let selectedFile = null; // gitdiff 内选中的文件（详情视图）
const fileDiffCache = { path: null, diff: "", loading: false };
const expandedDirs = new Set();
const gitDiffCache = { cwd: null, files: [], loading: false };
let changesOpen = false; // changebar 展开态
let todoCollapsed = false; // 进程卡收起为胶囊
let viewMode = "project"; // 左栏视图：project | recent

// WKWebView 无 console：未捕获错误显示在状态栏 + toast + 上报宿主日志（dev 终端可见）
window.onerror = (msg) => {
  statusEl.textContent = String(msg).slice(0, 80);
  statusEl.className = "bad";
  toast(String(msg).slice(0, 120));
  send({ type: "ui_error", message: String(msg).slice(0, 300) });
};
window.addEventListener("unhandledrejection", (e) => {
  send({ type: "ui_error", message: "unhandledrejection: " + String(e.reason).slice(0, 300) });
});

/** 磁盘会话列表：[{cwd, sessions:[{id,path,title,firstMessage,modified,messageCount}]}] */
const diskProjects = [];
const projectLimits = new Map(); // cwd -> 已显示条数（默认 5，步进 5）
const collapsedProjects = new Set(); // 已折叠的项目 cwd
/** 已打开（新建或加载）的会话：path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...} */
const openSessions = new Map();
let activePath = null;
let selectedSubagent = null; // 右栏流视图选中的 subagentId（null = 卡片列表）
let ws = null;
let pendingCreate = false;

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function setConnected(ok, text) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "bad";
}

function activeOpen() {
  return activePath ? openSessions.get(activePath) : undefined;
}

function findBySessionId(id) {
  for (const s of openSessions.values()) if (s.sessionId === id) return s;
  return undefined;
}

// ---------- toast（原型同款） ----------
const toastEl = $("toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2200);
}

async function connect() {
  setConnected(false, "连接中…");
  const url = await invoke("ws_url");
  ws = new WebSocket(url);
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onopen = () => {
    setConnected(true, "已连接");
    send({ type: "list_sessions" });
  };
  ws.onclose = () => setConnected(false, "已断开");
  ws.onerror = () => setConnected(false, "已断开");
}

function onMessage(msg) {
  switch (msg.type) {
    case "ready":
      setApprovalModeUi(msg.approvalMode);
      for (const m of msg.models ?? []) {
        modelNames.set(m.id, m.name);
        modelEfforts.set(m.id, m.efforts ?? []);
      }
      renderAll();
      break;
    case "approval_mode":
      setApprovalModeUi(msg.mode);
      break;
    case "approval_request": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      s.items.push({
        role: "approval",
        requestId: msg.requestId,
        title: msg.title,
        options: msg.options,
        editable: !!msg.editable,
        prefill: msg.prefill ?? "",
        answer: null,
      });
      renderAll();
      break;
    }
    case "approval_resolved":
      break; // 本地点击已即时定格
    case "session_list": {
      diskProjects.length = 0;
      diskProjects.push(...msg.projects);
      renderAll();
      break;
    }
    case "session_model": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.model = msg.model;
        if (msg.thinking) s.thinking = msg.thinking; // 切换后钳制生效值
      }
      renderAll();
      break;
    }
    case "session_thinking": {
      const s = findBySessionId(msg.sessionId);
      if (s) s.thinking = msg.level;
      renderAll();
      break;
    }
    case "session_created": {
      openSessions.set(msg.path, {
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        items: [],
        assistantDraft: "",
        streaming: false,
        turnStartAt: null,
        subagents: new Map(),
        model: msg.model ?? null,
        thinking: msg.thinking ?? "auto",
        isGit: !!msg.isGit,
        todos: [],
      });
      activePath = msg.path;
      selectedSubagent = null;
      selectedFile = null;
      changesOpen = false;
      refreshGitDiff(); // changebar 需要 git status 数据
      renderAll();
      if (pendingCreate) {
        pendingCreate = false;
        send({ type: "list_sessions" }); // 新会话已落盘，重拉列表
      }
      break;
    }
    case "event": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      if (msg.kind === "turn_start") {
        s.streaming = true;
        s.assistantDraft = "";
        s.turnStartAt = Date.now();
      } else if (msg.kind === "text_delta") {
        s.assistantDraft += msg.text;
      } else if (msg.kind === "tool") {
        s.items.push({ role: "tool", text: msg.name });
        s.assistantDraft = ""; // 工具调用前后的文本分段，草稿重开
      } else if (msg.kind === "turn_end") {
        if (s.assistantDraft) s.items.push({ role: "assistant", text: s.assistantDraft });
        s.assistantDraft = "";
        s.streaming = false;
        if (s.turnStartAt) {
          s.items.push({ role: "meta", text: `已工作 ${fmtDuration((Date.now() - s.turnStartAt) / 1000)} ›` });
          s.turnStartAt = null;
        }
        send({ type: "list_sessions" }); // title/firstMessage 可能已更新
        if (s.isGit) refreshGitDiff(true); // agent 可能改了文件，强制重拉
      }
      renderAll();
      break;
    }
    case "messages": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      s.items = msg.messages.map((m) => ({ role: m.role, text: m.text }));
      renderAll();
      break;
    }
    case "subagent_lifecycle": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      s.subagents.set(msg.subagentId, {
        agent: msg.agent,
        description: msg.description ?? "",
        status: msg.status,
        text: "",
        tools: [],
        streaming: msg.status === "started",
      });
      renderAll();
      break;
    }
    case "subagent_event": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      const sub = s.subagents.get(msg.subagentId);
      if (!sub) return;
      if (msg.kind === "turn_start") sub.streaming = true;
      else if (msg.kind === "text_delta") sub.text += msg.text;
      else if (msg.kind === "tool") sub.tools.push(msg.name);
      else if (msg.kind === "turn_end") sub.streaming = false;
      renderAll();
      break;
    }
    case "git_status": {
      gitDiffCache.cwd = msg.cwd;
      gitDiffCache.files = msg.files;
      gitDiffCache.loading = false;
      expandedDirs.clear();
      const dirs = new Set();
      for (const f of msg.files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      for (const d of dirs) expandedDirs.add(d);
      renderAll();
      break;
    }
    case "todos": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.todos = msg.phases ?? [];
        renderAll();
      }
      break;
    }
    case "file_diff": {
      fileDiffCache.path = msg.path;
      fileDiffCache.diff = msg.diff;
      fileDiffCache.loading = false;
      if (rightTab === "gitdiff" && selectedFile === msg.path) renderRightBody();
      break;
    }
    case "context": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.ctx = { tokens: msg.tokens, window: msg.window, percent: msg.percent };
        renderAll();
      }
      break;
    }
    case "context_detail":
      fillCtxCard(msg);
      break;
    case "error": {
      gitDiffCache.loading = false;
      const s = msg.sessionId && findBySessionId(msg.sessionId);
      if (s) {
        s.items.push({ role: "error", text: msg.message });
        renderAll();
      } else {
        toast(msg.message);
        renderRightBody();
      }
      break;
    }
  }
}

// ---------- 发送 / 新建 ----------
function sendPrompt() {
  const text = inputEl.value.trim();
  const s = activeOpen();
  if (!text || !s || ws.readyState !== 1) return;
  s.items.push({ role: "user", text });
  inputEl.value = "";
  resizeInput();
  updateSendReady();
  renderAll();
  ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text }));
}

function createIn(cwd) {
  send(cwd ? { type: "create_session", cwd } : { type: "create_session" });
  pendingCreate = true;
}

// ---------- 输入区 ----------
function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}
function updateSendReady() {
  $("sendBtn").classList.toggle("ready", inputEl.value.trim().length > 0);
}
inputEl.addEventListener("input", () => {
  resizeInput();
  updateSendReady();
});
$("sendBtn").addEventListener("click", sendPrompt);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

// ---------- 权限模式（omp 三值：always-ask | write | yolo） ----------
const MODE_META = {
  "always-ask": { label: "变更前确认", yolo: false },
  write: { label: "自动编辑", yolo: false },
  yolo: { label: "完全访问", yolo: true },
};
let approvalMode = "always-ask";
function setApprovalModeUi(mode) {
  approvalMode = mode ?? "always-ask";
  const meta = MODE_META[approvalMode] ?? MODE_META["always-ask"];
  $("modeLabel").textContent = meta.label;
  modeBtn.classList.toggle("yolo", meta.yolo);
  for (const mi of $("modeMenu").querySelectorAll(".mi[data-mode]")) {
    mi.querySelector(".ck").textContent = mi.dataset.mode === approvalMode ? "✓" : "";
  }
}
$("modeMenu").addEventListener("click", (e) => {
  const mi = e.target.closest(".mi[data-mode]");
  if (!mi) return;
  send({ type: "set_approval_mode", mode: mi.dataset.mode });
  closeAllMenus();
});

// ---------- 模型 / 思考级别（值域来自宿主下发） ----------
const modelNames = new Map(); // "provider/id" -> 显示名
const modelEfforts = new Map(); // "provider/id" -> 支持的思考档位
const THINKING_LABELS = { auto: "自动", off: "关", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };

function currentThinkingLevels() {
  const cur = activeOpen();
  const efforts = cur ? modelEfforts.get(cur.model) ?? [] : [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

function buildModelMenu() {
  const menu = $("modelMenu");
  menu.innerHTML = "";
  // 按 provider 分组（宿主下发 id 形如 "provider/modelId"）
  const groups = new Map();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov).push([id, name]);
  }
  const cur = activeOpen();
  for (const [prov, models] of groups) {
    const head = document.createElement("div");
    head.className = "prov";
    head.textContent = prov;
    menu.appendChild(head);
    for (const [id, name] of models) {
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.model = id;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = cur?.model === id ? "✓" : "";
      mi.appendChild(ck);
      mi.appendChild(document.createTextNode(name));
      menu.appendChild(mi);
    }
  }
}

function buildThinkMenu() {
  const menu = $("thinkMenu");
  menu.innerHTML = '<div class="mh">推理强度（随当前模型能力变化）</div>';
  const cur = activeOpen();
  for (const lv of currentThinkingLevels()) {
    const mi = document.createElement("div");
    mi.className = "mi";
    mi.dataset.level = lv;
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = cur?.thinking === lv ? "✓" : "";
    mi.appendChild(ck);
    mi.appendChild(document.createTextNode(THINKING_LABELS[lv] ?? lv));
    menu.appendChild(mi);
  }
}

$("modelMenu").addEventListener("click", (e) => {
  const mi = e.target.closest(".mi[data-model]");
  if (!mi) return;
  const s = activeOpen();
  if (s) send({ type: "set_model", sessionId: s.sessionId, model: mi.dataset.model });
  closeAllMenus();
});
$("thinkMenu").addEventListener("click", (e) => {
  const mi = e.target.closest(".mi[data-level]");
  if (!mi) return;
  const s = activeOpen();
  if (s) send({ type: "set_thinking", sessionId: s.sessionId, level: mi.dataset.level });
  closeAllMenus();
});

// ---------- 上下文明细卡（hover 上下文环弹出，移开隐藏） ----------
function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

let ringPop = null;
let ringHovering = false;

function buildCtxCard(detail) {
  const pop = document.createElement("div");
  pop.className = "ring-pop";
  const b = detail?.breakdown;
  if (b) {
    const head = document.createElement("div");
    head.className = "cx-head";
    const t = document.createElement("b");
    t.textContent = "上下文容量";
    const total = document.createElement("span");
    total.className = "cx-total";
    total.textContent = `${fmtTokens(b.usedTokens)}/${fmtTokens(b.contextWindow)}（${((b.usedTokens / b.contextWindow) * 100).toFixed(1)}%）`;
    head.append(t, total);
    pop.appendChild(head);
    const bar = document.createElement("div");
    bar.className = "cx-bar";
    bar.innerHTML = `<i style="width:${Math.min(100, (b.usedTokens / b.contextWindow) * 100).toFixed(1)}%"></i>`;
    pop.appendChild(bar);
    const pct = (v) => ((v / b.usedTokens) * 100).toFixed(1) + "%";
    const rows = [
      ["消息", b.messagesTokens, "#4a9eff"],
      ["系统工具", b.systemToolsTokens, "#6fa8dc"],
      ["系统提示词", b.systemPromptTokens, "#557fb8"],
    ];
    if (b.systemContextTokens) rows.push(["上下文注入", b.systemContextTokens, "#6296cc"]);
    if (b.skillsTokens) rows.push(["技能", b.skillsTokens, "#47699e"]);
    for (const [label, v, color] of rows) {
      const r = document.createElement("div");
      r.className = "cx-row";
      r.innerHTML = `<span class="dot" style="background:${color}"></span>${label}<span class="rv">${fmtTokens(v)} · ${pct(v)}</span>`;
      pop.appendChild(r);
    }
  }
  const st = detail?.stats;
  if (st) {
    const sec = document.createElement("div");
    sec.className = "cx-sec";
    sec.textContent = "会话统计";
    pop.appendChild(sec);
    const stRows = [
      ["输入 / 输出", `${fmtTokens(st.tokens.input)} / ${fmtTokens(st.tokens.output)}`],
      ["缓存读 / 写", `${fmtTokens(st.tokens.cacheRead)} / ${fmtTokens(st.tokens.cacheWrite)}`],
      ["累计消耗", fmtTokens(st.tokens.total)],
      ["消息（用/助/工具）", `${st.userMessages}/${st.assistantMessages}/${st.toolCalls}`],
      ["花费", st.cost != null ? `$${st.cost.toFixed(3)}` : "—"],
    ];
    if (st.tokens.reasoning) stRows.splice(1, 0, ["推理", fmtTokens(st.tokens.reasoning)]);
    for (const [label, v] of stRows) {
      const r = document.createElement("div");
      r.className = "cx-row";
      r.textContent = label;
      const rv = document.createElement("span");
      rv.className = "rv";
      rv.textContent = v;
      r.appendChild(rv);
      pop.appendChild(r);
    }
  }
  if (!pop.childNodes.length) pop.textContent = "上下文用量暂无数据";
  return pop;
}

function showRingPop() {
  ringPop?.remove();
  ringPop = buildCtxCard(null);
  ringPop.textContent = "加载中…";
  document.body.appendChild(ringPop);
  // 卡片底边对齐环顶：视觉坐标经 placeMenu 除以 zoomLevel 补偿（fixed + zoom 二次缩放坑）
  const r = $("ctxRing").getBoundingClientRect();
  placeMenu(ringPop, Math.min(r.left, window.innerWidth - 400), r.top - ringPop.offsetHeight - 8);
}

// 明细数据到达：鼠标仍悬停在环上才填充（移开即弃）
function fillCtxCard(detail) {
  if (!ringHovering || !ringPop) return;
  const r = $("ctxRing").getBoundingClientRect();
  ringPop.replaceWith((ringPop = buildCtxCard(detail)));
  placeMenu(ringPop, Math.min(r.left, window.innerWidth - 400), r.top - ringPop.offsetHeight - 8);
}

$("ctxRing").addEventListener("mouseenter", () => {
  const s = activeOpen();
  if (!s) return;
  ringHovering = true;
  showRingPop();
  send({ type: "get_context_detail", sessionId: s.sessionId });
});
$("ctxRing").addEventListener("mouseleave", () => {
  ringHovering = false;
  ringPop?.remove();
  ringPop = null;
});

// ---------- 菜单开合（原型同款：composer 内 absolute + 互斥） ----------
function closeAllMenus() {
  closeCtxMenu();
  closeThemeMenu();
  for (const m of document.querySelectorAll(".menu.open")) m.classList.remove("open");
}
window.addEventListener("click", closeAllMenus);
window.addEventListener("blur", closeAllMenus);

// 打开 composer 内菜单：left 跟随按钮，右缘不越界
function openComposerMenu(menu, btn) {
  closeAllMenus();
  menu.classList.add("open");
  const maxLeft = composerEl.clientWidth - menu.offsetWidth - 4;
  menu.style.left = Math.max(0, Math.min(btn.offsetLeft, maxLeft)) + "px";
}

modeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("modeMenu");
  if (menu.classList.contains("open")) return closeAllMenus();
  openComposerMenu(menu, modeBtn);
});
modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!activeOpen()) return;
  const menu = $("modelMenu");
  if (menu.classList.contains("open")) return closeAllMenus();
  buildModelMenu();
  openComposerMenu(menu, modelBtn);
});
thinkBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!activeOpen()) return;
  const menu = $("thinkMenu");
  if (menu.classList.contains("open")) return closeAllMenus();
  buildThinkMenu();
  openComposerMenu(menu, thinkBtn);
});

// ---------- 左栏：任务列表（项目 / 最近 双视图） ----------
const svgPin = '<svg class="ti" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M7.8 1.2 10.8 4.2 8.5 4.8 6.8 6.5 6.2 8.8 3.2 5.8 1.8 7.2l-.6-.6L6 2l.6-1.2z" transform="rotate(45 6 6)"/></svg>';
const svgFold = '<svg width="13" height="12" viewBox="0 0 13 12" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 2.5h3l1 1.5h6v5.5h-10z"/></svg>';

function fmtAgo(iso) {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return "刚刚";
  if (sec < 3600) return Math.floor(sec / 60) + "分";
  if (sec < 86400) return Math.floor(sec / 3600) + "小时";
  return Math.floor(sec / 86400) + "天";
}
function fmtDuration(sec) {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}
function sessionLabel(s) {
  return s.title || s.firstMessage || "（空会话）";
}

function taskRow(s, { sub, showRepo } = {}) {
  const b = document.createElement("button");
  b.className = "task" + (sub ? " sub" : "") + (s.path === activePath ? " on" : "");
  b.dataset.path = s.path;
  const open = openSessions.get(s.path);
  if (sub) {
    if (open?.streaming) {
      const dot = document.createElement("span");
      dot.className = "live-dot";
      dot.title = "运行中";
      b.appendChild(dot);
    }
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
  const tm = document.createElement("span");
  tm.className = "tm";
  tm.textContent = fmtAgo(s.modified);
  b.appendChild(tm);
  b.onclick = () => {
    if (openSessions.has(s.path)) {
      activePath = s.path;
      refreshGitDiff();
    } else {
      send({ type: "load_session", path: s.path });
    }
    selectedSubagent = null;
    selectedFile = null;
    changesOpen = false;
    renderAll();
  };
  return b;
}

function renderList() {
  tasklistEl.innerHTML = "";
  if (viewMode === "project") {
    const label = document.createElement("div");
    label.className = "sec-label";
    label.textContent = "项目";
    tasklistEl.appendChild(label);
    for (const p of diskProjects) {
      const proj = document.createElement("div");
      proj.className = "proj" + (collapsedProjects.has(p.cwd) ? " collapsed" : "");
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = "▾";
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
      name.title = p.cwd;
      const cnt = document.createElement("span");
      cnt.className = "cnt";
      cnt.textContent = p.sessions.length;
      const add = document.createElement("button");
      add.className = "padd";
      add.textContent = "＋";
      add.title = `在 ${p.cwd} 新建会话`;
      add.onclick = (e) => {
        e.stopPropagation();
        createIn(p.cwd);
      };
      // 点击组头折叠/展开；再展开时分页重置回默认 5 条
      proj.onclick = () => {
        if (collapsedProjects.has(p.cwd)) {
          collapsedProjects.delete(p.cwd);
          projectLimits.delete(p.cwd);
        } else {
          collapsedProjects.add(p.cwd);
        }
        renderList();
      };
      proj.append(caret);
      proj.insertAdjacentHTML("beforeend", svgFold);
      proj.append(name, cnt, add);
      tasklistEl.appendChild(proj);
      if (collapsedProjects.has(p.cwd)) continue;
      // 默认 5 条，按需每次多加载 5 条
      const limit = projectLimits.get(p.cwd) ?? 5;
      const visible = p.sessions.slice(0, limit);
      for (const s of visible) tasklistEl.appendChild(taskRow(s, { sub: true }));
      if (p.sessions.length > visible.length) {
        const more = document.createElement("button");
        more.className = "more-link";
        more.textContent = `显示更多 ${visible.length}/${p.sessions.length}`;
        more.onclick = () => {
          projectLimits.set(p.cwd, visible.length + 5);
          renderList();
        };
        tasklistEl.appendChild(more);
      }
      if (p.sessions.length === 0) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "暂无任务";
        tasklistEl.appendChild(hint);
      }
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

// 左栏 seg 视图切换 + 新建
$("seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  viewMode = b.dataset.view;
  for (const x of $("seg").querySelectorAll("button")) x.classList.toggle("on", x === b);
  renderList();
});
$("navNew").addEventListener("click", () => createIn(activeOpen()?.cwd));

// ⌘N 新建任务
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    createIn(activeOpen()?.cwd);
  }
});

// ---------- 中栏：标题 + 文件更改条 + 消息流 ----------
function renderChat() {
  const s = activeOpen();
  let chatTitle = "选择左侧会话或新建任务";
  if (s) {
    const entry = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === activePath);
    chatTitle = entry ? sessionLabel(entry) : s.cwd.split("/").filter(Boolean).pop() || s.cwd;
  }
  $("chatTitle").textContent = chatTitle;

  // 文件更改条（git 会话专属；数据来自 gitDiffCache，加载中不显示旧仓库数据）
  const bar = $("changebar");
  const files = $("changesFiles");
  if (s?.isGit && gitDiffCache.cwd === s.cwd && !gitDiffCache.loading) {
    bar.classList.remove("hidden");
    files.classList.toggle("open", changesOpen);
    $("chv").style.transform = changesOpen ? "rotate(180deg)" : "";
    const fs = gitDiffCache.files;
    const nA = fs.filter((f) => f.code.includes("A") || f.code === "?").length;
    const nD = fs.filter((f) => f.code.includes("D")).length;
    const nM = fs.length - nA - nD;
    $("cbText").innerHTML =
      `${fs.length} 个文件已更改` +
      (nA ? ` <span class="add">+${nA}</span>` : "") +
      (nD ? ` <span class="del">−${nD}</span>` : "") +
      (nM ? ` <span class="mod">~${nM}</span>` : "");
    files.innerHTML = "";
    if (changesOpen) {
      for (const f of fs) {
        const row = document.createElement("div");
        row.className = "f";
        const code = document.createElement("b");
        const cls = f.code.includes("A") || f.code === "?" ? "a" : f.code.includes("D") ? "d" : "m";
        code.className = cls;
        code.textContent = f.code.includes("A") || f.code === "?" ? "+" : f.code.includes("D") ? "−" : "~";
        const path = document.createElement("span");
        path.textContent = f.path;
        path.style.overflow = "hidden";
        path.style.textOverflow = "ellipsis";
        path.style.whiteSpace = "nowrap";
        row.append(code, path);
        row.title = f.path;
        row.onclick = () => openFileDetail(f.path);
        files.appendChild(row);
      }
      if (fs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "f";
        empty.style.cursor = "default";
        empty.textContent = "工作区干净";
        files.appendChild(empty);
      }
    }
  } else {
    bar.classList.add("hidden");
    files.classList.remove("open");
  }

  // 消息流
  streamEl.innerHTML = "";
  if (!s) {
    streamEl.innerHTML = '<div class="placeholder">点左侧任务或「新建任务」开始</div>';
    return;
  }
  for (const item of s.items) {
    const div = document.createElement("div");
    if (item.role === "user") {
      div.className = "msg user";
      div.textContent = item.text;
    } else if (item.role === "assistant") {
      div.className = "assistant-text";
      div.textContent = item.text;
    } else if (item.role === "tool") {
      div.className = "act";
      div.textContent = `⚙ ${item.text}`;
    } else if (item.role === "meta") {
      div.className = "act";
      div.textContent = item.text;
    } else if (item.role === "approval") {
      div.className = "approval-card";
      const t = document.createElement("pre");
      t.className = "approval-title";
      t.textContent = item.title;
      div.appendChild(t);
      const btns = document.createElement("div");
      btns.className = "approval-buttons";
      let inp = null;
      if (item.editable) {
        inp = document.createElement("input");
        inp.type = "text";
        inp.className = "approval-input";
        inp.placeholder = "输入后点提交…";
        inp.value = item.prefill || "";
        if (item.answer !== null) inp.disabled = true;
        inp.oninput = () => {
          item.prefill = inp.value; // 全量重绘时保住已输入内容
        };
        btns.appendChild(inp);
      }
      for (const opt of item.options) {
        const b = document.createElement("button");
        b.textContent = item.answer !== null && item.answer === opt ? `✓ ${opt}` : opt;
        if (item.answer !== null) b.disabled = true;
        if (item.answer === opt) b.className = "chosen";
        else if (item.answer !== null) b.className = "dim";
        b.onclick = () => {
          if (item.answer !== null) return;
          let answer = opt;
          if (item.editable) {
            if (opt === "提交") answer = inp.value.trim() || null; // 空输入按取消处理
            else answer = undefined;
          }
          item.answer = answer ?? opt;
          send({ type: "approval_response", requestId: item.requestId, answer });
          renderAll();
        };
        btns.appendChild(b);
      }
      div.appendChild(btns);
    } else {
      div.className = "act err";
      div.textContent = `✗ ${item.text}`;
    }
    streamEl.appendChild(div);
  }
  if (s.streaming || s.assistantDraft) {
    const act = document.createElement("div");
    act.className = "act t2";
    const elapsed = s.turnStartAt ? Math.floor((Date.now() - s.turnStartAt) / 1000) : 0;
    act.innerHTML = `工作中 <span id="workSec">${elapsed}</span> 秒`;
    streamEl.appendChild(act);
  }
  if (s.assistantDraft) {
    const draft = document.createElement("div");
    draft.className = "assistant-text";
    draft.textContent = s.assistantDraft;
    streamEl.appendChild(draft);
  }
  if (s.streaming) {
    const spin = document.createElement("span");
    spin.className = "spin on";
    spin.textContent = "✳";
    streamEl.appendChild(spin);
  }
  streamEl.scrollTop = streamEl.scrollHeight;
}

// 「工作中 N 秒」每秒跳（重绘后 span 重建，按 id 重新查询）
setInterval(() => {
  const s = activeOpen();
  const el = $("workSec");
  if (s?.turnStartAt && el) el.textContent = Math.floor((Date.now() - s.turnStartAt) / 1000);
}, 1000);

// 更改条开合
$("changebar").addEventListener("click", () => {
  changesOpen = !changesOpen;
  renderChat();
});

// 更改条文件 → 右栏 Git Diff 详情页
function openFileDetail(filePath) {
  const s = activeOpen();
  if (!s) return;
  rightTab = "gitdiff";
  expandRightPanel();
  requestFileDiff(s, filePath);
  renderRight(); // 刷新 seg 高亮与工具按钮
}

// ---------- composer 状态条（模式/模型/思考 按钮文案与禁用态 + 上下文环） ----------
const RING_C = 40.84; // 2π×6.5（与 CSS dasharray 一致）

function renderComposerBar() {
  const s = activeOpen();
  modelBtn.disabled = thinkBtn.disabled = !s;
  $("modelLabel").textContent = s?.model ? (modelNames.get(s.model) ?? s.model.split("/").pop()) : "模型";
  $("thinkLabel").textContent = s ? (s.thinking ? THINKING_LABELS[s.thinking] ?? s.thinking : "思考") : "思考";
  // 上下文环：从顶端顺时针填充；无数据空环
  const ring = $("ctxRing");
  ring.hidden = !s;
  if (s) {
    const p = s.ctx ? Math.min(1, s.ctx.percent / 100) : 0;
    $("ctxRingFill").style.strokeDashoffset = String(RING_C * (1 - p));
    ring.className = "ctx-ring" + (s.ctx ? (s.ctx.percent >= 85 ? " hot" : s.ctx.percent >= 60 ? " warm" : "") : "");
  }
}

// ---------- 右栏 ----------
function renderRight() {
  const s = activeOpen();
  if (rightTab === "gitdiff" && !s?.isGit) rightTab = "subagent"; // 非 git 会话回落，seg 不留 gitdiff 高亮
  // 工具条 project 名
  $("wsName").textContent = s ? s.cwd.split("/").filter(Boolean).pop() : "—";
  // 进程状态卡（TODO）
  renderStatusCard();
  // 双 tab seg
  const seg = $("rightSeg");
  for (const b of seg.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.tab === rightTab);
    b.style.display = b.dataset.tab === "gitdiff" && !s?.isGit ? "none" : "";
  }
  const isGitTab = rightTab === "gitdiff";
  $("gitRefresh").style.display = isGitTab ? "" : "none";
  $("gitViewToggle").style.display = isGitTab ? "" : "none";
  $("gitViewToggle").textContent = gitViewMode === "tree" ? "树" : "平铺";
  renderRightBody();
}

function renderStatusCard() {
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
  card.classList.toggle("hidden", todoCollapsed);
  capsule.classList.toggle("hidden", !todoCollapsed);
  const done = all.filter((t) => t.status === "completed").length;
  const frac = `${done}/${all.length}`;
  capsule.innerHTML = `进程&nbsp; ${frac}`;
  if (todoCollapsed) return;
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

$("scCollapse").addEventListener("click", () => {
  todoCollapsed = true;
  renderStatusCard();
});
$("capsule").addEventListener("click", () => {
  todoCollapsed = false;
  renderStatusCard();
});
$("agentsRow").addEventListener("click", () => {
  rightTab = "subagent";
  selectedSubagent = null;
  expandRightPanel();
  renderRight();
});

// ---------- Git Diff（树/平铺 + diff2html 详情） ----------
function refreshGitDiff(force = false) {
  const s = activeOpen();
  if (!s || !s.isGit) return; // 非 git 仓库不请求，不触发宿主报错
  if (!force && gitDiffCache.cwd === s.cwd) return; // 已有该仓库数据不重拉
  gitDiffCache.loading = true;
  gitDiffCache.cwd = s.cwd;
  send({ type: "get_git_diff", cwd: s.cwd });
}

function requestFileDiff(s, filePath) {
  selectedFile = filePath;
  fileDiffCache.loading = true;
  fileDiffCache.path = filePath;
  send({ type: "get_file_diff", cwd: s.cwd, path: filePath });
  renderRightBody();
}

function renderRightBody() {
  rightBodyEl.innerHTML = "";
  if (rightTab === "gitdiff") renderGitDiff();
  else renderSubagentList();
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
  if (selectedFile) return renderFileDetail(s);
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
  if (gitViewMode === "flat") {
    for (const f of gitDiffCache.files) rightBodyEl.appendChild(gitFileRow(f, f.path, 0));
    return;
  }
  renderTreeLevel(buildTree(gitDiffCache.files), "", 0);
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
    const expanded = expandedDirs.has(dirPath);
    const row = document.createElement("div");
    row.className = "gd-row";
    row.style.paddingLeft = 4 + depth * 14 + "px";
    const caret = document.createElement("span");
    caret.className = "gd-caret";
    caret.textContent = expanded ? "▾" : "▸";
    const name = document.createElement("span");
    name.className = "gd-name";
    name.textContent = seg;
    const count = document.createElement("span");
    count.className = "gd-count";
    count.textContent = countFiles(dir);
    row.append(caret, name, count);
    row.onclick = () => {
      if (expandedDirs.has(dirPath)) expandedDirs.delete(dirPath);
      else expandedDirs.add(dirPath);
      renderRightBody();
    };
    rightBodyEl.appendChild(row);
    if (expanded) renderTreeLevel(dir, dirPath, depth + 1);
  }
  for (const f of node.files) rightBodyEl.appendChild(gitFileRow(f, f.path, depth));
}

function renderFileDetail(s) {
  const back = document.createElement("button");
  back.className = "sub-back";
  back.textContent = "‹ 返回列表";
  back.onclick = () => {
    selectedFile = null;
    renderRightBody();
  };
  rightBodyEl.appendChild(back);
  const title = document.createElement("div");
  title.className = "sub-title";
  title.textContent = selectedFile;
  rightBodyEl.appendChild(title);
  if (fileDiffCache.loading && fileDiffCache.path === selectedFile) {
    rightBodyEl.insertAdjacentHTML("beforeend", '<div class="placeholder">加载中…</div>');
    return;
  }
  if (fileDiffCache.path !== selectedFile || !fileDiffCache.diff) {
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

// ---------- 子代理（卡片列表 + 点击进流） ----------
function renderSubagentList() {
  const s = activeOpen();
  if (!s || s.subagents.size === 0) {
    rightBodyEl.innerHTML = '<div class="placeholder">（暂无子代理）</div>';
    return;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    const sub = s.subagents.get(selectedSubagent);
    const back = document.createElement("button");
    back.className = "sub-back";
    back.textContent = "‹ 返回列表";
    back.onclick = () => {
      selectedSubagent = null;
      renderRightBody();
    };
    rightBodyEl.appendChild(back);
    const title = document.createElement("div");
    title.className = "sub-title";
    title.textContent = `${sub.agent} · ${sub.status}`;
    rightBodyEl.appendChild(title);
    const stream = document.createElement("div");
    stream.className = "sub-stream";
    for (const t of sub.tools) {
      const d = document.createElement("div");
      d.className = "act";
      d.style.margin = "6px 0";
      d.textContent = `⚙ ${t}`;
      stream.appendChild(d);
    }
    if (sub.text || sub.streaming) {
      const d = document.createElement("div");
      d.className = "assistant-text";
      d.textContent = sub.text || "…";
      if (sub.streaming) d.classList.add("flash");
      stream.appendChild(d);
    }
    rightBodyEl.appendChild(stream);
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
      selectedSubagent = id;
      renderRightBody();
    };
    rightBodyEl.appendChild(card);
  }
}

// 右栏 seg / 刷新 / 树平铺切换
$("rightSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  rightTab = b.dataset.tab;
  selectedFile = null;
  if (rightTab === "gitdiff") refreshGitDiff();
  renderRight();
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
  gitViewMode = gitViewMode === "tree" ? "flat" : "tree";
  $("gitViewToggle").textContent = gitViewMode === "tree" ? "树" : "平铺";
  renderRightBody();
});

// 右栏开合（原型 panelToggle 动作：隐藏 = grid 第三列收 0）
$("panelToggle").addEventListener("click", function () {
  const off = $("right").classList.toggle("collapsed");
  $("right-resizer").style.display = off ? "none" : "";
  this.classList.toggle("on", !off);
});
function expandRightPanel() {
  $("right").classList.remove("collapsed");
  $("right-resizer").style.display = "";
  $("panelToggle").classList.add("on");
}

// ---------- 主题（深色 / 浅色 / 跟随系统） ----------
let themeMode = "dark";
const themeMq = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(mode) {
  themeMode = mode;
  const dark = mode === "system" ? themeMq.matches : mode === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem("omp-theme", mode);
  } catch {}
  // 已渲染的 diff 详情跟随切换主题
  for (const h of document.querySelectorAll(".fd-holder")) h.classList.toggle("d2h-dark-color-scheme", dark);
}
themeMq.addEventListener("change", () => {
  if (themeMode === "system") applyTheme("system");
});

let themeMenu = null;
function closeThemeMenu() {
  themeMenu?.remove();
  themeMenu = null;
}
$("themeBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (themeMenu) return closeThemeMenu();
  closeAllMenus();
  themeMenu = document.createElement("div");
  themeMenu.className = "ctx-menu";
  placeMenu(themeMenu, 0, 0); // 先挂载量尺寸
  document.body.appendChild(themeMenu);
  for (const [mode, label] of [
    ["dark", "🌙 深色"],
    ["light", "☀️ 浅色"],
    ["system", "◐ 跟随系统"],
  ]) {
    const b = document.createElement("button");
    b.textContent = (themeMode === mode ? "✓ " : "") + label;
    b.onclick = () => {
      applyTheme(mode);
      closeThemeMenu();
    };
    themeMenu.appendChild(b);
  }
  const r = $("themeBtn").getBoundingClientRect();
  placeMenu(themeMenu, Math.min(r.left, window.innerWidth - 180), r.bottom + 6);
});
try {
  const saved = localStorage.getItem("omp-theme");
  if (saved) applyTheme(saved);
} catch {}

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

// ---------- 边栏拖动调宽 ----------
// 宽度走 CSS 变量，localStorage 记忆；拖动 dx 除以 zoomLevel（布局宽 ≠ 屏幕宽）
function attachResizer(handleId, cssVar, min, max, invert) {
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
      const dx = (ev.clientX - startX) / zoomLevel;
      const w = Math.round(Math.min(Math.max(invert ? startW - dx : startW + dx, min), max));
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
attachResizer("left-resizer", "--left-w", 200, 420, false);
attachResizer("right-resizer", "--right-w", 240, 760, true);

// ---------- Cmd +/-/0 缩放 ----------
// 只缩放三个布局容器：body 整体 zoom 会把 position:fixed 的菜单二次缩放，
// 导致右键菜单/主题菜单的渲染偏移与点击命中错位
const zoomTargets = ["sidebar", "main", "right"].map((id) => $(id));
let zoomLevel = 1;
function applyZoom() {
  for (const el of zoomTargets) el.style.zoom = zoomLevel;
}
// fixed 菜单坐标补偿：先设 zoom 再除回
function placeMenu(menu, visualLeft, visualTop) {
  menu.style.zoom = zoomLevel;
  menu.style.left = visualLeft / zoomLevel + "px";
  menu.style.top = visualTop / zoomLevel + "px";
}
document.addEventListener("keydown", (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "=" || e.key === "+") zoomLevel = Math.min(2, +(zoomLevel + 0.1).toFixed(2));
  else if (e.key === "-") zoomLevel = Math.max(0.6, +(zoomLevel - 0.1).toFixed(2));
  else if (e.key === "0") zoomLevel = 1;
  else return;
  e.preventDefault();
  applyZoom();
});

// ---------- 总渲染 ----------
function renderAll() {
  renderList();
  renderChat();
  renderComposerBar();
  renderRight();
}

renderAll();
connect();
