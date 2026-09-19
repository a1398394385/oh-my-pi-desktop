// omp desktop 前端：视觉与交互 1:1 仿照 prototype/session-view.html（kimi28 原型），
// 数据源换成本仓 WebSocket 宿主协议（host/host.ts）。
// 协议：命令 {create_session|load_session|list_sessions|prompt|get_messages|
//   set_approval_mode|approval_response|set_model|set_thinking|get_git_diff|
//   get_file_diff|get_settings|set_setting|set_desktop_env|get_models_catalog|
//   set_enabled_model|get_usage_stats|list_agent_assets}，事件见 onMessage。
const invoke = window.__TAURI__?.core?.invoke;

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
  if (statusEl) {
    statusEl.textContent = String(msg).slice(0, 80);
    statusEl.className = "bad";
  }
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
let hostSettings = null;
let modelCatalog = [];
let selectedProvider = null;
let agentAssets = null;
let usageStats = null;
let isCreatingNew = false;
let newSessionProject = "";
let newSessionBranch = "";
let newSessionBranches = [];
let newSessionIsGit = false;
let newSessionModel = "";
let newSessionThinking = "auto";
let pendingNewPrompt = "";

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function setConnected(ok, text) {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = ok ? "ok" : "bad";
  }
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
  if (!invoke) {
    setConnected(false, "无宿主");
    return;
  }
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
      ingestModels(msg.models);
      if (msg.settings) applyHostReadySettings(msg.settings);
      renderAll();
      break;
    case "models":
      ingestModels(msg.models);
      renderAll();
      break;
    case "models_catalog":
      modelCatalog = msg.models ?? [];
      renderModelPage();
      break;
    case "settings":
      applyHostSettings(msg.settings);
      if (msg.restartHint) toast("已保存，部分网络设置建议重启应用后完全生效");
      break;
    case "profile_switched":
      openSessions.clear();
      activePath = null;
      selectedSubagent = null;
      selectedFile = null;
      changesOpen = false;
      renderAll();
      toast(`已激活 Profile: ${msg.profile}`);
      break;
    case "usage_stats":
      usageStats = msg.stats;
      renderStatsPage();
      break;
    case "agent_assets":
      agentAssets = msg.assets;
      renderAssetPages();
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
      isCreatingNew = false;
      refreshGitDiff(); // changebar 需要 git status 数据
      hideWelcomeScreen();
      renderAll();
      if (pendingNewPrompt) {
        const text = pendingNewPrompt;
        pendingNewPrompt = "";
        const s = activeOpen();
        if (s) {
          s.items.push({ role: "user", text });
          renderAll();
          ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text }));
          streamEl.scrollTop = streamEl.scrollHeight;
        }
      }
      if (pendingCreate) {
        pendingCreate = false;
        send({ type: "list_sessions" }); // 新会话已落盘，重拉列表
      }
      break;
    }
    case "git_branches": {
      if (msg.cwd === newSessionProject) {
        newSessionIsGit = !!msg.isGit;
        newSessionBranch = msg.current || "";
        newSessionBranches = msg.branches || [];
        updateWelcomeGitUI();
      }
      break;
    }
    case "git_branch_switched": {
      if (msg.cwd === newSessionProject) {
        newSessionBranch = msg.branch;
        updateWelcomeGitUI();
        toast(`已切换分支到 ${msg.branch}`);
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
      } else if (msg.kind === "thinking") {
        if (s.assistantDraft) {
          s.items.push({ role: "assistant", text: s.assistantDraft });
          s.assistantDraft = "";
        }
        if (msg.phase === "start") {
          s.items.push({ role: "thinking", text: "思考" });
        } else {
          const last = [...s.items].reverse().find((it) => it.role === "thinking");
          if (last) {
            last.text = `思考 · ${msg.durationLabel || "持续了几秒"}`;
            last.thinking = msg.thinking || "";
            last.expandable = !!msg.expandable;
          }
        }
      } else if (msg.kind === "tool") {
        if (s.assistantDraft) {
          s.items.push({ role: "assistant", text: s.assistantDraft });
          s.assistantDraft = "";
        }
        s.items.push({
          role: "tool",
          text: msg.name,
          name: msg.name,
          toolCallId: msg.toolCallId,
          args: msg.args,
          files: msg.files,
        });
      } else if (msg.kind === "tool_update") {
        const last =
          [...s.items].reverse().find((it) => it.role === "tool" && it.toolCallId && it.toolCallId === msg.toolCallId) ||
          [...s.items].reverse().find((it) => it.role === "tool" && (it.name || it.text) === msg.name);
        if (last) {
          if (msg.files) last.files = uniqueFiles(msg.files);
          if (msg.added != null) last.added = msg.added;
          if (msg.removed != null) last.removed = msg.removed;
          if (msg.todo) last.todo = msg.todo;
        }
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
      s.items = msg.messages.map((m) => ({ ...m }));
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
      else if (msg.kind === "tool") sub.tools.push({ name: msg.name, args: msg.args, files: msg.files, toolCallId: msg.toolCallId });
      else if (msg.kind === "tool_update") {
        const last =
          [...sub.tools].reverse().find((t) => t.toolCallId && t.toolCallId === msg.toolCallId) ||
          [...sub.tools].reverse().find((t) => t.name === msg.name);
        if (last) Object.assign(last, { files: uniqueFiles(msg.files ?? last.files), added: msg.added, removed: msg.removed, todo: msg.todo });
      }
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
  if (!text || ws.readyState !== 1) return;

  if (isCreatingNew || !activeOpen()) {
    pendingNewPrompt = text;
    inputEl.value = "";
    resizeInput();
    updateSendReady();
    send({
      type: "create_session",
      cwd: newSessionProject || undefined,
      model: newSessionModel || undefined,
      thinking: newSessionThinking || undefined,
    });
    pendingCreate = true;
    return;
  }

  const s = activeOpen();
  if (!s) return;
  s.items.push({ role: "user", text });
  inputEl.value = "";
  resizeInput();
  updateSendReady();
  renderAll();
  ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text }));
  streamEl.scrollTop = streamEl.scrollHeight;
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
    if (typeof settingsOpen === "function" && settingsOpen()) return;
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
  modeBtn.classList.toggle("highlight-mode", meta.yolo);
  for (const mi of $("modeMenu").querySelectorAll(".mi[data-mode]")) {
    mi.querySelector(".ck").textContent = mi.dataset.mode === approvalMode ? "✓" : "";
  }
}
$("modeMenu").addEventListener("click", (e) => {
  const mi = e.target.closest(".mi[data-mode]");
  if (!mi) return;
  const mode = mi.dataset.mode;
  const s = activeOpen();
  if (s) {
    send({ type: "set_approval_mode", sessionId: s.sessionId, mode });
  } else {
    send({ type: "set_approval_mode", mode });
  }
  setApprovalModeUi(mode);
  closeAllMenus();
});

// ---------- 模型 / 思考级别（值域来自宿主下发） ----------
const modelNames = new Map(); // "provider/id" -> 显示名
const modelEfforts = new Map(); // "provider/id" -> 支持的思考档位
const THINKING_LABELS = { auto: "自动", off: "关", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };

function currentThinkingLevels() {
  const cur = activeOpen();
  const modelId = cur?.model || newSessionModel;
  const efforts = modelId ? modelEfforts.get(modelId) ?? [] : [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

function buildModelMenu() {
  const menu = $("modelMenu");
  menu.innerHTML = "";
  if (!modelNames || modelNames.size === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "mi empty";
    emptyEl.style.color = "var(--dim)";
    emptyEl.style.cursor = "default";
    emptyEl.style.justifyContent = "center";
    emptyEl.style.padding = "8px 12px";
    emptyEl.textContent = "未配置可用模型";
    menu.appendChild(emptyEl);
    return;
  }
  // 按 provider 分组（宿主下发 id 形如 "provider/modelId"）
  const groups = new Map();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov).push([id, name]);
  }
  const curModel = activeOpen()?.model || newSessionModel;
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
      ck.textContent = curModel === id ? "✓" : "";
      mi.appendChild(ck);
      mi.appendChild(document.createTextNode(name));
      menu.appendChild(mi);
    }
  }
}

function buildThinkMenu() {
  const menu = $("thinkMenu");
  menu.innerHTML = '<div class="mh">推理强度（随当前模型能力变化）</div>';
  const curThinking = activeOpen()?.thinking || newSessionThinking;
  for (const lv of currentThinkingLevels()) {
    const mi = document.createElement("div");
    mi.className = "mi";
    mi.dataset.level = lv;
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = curThinking === lv ? "✓" : "";
    mi.appendChild(ck);
    mi.appendChild(document.createTextNode(THINKING_LABELS[lv] ?? lv));
    menu.appendChild(mi);
  }
}

$("modelMenu").addEventListener("click", (e) => {
  const mi = e.target.closest(".mi[data-model]");
  if (!mi) return;
  const id = mi.dataset.model;
  const s = activeOpen();
  if (s) {
    send({ type: "set_model", sessionId: s.sessionId, model: id });
  } else {
    newSessionModel = id;
    try { localStorage.setItem("omp-new-model", id); } catch {}
    const validLevels = getSupportedThinkingForModel(id);
    if (!validLevels.includes(newSessionThinking)) {
      newSessionThinking = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
      try { localStorage.setItem("omp-new-thinking", newSessionThinking); } catch {}
    }
    renderComposerBar();
  }
  closeAllMenus();
});

$("thinkMenu").addEventListener("click", (e) => {
  const mi = e.target.closest(".mi[data-level]");
  if (!mi) return;
  const lv = mi.dataset.level;
  const s = activeOpen();
  if (s) {
    send({ type: "set_thinking", sessionId: s.sessionId, level: lv });
  } else {
    newSessionThinking = lv;
    try { localStorage.setItem("omp-new-thinking", lv); } catch {}
    renderComposerBar();
  }
  closeAllMenus();
});

// ---------- 新建会话页面（延展卡片 + 统一输入框组件挂载） ----------
function updateGreeting() {
  const h = new Date().getHours();
  let g = "下午好呀，接下来交给我吧";
  if (h >= 5 && h < 11) g = "早上好呀，接下来交给我吧";
  else if (h >= 11 && h < 14) g = "中午好呀，接下来交给我吧";
  else if (h >= 14 && h < 19) g = "下午好呀，接下来交给我吧";
  else g = "晚上好呀，接下来交给我吧";
  const el = $("welcomeTitle");
  if (el) el.textContent = g;
}

function setWelcomeProject(cwd) {
  if (!cwd) {
    cwd = diskProjects[0]?.cwd || "/";
  }
  newSessionProject = cwd;
  try {
    localStorage.setItem("omp-new-project", cwd);
  } catch {}
  const segs = cwd.split("/").filter(Boolean);
  const name = segs[segs.length - 1] || cwd;
  if ($("wbProjectName")) $("wbProjectName").textContent = name;
  if ($("wbProjectBtn")) $("wbProjectBtn").title = `项目目录: ${cwd}`;

  // 查 git 分支
  newSessionIsGit = false;
  newSessionBranch = "";
  newSessionBranches = [];
  updateWelcomeGitUI();
  send({ type: "get_git_branches", cwd });
}

function updateWelcomeGitUI() {
  const btn = $("wbBranchBtn");
  if (!btn) return;
  if (newSessionIsGit) {
    btn.classList.remove("hidden");
    $("wbBranchName").textContent = newSessionBranch || "main";
    btn.title = `Git 分支: ${newSessionBranch || "main"}`;
  } else {
    btn.classList.add("hidden");
  }
}

function getSupportedThinkingForModel(modelId) {
  const efforts = modelEfforts.get(modelId) ?? [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

function initNewSessionModel() {
  if (!newSessionModel || !modelNames.has(newSessionModel)) {
    const saved = localStorage.getItem("omp-new-model");
    if (saved && modelNames.has(saved)) {
      newSessionModel = saved;
    } else {
      const all = Array.from(modelNames.keys());
      const glm = all.find((id) => id.toLowerCase().includes("glm"));
      newSessionModel = glm || all[0] || "";
    }
  }
  const validLevels = getSupportedThinkingForModel(newSessionModel);
  let th = newSessionThinking || localStorage.getItem("omp-new-thinking") || "auto";
  if (!validLevels.includes(th)) {
    th = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
  }
  newSessionThinking = th;
}

function showWelcomeScreen(preferredCwd) {
  isCreatingNew = true;
  activePath = null;
  updateGreeting();

  $("stream")?.classList.add("hidden");
  $("changebar")?.classList.add("hidden");
  $("changesFiles")?.classList.remove("open");
  $("statusCard")?.classList.add("hidden");
  $("capsule")?.classList.add("hidden");
  document.querySelector(".dock")?.classList.add("hidden");

  // 将统一的输入框组件挂载到欢迎页延展卡片下方
  const composer = $("composer");
  const wbContainer = $("wbContainer");
  if (composer && wbContainer && !wbContainer.contains(composer)) {
    wbContainer.appendChild(composer);
  }
  composer?.classList.add("in-welcome");

  $("welcomeScreen")?.classList.remove("hidden");
  $("chatTitle").textContent = "新建任务";

  const targetProject = preferredCwd || newSessionProject || localStorage.getItem("omp-new-project") || (diskProjects[0]?.cwd);
  setWelcomeProject(targetProject);
  initNewSessionModel();
  setApprovalModeUi(approvalMode);
  renderComposerBar();

  if (inputEl) {
    inputEl.placeholder = "向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力";
    inputEl.value = "";
    resizeInput();
    updateSendReady();
    setTimeout(() => inputEl.focus(), 50);
  }
  closeAllMenus();
}

function hideWelcomeScreen() {
  isCreatingNew = false;
  $("welcomeScreen")?.classList.add("hidden");
  $("stream")?.classList.remove("hidden");

  // 将统一的输入框组件挂载回底部 dock
  const composer = $("composer");
  const dock = document.querySelector(".dock");
  if (composer && dock && !dock.contains(composer)) {
    dock.appendChild(composer);
  }
  composer?.classList.remove("in-welcome");
  dock?.classList.remove("hidden");

  if (inputEl) {
    inputEl.placeholder = "发消息…（Enter 发送）";
  }
}

// 绑定延展卡片中的项目与分支选择事件
$("wbProjectBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("wbProjectMenu");
  const backCard = document.querySelector(".wb-back-card");
  if (menu.classList.contains("open")) return closeAllMenus();
  closeAllMenus();
  backCard?.classList.add("menu-open");
  $("wbProjectBtn").classList.add("active");
  menu.style.left = $("wbProjectBtn").offsetLeft + "px";
  menu.style.top = ($("wbProjectBtn").offsetTop + $("wbProjectBtn").offsetHeight + 4) + "px";
  menu.innerHTML = "";
  for (const p of diskProjects) {
    const mi = document.createElement("div");
    mi.className = "mi";
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = p.cwd === newSessionProject ? "✓" : "";
    const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
    mi.append(ck, document.createTextNode(name));
    mi.title = p.cwd;
    mi.onclick = () => {
      setWelcomeProject(p.cwd);
      closeAllMenus();
    };
    menu.appendChild(mi);
  }
  menu.classList.add("open");
});

$("wbBranchBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("wbBranchMenu");
  const backCard = document.querySelector(".wb-back-card");
  if (menu.classList.contains("open")) return closeAllMenus();
  closeAllMenus();
  backCard?.classList.add("menu-open");
  $("wbBranchBtn").classList.add("active");
  menu.style.left = $("wbBranchBtn").offsetLeft + "px";
  menu.style.top = ($("wbBranchBtn").offsetTop + $("wbBranchBtn").offsetHeight + 4) + "px";
  menu.innerHTML = "";
  for (const b of newSessionBranches) {
    const mi = document.createElement("div");
    mi.className = "mi";
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = b === newSessionBranch ? "✓" : "";
    mi.append(ck, document.createTextNode(b));
    mi.onclick = () => {
      if (b !== newSessionBranch) {
        send({ type: "switch_git_branch", cwd: newSessionProject, branch: b });
      }
      closeAllMenus();
    };
    menu.appendChild(mi);
  }
  menu.classList.add("open");
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
  placeMenu(ringPop, Math.min(r.left, window.innerWidth - 280), r.top - ringPop.offsetHeight - 8);
}

// 明细数据到达：鼠标仍悬停在环上才填充（移开即弃）
function fillCtxCard(detail) {
  if (!ringHovering || !ringPop) return;
  const r = $("ctxRing").getBoundingClientRect();
  ringPop.replaceWith((ringPop = buildCtxCard(detail)));
  placeMenu(ringPop, Math.min(r.left, window.innerWidth - 280), r.top - ringPop.offsetHeight - 8);
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
  document.querySelector(".wb-back-card")?.classList.remove("menu-open");
  $("wbProjectBtn")?.classList.remove("active");
  $("wbBranchBtn")?.classList.remove("active");
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
  if (!activeOpen() && !isCreatingNew) return;
  const menu = $("modelMenu");
  if (menu.classList.contains("open")) return closeAllMenus();
  buildModelMenu();
  openComposerMenu(menu, modelBtn);
});
thinkBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!activeOpen() && !isCreatingNew) return;
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
    isCreatingNew = false;
    hideWelcomeScreen();
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
        showWelcomeScreen(p.cwd);
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
$("navNew").addEventListener("click", () => showWelcomeScreen(activeOpen()?.cwd));

// ⌘N 新建任务
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    if (typeof settingsOpen === "function" && settingsOpen()) return;
    showWelcomeScreen(activeOpen()?.cwd);
  }
});

// ⌘B 切换左侧边栏
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    setSidebarCollapsed(!isSidebarCollapsed());
  }
});

// ---------- 动作行 SVG（1:1 取自 prototype/session-view.html） ----------
const SVG_TERM =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.2" y="1.8" width="10.6" height="9.4" rx="1.6"/><path d="M3.8 4.8 6 6.5 3.8 8.2"/><path d="M7 8.2h2.4"/></svg>';
const SVG_THINK =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1"><ellipse cx="6.5" cy="6.5" rx="5" ry="2.1"/><ellipse cx="6.5" cy="6.5" rx="5" ry="2.1" transform="rotate(60 6.5 6.5)"/><ellipse cx="6.5" cy="6.5" rx="5" ry="2.1" transform="rotate(120 6.5 6.5)"/><circle cx="6.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>';
const SVG_PENCIL =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.8 2.2 9.8 4.2 4.4 9.6 2 10l.4-2.4z"/><path d="M6.8 3.2l2 2"/></svg>';
const SVG_TODO =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.5 3.5h8M2.5 6.5h8M2.5 9.5h8"/></svg>';
const SVG_READ =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="5.8" cy="5.8" r="3.6"/><path d="m8.6 8.6 2.6 2.6"/></svg>';
const SVG_DOWN =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
const SVG_HTML =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#e8622d" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3 1 6l2.5 3M8.5 3 11 6l-2.5 3"/></svg>';
const SVG_CSS =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#a86fe0" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 2.5v7M7.5 2.5v7M3 4.5h6M3 7.5h6"/></svg>';
const SVG_JS =
  '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2" fill="#f0db4f"/><text x="6" y="8.4" font-size="5.2" text-anchor="middle" fill="#323330" font-family="Menlo,monospace" font-weight="700">JS</text></svg>';
const SVG_IMG =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#5fb3b3" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="1.2" y="1.8" width="9.6" height="8.4" rx="1.4"/><circle cx="4.2" cy="4.6" r=".9" fill="#5fb3b3" stroke="none"/><path d="M2.4 9.2 5 6.6l1.8 1.8 2-2 1.6 1.4"/></svg>';
const SVG_FILE =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 1.6h3.4L9 4v6.4H3.2z"/><path d="M6.6 1.6V4H9"/></svg>';

function uniqueFiles(files) {
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
  if (ext === "html" || ext === "htm") return SVG_HTML;
  if (ext === "css") return SVG_CSS;
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "tsx") return SVG_JS;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return SVG_IMG;
  return SVG_FILE;
}
function splitPath(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) };
}
function fillInlineCode(el, text) {
  const parts = String(text || "").split(/(`[^`]+`)/);
  for (const p of parts) {
    if (p.length > 2 && p.startsWith("`") && p.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = p.slice(1, -1);
      el.appendChild(code);
    } else if (p) el.appendChild(document.createTextNode(p));
  }
}
function fileChip(path) {
  const { name } = splitPath(path);
  const span = document.createElement("span");
  span.className = "f-ic";
  span.insertAdjacentHTML("beforeend", fileTypeIcon(name || path));
  span.appendChild(document.createTextNode(name || path));
  span.title = path;
  return span;
}

function renderCmd(command) {
  const div = document.createElement("div");
  div.className = "cmd";
  const ic = document.createElement("span");
  ic.className = "c-ic";
  ic.innerHTML = SVG_TERM + "终端";
  const tx = document.createElement("span");
  tx.className = "c-tx";
  tx.textContent = command || "";
  tx.title = command || "";
  div.append(ic, tx);
  return div;
}
function renderThink(item) {
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "act think";
  const ic = document.createElement("span");
  ic.className = "th-ic";
  ic.innerHTML = SVG_THINK;
  div.append(ic, document.createTextNode(item.text || "思考 · 持续了几秒"));
  if (item.expandable || item.thinking) {
    const more = document.createElement("span");
    more.className = "th-more";
    more.textContent = item.expanded ? "⌄" : "›";
    div.appendChild(more);
    div.style.cursor = "pointer";
    div.onclick = () => {
      item.expanded = !item.expanded;
      renderChat();
    };
  }
  wrap.appendChild(div);
  if (item.expanded && item.thinking) {
    const body = document.createElement("div");
    body.className = "think-body";
    body.textContent = item.thinking;
    wrap.appendChild(body);
  }
  return wrap;
}
function renderEdit(item) {
  const files = uniqueFiles(item.files?.length ? item.files : item.args?.files || (item.args?.path ? [item.args.path] : []));
  const path = files[0] || "";
  const { dir, name } = splitPath(path);
  const div = document.createElement("div");
  div.className = "act edit";
  div.insertAdjacentHTML("beforeend", SVG_PENCIL);
  div.appendChild(document.createTextNode("编辑 "));
  if (path) {
    div.appendChild(fileChip(path));
    div.appendChild(document.createTextNode(" "));
    if (dir) {
      const p = document.createElement("span");
      p.className = "path";
      p.textContent = dir;
      p.title = path;
      div.appendChild(p);
    }
  } else {
    div.appendChild(document.createTextNode(item.name || item.text || ""));
  }
  if (item.added > 0) {
    const add = document.createElement("span");
    add.className = "add";
    add.textContent = `+${item.added}`;
    div.appendChild(document.createTextNode(" "));
    div.appendChild(add);
  }
  if (item.removed > 0) {
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = `−${item.removed}`;
    div.appendChild(document.createTextNode(" "));
    div.appendChild(del);
  }
  return div;
}
function renderChange(item) {
  const files = uniqueFiles(item.files?.length ? item.files : item.args?.files || []);
  const div = document.createElement("div");
  div.className = "act change";
  div.insertAdjacentHTML("beforeend", SVG_PENCIL);
  div.appendChild(document.createTextNode(`更改 · ${files.length || "多"} 个文件`));
  if (files.length) {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "·";
    div.appendChild(document.createTextNode(" "));
    div.appendChild(sep);
    div.appendChild(document.createTextNode(" "));
    for (const f of files) {
      div.appendChild(fileChip(f));
      div.appendChild(document.createTextNode(" "));
    }
  }
  return div;
}
function renderTodo(item) {
  const td = item.todo;
  const content = td?.content || item.args?.task || item.args?.i || item.text || "";
  const div = document.createElement("div");
  div.className = "act todo";
  div.insertAdjacentHTML("beforeend", SVG_TODO);
  div.appendChild(document.createTextNode("待办 "));
  const tx = document.createElement("span");
  tx.className = "td-tx";
  tx.textContent = content;
  tx.title = content;
  div.appendChild(tx);
  if (td && td.total > 0) {
    const n = document.createElement("span");
    n.className = "td-n";
    n.textContent = `${td.done}/${td.total}`;
    div.appendChild(n);
  }
  return div;
}
function renderRead(item) {
  const path = uniqueFiles(item.files?.length ? item.files : item.args?.path ? [item.args.path] : [])[0] || "";
  const { dir, name } = splitPath(path);
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", SVG_READ);
  div.appendChild(document.createTextNode("读取 "));
  if (path) {
    div.appendChild(fileChip(path));
    div.appendChild(document.createTextNode(" "));
    if (dir) {
      const p = document.createElement("span");
      p.className = "path";
      p.textContent = dir;
      p.title = path;
      div.appendChild(p);
    }
  } else {
    div.appendChild(document.createTextNode(item.text || "read"));
  }
  return div;
}
function renderGenericTool(item) {
  const div = document.createElement("div");
  div.className = "act";
  div.textContent = item.name || item.text || "";
  return div;
}
function toolKind(item) {
  const name = item.name || item.text || "";
  if (item.role === "thinking" || name === "thinking") return "think";
  if (name === "bash" || name === "shell") return "cmd";
  if (name === "todo") return "todo";
  if (name === "read") return "read";
  if (name === "edit" || name === "write" || name === "apply_patch") {
    const n = uniqueFiles(item.files || item.args?.files || (item.args?.path ? [item.args.path] : [])).length;
    return n > 1 ? "change" : "edit";
  }
  return "generic";
}
function renderToolItem(item) {
  switch (toolKind(item)) {
    case "think":
      return renderThink(item);
    case "cmd":
      return renderCmd(item.args?.command || item.text || "");
    case "todo":
      return renderTodo(item);
    case "read":
      return renderRead(item);
    case "change":
      return renderChange(item);
    case "edit":
      return renderEdit(item);
    default:
      return renderGenericTool(item);
  }
}
function renderStepTitle(text) {
  const div = document.createElement("div");
  div.className = "step-title";
  fillInlineCode(div, text);
  return div;
}

// ---------- Markdown 渲染引擎与代码复制 ----------
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(escapedText) {
  const codeSegments = [];
  let s = escapedText.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeSegments.length;
    codeSegments.push(`<code class="md-inline-code">${code}</code>`);
    return `\x01INLINECODE${idx}\x01`;
  });

  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|file:\/\/[^\s)]+|[^\s)]+)\)/g, (_, title, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${title}</a>`;
  });

  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?:^|(?<=[\s\p{P}]))__([^_]+)__(?=$|[\s\p{P}])/gu, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/(?:^|(?<=[\s\p{P}]))_([^_]+)_(?=$|[\s\p{P}])/gu, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  s = s.replace(/\x01INLINECODE(\d+)\x01/g, (_, i) => codeSegments[Number(i)] || "");
  return s;
}

function renderMarkdownToHtml(md) {
  if (!md) return "";
  const codeBlocks = [];

  // 1. 提取并保护所有代码块（含流式未闭合代码块）
  let text = String(md).replace(/\r\n/g, "\n");
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const l = lang ? lang.trim() : "";
    const cleanCode = code.endsWith("\n") ? code.slice(0, -1) : code;
    codeBlocks.push(
      `<div class="md-code-block">` +
        `<div class="md-code-head">` +
          `<span class="md-code-lang">${escapeHtml(l || "text")}</span>` +
          `<button class="md-copy-btn" onclick="copyCodeBlock(this)">复制</button>` +
        `</div>` +
        `<pre><code>${escapeHtml(cleanCode)}</code></pre>` +
      `</div>`
    );
    return `\n\n\x02MDCODEBLOCK${idx}\x02\n\n`;
  });

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块占位符
    const cbMatch = trimmed.match(/^\x02MDCODEBLOCK(\d+)\x02$/);
    if (cbMatch) {
      out.push(codeBlocks[Number(cbMatch[1])]);
      i++;
      continue;
    }

    // 标题 (# ~ ####)
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${renderInline(escapeHtml(hMatch[2]))}</h${level}>`);
      i++;
      continue;
    }

    // 水平分割线
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      out.push(`<hr class="md-hr">`);
      i++;
      continue;
    }

    // 引用块 (> ...)
    if (trimmed.startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${quoteLines.map((l) => renderInline(escapeHtml(l))).join("<br>")}</blockquote>`);
      continue;
    }

    // 表格 (| a | b |)
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && i + 1 < lines.length && /^\|?\s*:?-+:?\s*\|/.test(lines[i + 1].trim())) {
      const headerRow = trimmed;
      const sepRow = lines[i + 1].trim();
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        rows.push(lines[i].trim());
        i++;
      }
      const parseCells = (rowStr) =>
        rowStr
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());

      const headers = parseCells(headerRow);
      let tableHtml = `<div class="md-table-wrap"><table class="md-table"><thead><tr>`;
      for (const h of headers) {
        tableHtml += `<th>${renderInline(escapeHtml(h))}</th>`;
      }
      tableHtml += `</tr></thead><tbody>`;
      for (const r of rows) {
        tableHtml += `<tr>`;
        const cells = parseCells(r);
        for (let c = 0; c < headers.length; c++) {
          tableHtml += `<td>${renderInline(escapeHtml(cells[c] ?? ""))}</td>`;
        }
        tableHtml += `</tr>`;
      }
      tableHtml += `</tbody></table></div>`;
      out.push(tableHtml);
      continue;
    }

    // 无序列表与任务列表 (- item, * item)
    if (/^[-*+]\s+/.test(trimmed)) {
      out.push(`<ul class="md-ul">`);
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        let rawItem = lines[i].trim().replace(/^[-*+]\s+/, "");
        let itemHtml = "";
        if (/^\[ \]\s+/.test(rawItem)) {
          itemHtml = `<input type="checkbox" disabled class="md-task-cb"> ` + renderInline(escapeHtml(rawItem.slice(4)));
        } else if (/^\[[xX]\]\s+/.test(rawItem)) {
          itemHtml = `<input type="checkbox" checked disabled class="md-task-cb"> ` + renderInline(escapeHtml(rawItem.slice(4)));
        } else {
          itemHtml = renderInline(escapeHtml(rawItem));
        }
        out.push(`<li>${itemHtml}</li>`);
        i++;
      }
      out.push(`</ul>`);
      continue;
    }

    // 有序列表 (1. item)
    if (/^\d+\.\s+/.test(trimmed)) {
      out.push(`<ol class="md-ol">`);
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const rawItem = lines[i].trim().replace(/^\d+\.\s+/, "");
        out.push(`<li>${renderInline(escapeHtml(rawItem))}</li>`);
        i++;
      }
      out.push(`</ol>`);
      continue;
    }

    // 普通段落
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("\x02MDCODEBLOCK") &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^(?:---|\*\*\*|___)\s*$/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith(">") &&
      !lines[i].trim().startsWith("|") &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    if (paraLines.length > 0) {
      out.push(`<p class="md-p">${paraLines.map((l) => renderInline(escapeHtml(l))).join("<br>")}</p>`);
    }
  }

  return out.join("");
}

function copyCodeBlock(btn) {
  const codeEl = btn.closest(".md-code-block")?.querySelector("code");
  if (!codeEl) return;
  const text = codeEl.textContent || "";
  const finish = () => {
    btn.textContent = "已复制";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "复制";
      btn.classList.remove("copied");
    }, 2000);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(finish).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      finish();
    });
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    finish();
  }
}
window.copyCodeBlock = copyCodeBlock;

function renderAssistantMessage(text) {
  const div = document.createElement("div");
  div.className = "msg assistant md-body";
  const html = renderMarkdownToHtml(text || "");
  if (!html) div.style.display = "none";
  else div.innerHTML = html;
  return div;
}



function ensureScrollBottom() {
  let btn = $("scrollBottom");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "scrollBottom";
    btn.className = "scroll-bottom";
    btn.type = "button";
    btn.title = "滚动到底部";
    btn.innerHTML = SVG_DOWN;
    btn.addEventListener("click", () => {
      streamEl.scrollTop = streamEl.scrollHeight;
    });
  }
  if (btn !== streamEl.lastElementChild) streamEl.appendChild(btn);
}
new MutationObserver(() => {
  const btn = $("scrollBottom");
  if (btn && streamEl.contains(btn) && btn !== streamEl.lastElementChild) streamEl.appendChild(btn);
}).observe(streamEl, { childList: true });

// ---------- 中栏：标题 + 文件更改条 + 消息流 ----------
function renderChat() {
  const s = activeOpen();
  if (!s || isCreatingNew) {
    showWelcomeScreen(activeOpen()?.cwd);
    return;
  }
  hideWelcomeScreen();
  let chatTitle = "选择左侧会话或新建任务";
  const entry = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === activePath);
  chatTitle = entry ? sessionLabel(entry) : s.cwd.split("/").filter(Boolean).pop() || s.cwd;
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
  const prevTop = streamEl.scrollTop;
  const stickBottom = streamEl.scrollHeight - prevTop - streamEl.clientHeight < 120;
  streamEl.innerHTML = "";
  if (!s) {
    streamEl.innerHTML = '<div class="placeholder">点左侧任务或「新建任务」开始</div>';
    ensureScrollBottom();
    return;
  }
  for (const item of s.items) {
    if (item.role === "user") {
      const div = document.createElement("div");
      div.className = "msg user";
      const bubble = document.createElement("div");
      bubble.className = "user-bubble";
      bubble.textContent = item.text;
      div.appendChild(bubble);
      streamEl.appendChild(div);
    } else if (item.role === "assistant") {
      streamEl.appendChild(renderAssistantMessage(item.text));
    } else if (item.role === "thinking") {
      if (uiPrefs.showThinking) streamEl.appendChild(renderThink(item));
    } else if (item.role === "tool") {
      streamEl.appendChild(renderToolItem(item));
    } else if (item.role === "meta") {
      const div = document.createElement("div");
      div.className = "act";
      div.textContent = item.text;
      streamEl.appendChild(div);
    } else if (item.role === "approval") {
      const div = document.createElement("div");
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
      streamEl.appendChild(div);
    } else {
      const div = document.createElement("div");
      div.className = "act err";
      div.textContent = `✗ ${item.text}`;
      streamEl.appendChild(div);
    }
  }
  if (s.streaming || s.assistantDraft) {
    const act = document.createElement("div");
    act.className = "act t2";
    const elapsed = s.turnStartAt ? Math.floor((Date.now() - s.turnStartAt) / 1000) : 0;
    act.innerHTML = `工作中 <span id="workSec">${elapsed}</span> 秒`;
    streamEl.appendChild(act);
  }
  if (s.assistantDraft) {
    const d = renderAssistantMessage(s.assistantDraft);
    d.classList.add("streaming-draft");
    streamEl.appendChild(d);
  }
  const spin = document.createElement("span");
  spin.id = "mainSpin";
  spin.className = s.streaming ? "spin on" : "spin hidden";
  spin.textContent = "✳";
  streamEl.appendChild(spin);
  ensureScrollBottom();
  if (stickBottom) streamEl.scrollTop = streamEl.scrollHeight;
  else streamEl.scrollTop = prevTop;
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
  if (!s && isCreatingNew) {
    modelBtn.disabled = thinkBtn.disabled = false;
    const mName = modelNames.get(newSessionModel) ?? (newSessionModel ? newSessionModel.split("/").pop() : "模型");
    $("modelLabel").textContent = mName;
    $("thinkLabel").textContent = THINKING_LABELS[newSessionThinking] ?? (newSessionThinking === "max" || newSessionThinking === "high" ? "最高" : newSessionThinking);
    $("ctxRing").hidden = true;
    return;
  }
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

$("statusCard").addEventListener("click", (e) => {
  if (e.target.closest("#agentsRow")) return;
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
      stream.appendChild(renderToolItem({ role: "tool", text: t.name, ...t }));
    }
    if (sub.text || sub.streaming) {
      const d = renderStepTitle(sub.text || "…");
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

// ---------- 左右侧边栏折叠 ----------
function isSidebarCollapsed() {
  return $("sidebar").classList.contains("collapsed");
}
function setSidebarCollapsed(off) {
  $("sidebar").classList.toggle("collapsed", off);
  const btn = $("sidebarToggle");
  if (btn) {
    btn.classList.toggle("on", !off);
    btn.title = off ? "展开侧边栏 (⌘B)" : "收起侧边栏 (⌘B)";
  }
  try {
    localStorage.setItem("omp-sidebar-collapsed", off ? "1" : "0");
  } catch {}
}
$("sidebarToggle")?.addEventListener("click", () => {
  setSidebarCollapsed(!isSidebarCollapsed());
});
try {
  if (localStorage.getItem("omp-sidebar-collapsed") === "1") {
    setSidebarCollapsed(true);
  }
} catch {}

function isRightCollapsed() {
  return $("right").classList.contains("collapsed");
}
function setRightCollapsed(off) {
  $("right").classList.toggle("collapsed", off);
  $("panelToggle").classList.toggle("on", !off);
  $("panelToggle").title = off ? "展开侧边面板" : "收起侧边面板";
  if (!off) {
    todoCollapsed = true;
    renderStatusCard();
  }
}
$("panelToggle").addEventListener("click", () => {
  setRightCollapsed(!isRightCollapsed());
});
function expandRightPanel() {
  setRightCollapsed(false);
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
themeMq.addEventListener("change", () => {
  if (themeMode === "system") applyTheme("system");
});

let themeMenu = null;
function closeThemeMenu() {
  themeMenu?.remove();
  themeMenu = null;
}
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
      const dx = (ev.clientX - startX) / zoomLevel;
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
attachResizer("left-resizer", "--left-w", 180, false);
attachResizer("right-resizer", "--right-w", 200, true);

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

// ---------- 设置中心 ----------
const UI_PREF_KEY = "omp-ui-settings";
const FONT_LABELS = {
  default: "系统默认",
  pingfang: "苹方 / PingFang SC",
  songti: "宋体 / Songti SC",
  kaiti: "楷体 / KaiTi SC",
  heiti: "黑体 / Heiti SC",
  mono: "等宽",
};
const FONT_STACKS = {
  default: "var(--sans)",
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const PROV_IC = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };
const STAT_COLORS = ["#4a9eff", "#34c759", "#a86fe0", "#e05c5c", "#e5a14e", "#4ec9b0"];

function loadUiPrefs() {
  const d = { uiFont: "default", uiFontSize: 13, codeFontSize: 12, lineNumbers: true, codeWrap: false, showThinking: true, lang: "zh-CN" };
  try {
    Object.assign(d, JSON.parse(localStorage.getItem(UI_PREF_KEY) || "{}"));
  } catch {}
  return d;
}
const uiPrefs = loadUiPrefs();
function saveUiPrefs() {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(uiPrefs));
  } catch {}
}
function applyAppearance() {
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", uiPrefs.uiFontSize + "px");
  root.style.setProperty("--code-fs", uiPrefs.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[uiPrefs.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = uiPrefs.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  root.dataset.showThinking = uiPrefs.showThinking ? "on" : "off";
}
function ingestModels(models) {
  modelNames.clear();
  modelEfforts.clear();
  for (const m of models ?? []) {
    modelNames.set(m.id, m.name);
    modelEfforts.set(m.id, m.efforts ?? []);
  }
  if (typeof setWelcomeModel === "function") setWelcomeModel();
}
function setTg(el, on) {
  if (el) el.classList.toggle("on", !!on);
}
function applyHostSettings(s) {
  if (!s) return;
  hostSettings = s;
  const active = document.activeElement;
  const env = hostSettings.desktopEnv || {};
  const fill = (id, val) => {
    const el = $(id);
    if (!el || active === el) return;
    el.value = val || "";
  };
  fill("proxyInput", env.httpProxy);
  fill("noProxyInput", env.noProxy);
  fill("caInput", env.caCerts);
  setTg($("tgSleep"), hostSettings.sleepPrevention && hostSettings.sleepPrevention !== "off");
  setTg($("tgComputer"), hostSettings.computerEnabled);
  setTg($("tgMemory"), hostSettings.memoryBackend && hostSettings.memoryBackend !== "off");
  if (hostSettings.activeProfile) {
    renderProfileSelector(hostSettings.activeProfile, hostSettings.availableProfiles, hostSettings.profileAgentDir);
  }
}
function renderProfileSelector(activeProfile, profiles, profileAgentDir) {
  if (!activeProfile) return;
  const footEl = $("setFootProfile");
  if (footEl) footEl.textContent = activeProfile;
  const pathDesc = $("profilePathDesc");
  if (pathDesc && profileAgentDir) {
    pathDesc.textContent = `当前目录: ${profileAgentDir}`;
  }
  const sel = $("profileSel");
  if (sel) {
    for (const n of sel.childNodes) {
      if (n.nodeType === 3) {
        n.textContent = activeProfile + " ";
        break;
      }
    }
  }
  const menu = $("profileMenu");
  if (menu && Array.isArray(profiles)) {
    menu.replaceChildren();
    for (const p of profiles) {
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.profile = p;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = p === activeProfile ? "✓" : "";
      mi.appendChild(ck);
      mi.appendChild(document.createTextNode(p === "default" ? "default (全局默认)" : p));
      menu.appendChild(mi);
    }
  }
}
function switchProfile(name) {
  const target = String(name || "").trim();
  if (!target) return;
  toast(`正在切换至 Profile: ${target}…`);
  openSessions.clear();
  activePath = null;
  selectedSubagent = null;
  selectedFile = null;
  changesOpen = false;
  renderAll();
  send({ type: "switch_profile", profile: target });
}
function applyHostReadySettings(s) {
  applyHostSettings(s);
  if (!s) return;
  uiPrefs.showThinking = !s.hideThinkingBlock;
  saveUiPrefs();
  applyAppearance();
  syncSettingsControls();
}
function syncSettingsControls() {
  if ($("uiFsVal")) $("uiFsVal").innerHTML = uiPrefs.uiFontSize + " <i>px</i>";
  if ($("codeFsVal")) $("codeFsVal").innerHTML = uiPrefs.codeFontSize + " <i>px</i>";
  setTg($("tgLineNo"), uiPrefs.lineNumbers);
  setTg($("tgWrap"), uiPrefs.codeWrap);
  setTg($("tgThinking"), uiPrefs.showThinking);
  const fontSel = $("fontSel");
  if (fontSel) {
    for (const n of fontSel.childNodes) {
      if (n.nodeType === 3) {
        n.textContent = (FONT_LABELS[uiPrefs.uiFont] || "系统默认") + " ";
        break;
      }
    }
    for (const mi of $("fontMenu").querySelectorAll(".mi")) {
      const ck = mi.querySelector(".ck");
      if (ck) ck.textContent = mi.dataset.font === uiPrefs.uiFont ? "✓" : "";
    }
  }
  if (!hostSettings) return;
  setTg($("tgSleep"), hostSettings.sleepPrevention && hostSettings.sleepPrevention !== "off");
  setTg($("tgComputer"), hostSettings.computerEnabled);
  setTg($("tgMemory"), hostSettings.memoryBackend && hostSettings.memoryBackend !== "off");
  const env = hostSettings.desktopEnv || {};
  if ($("proxyInput")) $("proxyInput").value = env.httpProxy || "";
  if ($("noProxyInput")) $("noProxyInput").value = env.noProxy || "";
  if ($("caInput")) $("caInput").value = env.caCerts || "";
}
function settingsOpen() {
  return !$("settings").classList.contains("hidden");
}
function openSettings(pageId) {
  closeAllMenus();
  inputEl.blur();
  $("settings").classList.remove("hidden");
  switchSetPage(pageId || "pg-general");
  send({ type: "get_settings" });
  send({ type: "get_models_catalog" });
  send({ type: "list_agent_assets" });
  send({ type: "get_usage_stats" });
}
function closeSettings() {
  closeAllMenus();
  $("settings").classList.add("hidden");
}
function switchSetPage(id) {
  for (const x of document.querySelectorAll(".set-item")) x.classList.toggle("on", x.dataset.page === id);
  for (const p of document.querySelectorAll(".set-page")) p.classList.toggle("hidden", p.id !== id);
  $("setBody").scrollTop = 0;
}
function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "srow";
  const tx = document.createElement("div");
  tx.className = "srow-tx";
  const span = document.createElement("span");
  span.textContent = text;
  tx.appendChild(span);
  row.appendChild(tx);
  return row;
}
function fillAssetList(id, items, write) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren();
  if (!items.length) {
    el.appendChild(emptyRow("暂无"));
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "srow";
    const tx = document.createElement("div");
    tx.className = "srow-tx";
    write(tx, item);
    row.appendChild(tx);
    el.appendChild(row);
  }
}
function assetTitle(parent, title, sub) {
  const b = document.createElement("b");
  b.textContent = title;
  parent.appendChild(b);
  if (sub) {
    const span = document.createElement("span");
    span.textContent = sub;
    parent.appendChild(span);
  }
}
function renderAssetPages() {
  const a = agentAssets;
  if (!a) return;
  fillAssetList("memoryList", a.memories, (tx, m) => assetTitle(tx, m.name, m.path));
  fillAssetList("skillsList", a.skills, (tx, m) => assetTitle(tx, m.name, m.description || m.path));
  fillAssetList("commandsList", a.commands, (tx, m) => assetTitle(tx, "/" + m.name, m.path));
  fillAssetList("hooksList", a.hooks, (tx, m) => assetTitle(tx, m.name, (m.phase || "") + " · " + m.path));
  fillAssetList("agentsList", a.agents, (tx, m) => assetTitle(tx, m.name, m.description || m.path));
  fillAssetList("mcpList", a.mcp, (tx, m) => assetTitle(tx, m.name, m.command || "未配置命令"));
}
function renderModelPage() {
  const list = $("mpList");
  const detail = $("mpDetail");
  if (!list || !detail) return;
  const groups = new Map();
  for (const m of modelCatalog) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  if (!selectedProvider || !groups.has(selectedProvider)) selectedProvider = groups.keys().next().value ?? null;
  list.innerHTML = "";
  const pipe = document.createElement("div");
  pipe.className = "set-sec";
  pipe.style.padding = "4px 10px 6px";
  pipe.textContent = "已认证供应商";
  list.appendChild(pipe);
  if (!groups.size) {
    const empty = document.createElement("div");
    empty.className = "pv";
    empty.textContent = "暂无可用模型";
    list.appendChild(empty);
    const hint = document.createElement("div");
    hint.className = "set-group-desc";
    hint.textContent = "宿主未连接或没有已认证模型。";
    detail.replaceChildren(hint);
    return;
  }
  for (const [prov, models] of groups) {
    const row = document.createElement("div");
    row.className = "pv" + (prov === selectedProvider ? " on" : "");
    const ic = document.createElement("span");
    ic.className = "pv-ic";
    ic.textContent = PROV_IC[prov] || "✦";
    row.appendChild(ic);
    row.appendChild(document.createTextNode(prov));
    if (models.some((m) => m.enabled)) {
      const dot = document.createElement("span");
      dot.className = "dot";
      row.appendChild(dot);
    }
    row.onclick = () => {
      selectedProvider = prov;
      renderModelPage();
    };
    list.appendChild(row);
  }
  const models = groups.get(selectedProvider) || [];
  const anyOn = models.some((m) => m.enabled);
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const hb = document.createElement("b");
  hb.textContent = (PROV_IC[selectedProvider] || "✦") + " " + selectedProvider;
  const sp = document.createElement("span");
  sp.className = "sp";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = models.length + " 个模型";
  head.append(hb, sp, tag);
  detail.appendChild(head);
  const note = document.createElement("div");
  note.className = "set-group-desc";
  note.textContent = "开关写入 omp enabledModels。没有套餐额度、升级或解绑——那些是 ZCode 商业能力。";
  detail.appendChild(note);
  const ml = document.createElement("div");
  ml.className = "mp-ml";
  ml.innerHTML = "<span>模型列表</span>";
  detail.appendChild(ml);
  for (const m of models) {
    const row = document.createElement("div");
    row.className = "mp-row";
    const name = document.createElement("span");
    name.textContent = m.name;
    row.appendChild(name);
    if (m.context) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = m.context >= 1000000 ? m.context / 1000000 + "M" : m.context >= 1000 ? Math.round(m.context / 1000) + "k" : String(m.context);
      row.appendChild(t);
    }
    if (m.vision) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = "视觉";
      row.appendChild(t);
    }
    const sp2 = document.createElement("span");
    sp2.className = "sp";
    row.appendChild(sp2);
    const tg = document.createElement("div");
    tg.className = "tg" + (m.enabled ? " on" : "");
    tg.innerHTML = "<i></i>";
    tg.onclick = () => {
      if (m.enabled && modelCatalog.filter((x) => x.enabled).length <= 1) {
        toast("至少保留一个启用模型");
        return;
      }
      send({ type: "set_enabled_model", id: m.id, enabled: !m.enabled });
    };
    row.appendChild(tg);
    detail.appendChild(row);
  }
  if (!anyOn) {
    const hint = document.createElement("div");
    hint.className = "set-group-desc";
    hint.style.marginTop = "8px";
    hint.textContent = "该供应商下暂无启用模型。";
    detail.appendChild(hint);
  }
}
function fmtCompactTokens(n) {
  if (n == null || n <= 0) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
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
function renderStatsPage() {
  const st = usageStats;
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

function wireSel(selId, onPick) {
  const sel = $(selId);
  if (!sel) return;
  const menu = sel.querySelector(".menu");
  sel.addEventListener("click", (e) => {
    e.stopPropagation();
    const was = menu.classList.contains("open");
    closeAllMenus();
    if (!was) menu.classList.add("open");
  });
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    const mi = e.target.closest(".mi");
    if (!mi || mi.classList.contains("disabled")) return;
    onPick(mi);
    closeAllMenus();
  });
}
function wireToggle(id, apply) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    apply(!el.classList.contains("on"));
  });
}
function stepFont(key, delta, min, max, labelId) {
  uiPrefs[key] = Math.min(max, Math.max(min, uiPrefs[key] + delta));
  saveUiPrefs();
  applyAppearance();
  $(labelId).innerHTML = uiPrefs[key] + " <i>px</i>";
}

$("settingsBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  openSettings();
});
$("setBack").addEventListener("click", closeSettings);
$("setNav").addEventListener("click", (e) => {
  const it = e.target.closest(".set-item");
  if (!it) return;
  closeAllMenus();
  switchSetPage(it.dataset.page);
});
wireSel("profileSel", (mi) => {
  const target = mi.dataset.profile;
  if (target && target !== hostSettings?.activeProfile) {
    switchProfile(target);
  }
});
const newProfileBtn = $("newProfileBtn");
if (newProfileBtn) {
  newProfileBtn.addEventListener("click", () => {
    closeAllMenus();
    const input = window.prompt("请输入新 Profile 名称（仅支持小写字母、数字、短横线、下划线）：");
    if (!input) return;
    const name = input.trim();
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      toast("Profile 名称不合法：仅支持字母、数字、点、短横线、下划线");
      return;
    }
    switchProfile(name);
  });
}
wireSel("themeSel", (mi) => applyTheme(mi.dataset.th));
wireSel("genThemeSel", (mi) => applyTheme(mi.dataset.th));
wireSel("fontSel", (mi) => {
  uiPrefs.uiFont = mi.dataset.font;
  saveUiPrefs();
  applyAppearance();
  syncSettingsControls();
});
wireSel("langSel", (mi) => {
  if (mi.dataset.lang !== "zh-CN") return toast("目前仅支持简体中文");
});
wireSel("codeLightSel", () => toast("浅色代码主题目前固定 GitHub Light"));
wireSel("codeDarkSel", () => toast("深色代码主题目前固定 GitHub Dark"));
wireToggle("tgLineNo", (on) => {
  uiPrefs.lineNumbers = on;
  saveUiPrefs();
  applyAppearance();
  setTg($("tgLineNo"), on);
});
wireToggle("tgWrap", (on) => {
  uiPrefs.codeWrap = on;
  saveUiPrefs();
  applyAppearance();
  setTg($("tgWrap"), on);
});
wireToggle("tgThinking", (on) => {
  uiPrefs.showThinking = on;
  saveUiPrefs();
  applyAppearance();
  setTg($("tgThinking"), on);
  send({ type: "set_setting", key: "hideThinkingBlock", value: !on });
  renderChat();
});
wireToggle("tgSleep", (on) => {
  setTg($("tgSleep"), on);
  send({ type: "set_setting", key: "power.sleepPrevention", value: on ? "system" : "off" });
});
wireToggle("tgComputer", (on) => {
  setTg($("tgComputer"), on);
  send({ type: "set_setting", key: "computer.enabled", value: on });
  toast("已写入。电脑控制对之后新建的会话生效。");
});
wireToggle("tgMemory", (on) => {
  setTg($("tgMemory"), on);
  send({ type: "set_setting", key: "memory.backend", value: on ? "local" : "off" });
});
$("uiFsMinus").addEventListener("click", () => stepFont("uiFontSize", -1, 11, 18, "uiFsVal"));
$("uiFsPlus").addEventListener("click", () => stepFont("uiFontSize", 1, 11, 18, "uiFsVal"));
$("codeFsMinus").addEventListener("click", () => stepFont("codeFontSize", -1, 10, 18, "codeFsVal"));
$("codeFsPlus").addEventListener("click", () => stepFont("codeFontSize", 1, 10, 18, "codeFsVal"));
function saveDesktopField(field, inputId) {
  const env = { ...(hostSettings?.desktopEnv || { httpProxy: "", noProxy: "", caCerts: "" }), [field]: $(inputId).value.trim() };
  send({ type: "set_desktop_env", ...env });
}
$("proxySave").addEventListener("click", () => saveDesktopField("httpProxy", "proxyInput"));
$("noProxySave").addEventListener("click", () => saveDesktopField("noProxy", "noProxyInput"));
$("caSave").addEventListener("click", () => saveDesktopField("caCerts", "caInput"));
$("addProviderBtn").addEventListener("click", () => toast("自定义供应商需编辑 models.yml，当前版本没有添加表单"));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    $("settings").classList.contains("hidden") ? openSettings() : closeSettings();
  } else if (e.key === "Escape" && settingsOpen()) {
    e.preventDefault();
    closeSettings();
  }
});
applyAppearance();
syncSettingsControls();

// ---------- 总渲染 ----------
function renderAll() {
  renderList();
  renderChat();
  renderComposerBar();
  renderRight();
}

renderAll();
if (new URLSearchParams(location.search).has("preview")) {
  // 浏览器对照原型：?preview=1 注入六种动作样本，不连宿主
  const previewItems = [
    { role: "tool", name: "bash", text: "bash", args: { command: 'ps aux | grep -E "tauri dev|omp-desktop|host/host.ts" | grep -v grep | awk \'{print $2, $11, $12, $13}\'; echo "---清理检查完毕---"' } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: "本 workspace 已全清（32824 是 omp-kimi28 的打包实例，无关；76094 窗口归属它，悬案全解）。实现上下文环：" },
    { role: "tool", name: "edit", text: "edit", files: ["index.html", "style.css"] },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "tool", name: "edit", text: "edit", files: ["ui/app.js"], added: 31, removed: 1 },
    { role: "thinking", text: "思考 · 持续了几秒", thinking: "展开后的思考内容示意。", expandable: true },
    { role: "tool", name: "edit", text: "edit", files: ["ui/app.js"], removed: 1 },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: "校验语法后起全新 dev：" },
    { role: "tool", name: "bash", text: "bash", args: { command: "node --check /Users/xys/oh-my-pi-desktop/oh-my-pi-desktop-zcode-glm53flash/ui/app.js && echo \"JS OK\"" } },
    { role: "tool", name: "todo", text: "todo", todo: { content: "起干净 dev，定位「模型/思考下拉不见了」根因（双 dev 实例混合状态假设）", done: 2, total: 5 } },
    { role: "tool", name: "bash", text: "bash", args: { command: "bunx tauri dev" } },
    { role: "tool", name: "bash", text: "bash", args: { command: 'sleep 25; swift /tmp/winpid.swift; ps aux | grep "zcode-glm53flash/src-tauri/target" | grep -v grep | awk \'{print $2}\' | head -2' } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: "33413（新实例）又是同样的迷你状态——真凶找到了方向：macOS 的应用状态恢复（Saved Application State），identifier 相同的应用（kimi28 打包版可能同 identifier）把最小化窗口状态传染给了 dev 实例。验证并清除：" },
    { role: "tool", name: "bash", text: "bash", args: { command: "defaults read /Users/xys/oh-my-pi-desktop/oh-my-pi-desktop-omp-kimi28/src-tauri/src-tauri.conf.json 2>/dev/null | head -3; grep -h ident…" } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "assistant", text: 'identifier 不同、无 savedState——假设否。但意识到之前 System Events 的 `tell process "omp-desktop"` 按名字匹配到了 kimi28 的实例（同名进程）！改用 unix id 精确匹配本实例操作窗口：' },
    { role: "tool", name: "bash", text: "bash", args: { command: "osascript <<'EOF' 2>&1 tell application \"System Events\" tell (first process whose unix id is 33413) set frontmost to true delay 0.4 set wc to …" } },
    { role: "thinking", text: "思考 · 持续了几秒" },
    { role: "tool", name: "bash", text: "bash", args: { command: "screencapture -l 76099 /tmp/w1.png 2>&1; ls -la /tmp/w1.png 2>/dev/null; screencapture -x -D 1 /tmp/screen1.png 2>&1 && sips -g pixelWi…" } },
    { role: "tool", name: "bash", text: "bash", args: { command: "sips -c 800 800 --cropOffset 1900 3800 /tmp/screen1.png --out /tmp/screen1-crop.png >/dev/null 2>&1 && echo cropped" } },
    { role: "tool", name: "read", text: "read", files: ["/tmp/screen1-crop.png"] },
  ];
  activePath = "/preview";
  openSessions.set(activePath, {
    sessionId: "preview",
    cwd: "/Users/xys/oh-my-pi-desktop/oh-my-pi-desktop-zcode-glm53flash",
    items: previewItems,
    assistantDraft: "",
    streaming: true,
    turnStartAt: Date.now() - 8000,
    subagents: new Map(),
    model: null,
    thinking: "auto",
    isGit: false,
    todos: [],
  });
  setConnected(true, "预览");
  renderAll();
  $("chatTitle").textContent = "查看指定 sessionId 的 zcode 对话记录";
} else {
  connect();
}
