// omp desktop 前端：视觉与交互 1:1 仿照 prototype/session-view.html（kimi28 原型），
// 数据源换成本仓 WebSocket 宿主协议（host/host.ts）。
// 协议：命令 {create_session|load_session|list_sessions|prompt|get_messages|
//   set_approval_mode|approval_response|set_model|set_thinking|get_git_diff|
//   get_file_diff|get_settings|set_setting|set_desktop_env|get_models_catalog|
//   set_enabled_model|get_usage_stats|list_agent_assets|asset_file_read|
//   asset_file_write|asset_file_create|get_context_detail|get_limits|
//   set_project_expanded|remove_project|add_project}，事件见 onMessage。
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

// 右栏 tab 栏：打开的 tab 有序列表 + 当前激活项；全部关闭后激活项为 null（起始页）
const TAB_META = {
  subagent: { label: "子代理", icon: "agents" },
  gitdiff: { label: "Git Diff", icon: "branch" },
  bgcmd: { label: "后台命令", icon: "term" },
  file: { label: "文件", icon: "folderOpen" },
};
let rightTabs = ["subagent"]; // 已打开 tab（有序）
let rightTab = "subagent"; // 激活 tab；null = 全部关闭，显示起始页
function activateRightTab(name) {
  // 确保 tab 存在并激活，不触发渲染（调用方自行渲染）
  if (!rightTabs.includes(name)) rightTabs.push(name);
  rightTab = name;
}
function openRightTab(name) {
  activateRightTab(name);
  renderRight();
}
function closeRightTab(name) {
  const i = rightTabs.indexOf(name);
  if (i < 0) return;
  rightTabs.splice(i, 1);
  if (rightTab === name) rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  renderRight();
}
let fileView = null; // 文件页详情数据：{ path, text, startLine, lineNumbers, reqRange, full?, error? }
const fileTreeDirs = new Map(); // 文件树懒加载缓存：目录路径 -> 子项列表（undefined = 未加载）
const fileTreeExpanded = new Set(); // 文件树展开中的目录路径
const fileTreePending = new Set(); // 已发出 list_dir 待回包的目录路径
let fileViewPending = null; // 等待 read_file 回包的详情路径
let gitViewMode = "tree"; // tree | flat
let selectedFile = null; // gitdiff 内选中的文件（详情视图）
const fileDiffCache = { path: null, diff: "", loading: false };
const briefDiffCache = {}; // 编辑行内联展开用的单文件 diff，path -> diff 文本
let briefDiffPending = null; // 等待 file_diff 回包的内联展开路径
const expandedDirs = new Set();
let animateGdKids = false; // 下一次 renderRightBody 为目录展开动作的子行播放入场动画（同步渲染后立即复位）
const gitDiffCache = { cwd: null, files: [], loading: false };
let changesOpen = false; // changebar 展开态
let animateThinkBody = false; // 下一次 renderChat 为思考展开动作的 think-body 播放入场动画（同步渲染后立即复位）
let todoCollapsed = false; // 进程卡收起为胶囊
let viewMode = "project"; // 左栏视图：project | recent
let isProjectManageMode = false; // 项目清理模式：展开所有项目与会话，展示移除/删除按钮

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
let allProjects = []; // 所有项目全路径（宿主 profile 配置目录 omp-desktop.json）
let removedProjects = []; // 已移除项目全路径（项目视图隐藏，最近视图仍显示其会话）
const projectLimits = new Map(); // cwd -> 已显示条数（默认 5，步进 5）
const expandedProjects = new Set(); // 需要展开的项目 cwd（宿主 omp-desktop.json 持久化，未记录的默认收起）
let animateProjectKids = false; // 下一次 renderList 为展开动作的子行播放入场动画（同步渲染后立即复位）
const pinnedSessions = new Set(); // 置顶会话 path（宿主 omp-desktop.json pinnedSessions 持久化，重启保持）
/** 已打开（新建或加载）的会话：path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...} */
const openSessions = new Map();
// 结束后未查看的会话（灰白圆点提示），localStorage 持久化
const unseenFinished = new Set(JSON.parse(localStorage.getItem("omp-unseen-finished") || "[]"));

function isJunkPlaceholder(text) {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}
function saveUnseen() {
  localStorage.setItem("omp-unseen-finished", JSON.stringify([...unseenFinished].slice(-200)));
}
let activePath = null;
let selectedSubagent = null; // 右栏流视图选中的 subagentId（null = 卡片列表）
let ws = null;
let pendingCreate = false;
let hostSettings = null;
let modelCatalog = [];
let selectedProvider = null;
let mpAddView = false; // 「添加供应商」视图开关:打开时右卡列出全部供应商
let mpDetailProv = null; // 添加视图内选中的供应商(详情页:登录 / API key 二选一)
let allProvidersCache = null; // get_all_providers 响应缓存
let loginBusy = false; // OMP 登录流程进行中
let agentAssets = null;
let usageStats = null;
let isCreatingNew = false;
let newSessionProject = "";
let newSessionBranch = "";
let newSessionBranches = [];
let newSessionIsGit = false;
let newSessionModel = "";
let newSessionThinking = "auto";
let pendingNewPrompt = null; // { text, files }，新建会话创建成功后补发

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
    // 启动时欢迎页先于连接渲染，get_git_branches 曾被 send 丢弃；连接就绪后补拉
    if (isCreatingNew && newSessionProject) send({ type: "get_git_branches", cwd: newSessionProject });
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
      if (mpAddView) {
        if (mpDetailProv) renderProviderDetail();
        else renderAddProviderView();
      } else renderModelPage();
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
      allProjects = msg.allProjects ?? [];
      removedProjects = msg.removedProjects ?? [];
      expandedProjects.clear();
      for (const c of msg.expandedProjects ?? []) expandedProjects.add(c);
      pinnedSessions.clear();
      for (const p of msg.pinnedSessions ?? []) pinnedSessions.add(p);
      if (isProjectManageMode) {
        for (const p of diskProjects) expandedProjects.add(p.cwd);
      }
      if (activePath && !diskProjects.some((p) => p.sessions.some((s) => s.path === activePath))) {
        openSessions.delete(activePath);
        activePath = null;
        showWelcomeScreen(newSessionProject || diskProjects[0]?.cwd);
      }
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
        const { text, files } = pendingNewPrompt;
        pendingNewPrompt = null;
        const s = activeOpen();
        if (s) {
          s.items.push({ role: "user", text });
          renderAll();
          ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
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
        s.turnItemStart = s.items.length; // 本轮过程起点：turn_end 时从这里打包收起
      } else if (msg.kind === "text_delta") {
        s.assistantDraft += msg.text;
      } else if (msg.kind === "thinking") {
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
          s.items.push({ role: "assistant", text: s.assistantDraft });
        }
        s.assistantDraft = "";
        if (msg.phase === "start") {
          // hideThinkingBlock(=设置「显示思考过程」关闭) 时默认收起；开启时默认展开并流式展示
          s.items.push({ role: "thinking", text: "思考", thinking: "", streaming: true, expanded: uiPrefs.showThinking });
        } else {
          const last = [...s.items].reverse().find((it) => it.role === "thinking");
          if (last) {
            last.text = `思考 · ${msg.durationLabel || "持续了几秒"}`;
            last.thinking = msg.thinking || "";
            last.expandable = !!msg.expandable;
            last.streaming = false;
            last.expanded = false; // 思考完成时收起标签
          }
        }
      } else if (msg.kind === "thinking_delta") {
        const last = [...s.items].reverse().find((it) => it.role === "thinking" && it.streaming);
        if (last) last.thinking = (last.thinking || "") + msg.text;
      } else if (msg.kind === "tool") {
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
          s.items.push({ role: "assistant", text: s.assistantDraft });
        }
        s.assistantDraft = "";
        s.items.push({
          role: "tool",
          text: msg.name,
          name: msg.name,
          toolCallId: msg.toolCallId,
          args: msg.args,
          files: msg.files,
          running: msg.name === "bash" || msg.name === "shell" || msg.name === "eval", // 终端/求值工具先按运行中显示转圈
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
          if (msg.output != null) last.output = msg.output;
          if (msg.details != null) last.details = msg.details;
          last.running = false;
        }
      } else if (msg.kind === "turn_end") {
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
        s.assistantDraft = "";
        s.streaming = false;
        // 一轮结束：过程（thinking/工具/中间响应）收进 loop 组自动收起，只留最后一条 assistant 对外展示
        const startIdx = s.turnItemStart ?? s.items.length;
        s.turnItemStart = null;
        const runItems = s.items.splice(startIdx);
        let lastA = -1;
        for (let i = runItems.length - 1; i >= 0; i--) {
          if (runItems[i].role === "assistant") {
            lastA = i;
            break;
          }
        }
        const finalOut = lastA >= 0 ? runItems.splice(lastA, 1) : [];
        if (runItems.length) {
          s.items.push({
            role: "loop",
            text: "",
            collapsed: true,
            items: runItems,
            durationSec: s.turnStartAt ? Math.round((Date.now() - s.turnStartAt) / 1000) : null,
            usage: msg.usage || null,
          });
        }
        s.items.push(...finalOut);
        s.turnStartAt = null;
        send({ type: "list_sessions" }); // title/firstMessage 可能已更新
        if (s.isGit) refreshGitDiff(true); // agent 可能改了文件，强制重拉
        // 会话已结束：非当前正在查看的会话标记「未查看」，列表显示灰白圆点
        const p = [...openSessions.entries()].find(([, v]) => v === s)?.[0];
        if (p && p !== activePath) {
          unseenFinished.add(p);
          saveUnseen();
        }
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
      else if (msg.kind === "tool") sub.tools.push({ name: msg.name, args: msg.args, files: msg.files, toolCallId: msg.toolCallId, running: msg.name === "bash" || msg.name === "shell" || msg.name === "eval" });
      else if (msg.kind === "tool_update") {
        const last =
          [...sub.tools].reverse().find((t) => t.toolCallId && t.toolCallId === msg.toolCallId) ||
          [...sub.tools].reverse().find((t) => t.name === msg.name);
        if (last) Object.assign(last, { files: uniqueFiles(msg.files ?? last.files), added: msg.added, removed: msg.removed, todo: msg.todo, output: msg.output ?? last.output, details: msg.details ?? last.details, running: false });
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
      briefDiffCache[msg.path] = msg.diff; // 同一份回包同时喂给编辑行内联展开
      if (briefDiffPending === msg.path) {
        briefDiffPending = null;
        renderChat();
      }
      if (rightTab === "gitdiff" && selectedFile === msg.path) renderRightBody();
      break;
    }
    case "file_content": {
      // 文件页全文件内容回包：无条件写入（用户可能已切走 tab），文件 tab 可见时立即重绘
      fileViewPending = null;
      if (fileView && fileView.path === msg.path) {
        if (msg.error) fileView.error = msg.error;
        else Object.assign(fileView, { text: msg.text, startLine: 1, lineNumbers: null, full: true, error: null });
        if (rightTab === "file") renderRightBody();
      }
      break;
    }
    case "dir_list": {
      // 文件树单层回包：填充缓存，文件 tab 空态（树视图）时重绘
      fileTreePending.delete(msg.path);
      fileTreeDirs.set(msg.path, msg.entries ?? []);
      if (rightTab === "file" && !fileView) renderRightBody();
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
    case "limits_result":
      fillLimits(msg);
      break;
    case "provider_limits_result": {
      // 模型管理页配额:仅当选中供应商未变、且模型页仍打开时回填,避免旧响应污染
      const el = $("mpLimSec");
      if (el && msg.provider === selectedProvider) el.replaceChildren(buildLimitsSection(msg));
      break;
    }
    case "all_providers":
      allProvidersCache = msg.providers ?? [];
      if (mpAddView) renderAddProviderView();
      break;
    case "login_progress":
      if (msg.reqId !== loginReqId) break;
      showLoginBanner(`${msg.provider}：${msg.message}`);
      break;
    case "login_prompt":
      if (msg.reqId !== loginReqId) break;
      showLoginPrompt(msg);
      break;
    case "login_done":
      if (msg.reqId !== loginReqId) break;
      loginBusy = false;
      hideLoginBanner();
      closeLoginPrompt();
      if (msg.ok) {
        toast(`${msg.provider} 登录成功，模型列表已刷新`);
        mpAddView = false;
        renderModelPage();
      } else if (msg.cancelled) {
        toast("登录已取消");
      } else {
        toast(`${msg.provider} 登录失败：${msg.message}`);
      }
      break;
    case "provider_key_done":
      toast(`${msg.provider} API key 已保存，模型列表已刷新`);
      break;
    case "models_config_path":
      toast(`配置文件：${msg.path}`);
      break;
    case "asset_file":
      if (msg.kind === "skill") {
        if ($("skEditText")) $("skEditText").value = msg.content;
        if ($("skEditPath")) $("skEditPath").textContent = msg.path;
      } else {
        openAssetEditor(msg.kind ?? "agent", msg.path, msg.content);
      }
      break;
    case "memory_file":
      if (!memContentEl) break;
      if (msg.files) {
        memDetailBase = msg.path;
        memDetailFiles = msg.files;
        memDetailRollouts = msg.rollouts ?? [];
        memDetailActive = { name: msg.file, rollout: false };
      }
      renderMemoryDetail(msg);
      break;
    case "asset_file_saved":
      if (msg.kind === "skill") {
        if ($("skEditStatus")) $("skEditStatus").textContent = "已保存";
        setTimeout(() => { if ($("skEditStatus")) $("skEditStatus").textContent = ""; }, 2000);
      } else {
        assetStatus(msg.kind ?? "agent", "已保存");
      }
      send({ type: "list_agent_assets" });
      break;
    case "asset_file_deleted":
      toast(msg.kind === "skill" ? "技能已删除" : "文件已删除");
      break;
    case "mcp_server_tested":
      handleMcpServerTested(msg);
      break;
    case "error": {
      gitDiffCache.loading = false;
      if (msg.kind && assetSelPath[msg.kind] && !$(ASSET_PAGES[msg.kind].editor).classList.contains("hidden")) assetStatus(msg.kind, msg.message);
      if (memContentEl && memContentEl.textContent === "读取中…") memContentEl.textContent = `读取失败：${msg.message}`;
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
// 待发送附件：图片走 ImageContent（base64），文本类文件内联进 prompt
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
let pendingFiles = []; // { id, name, kind: "image" | "text", mime, data }（image: base64；text: 文件内容）
let fileSeq = 0;

$("plusBtn").addEventListener("click", () => $("filePicker").click());
$("filePicker").addEventListener("change", async (e) => {
  const picked = [...e.target.files];
  e.target.value = ""; // 允许重复选同一文件
  for (const file of picked) {
    if (file.size > MAX_ATTACH_BYTES) {
      toast(`「${file.name}」超过 10MB，未添加`);
      continue;
    }
    try {
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(r.result);
          r.onerror = () => no(r.error);
          r.readAsDataURL(file);
        });
        pendingFiles.push({ id: ++fileSeq, name: file.name, kind: "image", mime: file.type, data: dataUrl.split(",")[1] });
      } else {
        pendingFiles.push({ id: ++fileSeq, name: file.name, kind: "text", mime: file.type || "text/plain", data: await file.text() });
      }
    } catch {
      toast(`读取「${file.name}」失败`);
    }
  }
  renderAttachRow();
  updateSendReady();
});

// 图标统一注册表见 icons.js，通过 icon("name") / icon("name", size) 取用

function renderAttachRow() {
  const row = $("attachRow");
  row.innerHTML = "";
  for (const f of pendingFiles) {
    const chip = document.createElement("span");
    chip.className = "atchip";
    chip.innerHTML = `<span class="at-ic">${f.kind === "image" ? icon("image") : icon("file")}</span><span class="at-name" title="${f.name}">${f.name}</span>`;
    const x = document.createElement("button");
    x.className = "atchip-x";
    x.title = "移除";
    x.textContent = "×";
    x.addEventListener("click", () => {
      pendingFiles = pendingFiles.filter((it) => it.id !== f.id);
      renderAttachRow();
      updateSendReady();
    });
    chip.appendChild(x);
    row.appendChild(chip);
  }
  row.hidden = pendingFiles.length === 0;
}

// 组装随 prompt 下发的附件载荷（发送后由调用方清空 pendingFiles）
function buildAttachPayload() {
  return pendingFiles.map((f) =>
    f.kind === "image"
      ? { kind: "image", mime: f.mime, data: f.data }
      : { kind: "text", name: f.name, text: f.data }
  );
}

function sendPrompt() {
  const text = inputEl.value.trim();
  const files = buildAttachPayload();
  if ((!text && files.length === 0) || ws.readyState !== 1) return;

  if (isCreatingNew || !activeOpen()) {
    pendingNewPrompt = { text, files };
    inputEl.value = "";
    pendingFiles = [];
    renderAttachRow();
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
  pendingFiles = [];
  renderAttachRow();
  resizeInput();
  updateSendReady();
  renderAll();
  ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
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
  $("sendBtn").classList.toggle("ready", inputEl.value.trim().length > 0 || pendingFiles.length > 0);
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
  "always-ask": { label: "手动批准", icon: "permAsk", yolo: false },
  write: { label: "默认", icon: "permDefault", yolo: false },
  yolo: { label: "全自动", icon: "shieldWarn", yolo: true },
};
let approvalMode = "always-ask";
function setApprovalModeUi(mode) {
  approvalMode = mode ?? "always-ask";
  const meta = MODE_META[approvalMode] ?? MODE_META["always-ask"];
  $("modeLabel").textContent = meta.label;
  // 按钮上的图标同步为当前模式图标（hydrateIcons 后占位 span 已替换为带 id 的 svg）
  const ic = $("modeIcon");
  if (ic) {
    const t = document.createElement("template");
    t.innerHTML = icon(meta.icon).trim();
    const svg = t.content.firstElementChild;
    if (svg) {
      svg.id = "modeIcon";
      ic.replaceWith(svg);
    }
  }
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

function getAvailableProjects() {
  const removedSet = new Set(removedProjects);
  const sessionsOf = new Map(diskProjects.map((p) => [p.cwd, p.sessions]));
  const known = [...new Set([...allProjects, ...diskProjects.map((p) => p.cwd)])];
  const ts = (p) => (p.sessions[0] ? Date.parse(p.sessions[0].modified) : 0);
  return known
    .filter((cwd) => !removedSet.has(cwd))
    .map((cwd) => ({ cwd, sessions: sessionsOf.get(cwd) ?? [] }))
    .sort((a, b) => ts(b) - ts(a));
}

function setWelcomeProject(cwd) {
  if (!cwd) {
    const avail = getAvailableProjects();
    cwd = avail[0]?.cwd || diskProjects[0]?.cwd || "/";
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
  // renderChat 每次重绘都会调到本函数：已在欢迎页时走轻量路径，不重置输入、不关菜单、不重拉分支
  const alreadyOpen = isCreatingNew && !$("welcomeScreen")?.classList.contains("hidden");
  isCreatingNew = true;
  activePath = null;
  updateGreeting();
  if (!alreadyOpen) send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置

  $("stream")?.classList.add("hidden");
  $("changebar")?.classList.add("hidden");
  $("changesFiles")?.classList.remove("open");
  $("statusCard")?.classList.add("hidden");
  $("capsule")?.classList.add("hidden");
  document.querySelector(".dock")?.classList.add("hidden");

  // 将统一的输入框组件挂载进欢迎页延展卡片内部（外卡单一边框勾勒整体轮廓）
  const composer = $("composer");
  const wbBackCard = $("wbBackCard");
  if (composer && wbBackCard && !wbBackCard.contains(composer)) {
    wbBackCard.appendChild(composer);
  }
  composer?.classList.add("in-welcome");

  $("welcomeScreen")?.classList.remove("hidden");
  $("chatTitle").textContent = "新建任务";

  const targetProject = preferredCwd || newSessionProject || localStorage.getItem("omp-new-project") || (diskProjects[0]?.cwd);
  // 项目未变化时跳过：避免清空分支状态导致选择器闪动、重复发 get_git_branches
  if (!alreadyOpen || targetProject !== newSessionProject) setWelcomeProject(targetProject);
  initNewSessionModel();
  setApprovalModeUi(approvalMode);
  renderComposerBar();

  if (alreadyOpen) return;

  if (inputEl) {
    inputEl.placeholder = "使用 @ 添加上下文，使用 / 选择命令或能力";
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
  updateRailVisibility();

  if (inputEl) {
    inputEl.placeholder = "发消息…（Enter 发送）";
  }
}

function renderWbProjectList(filter = "") {
  const listEl = $("wbProjList");
  if (!listEl) return;
  listEl.innerHTML = "";

  const available = getAvailableProjects();
  const kw = filter.trim().toLowerCase();
  const matched = kw
    ? available.filter((p) => {
        const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
        return name.toLowerCase().includes(kw) || p.cwd.toLowerCase().includes(kw);
      })
    : available;

  if (matched.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wb-proj-empty";
    empty.textContent = "无匹配工作区";
    listEl.appendChild(empty);
    return;
  }

  for (const p of matched) {
    const item = document.createElement("div");
    item.className = "wb-proj-item" + (p.cwd === newSessionProject ? " selected" : "");
    item.title = p.cwd;

    const ic = document.createElement("span");
    ic.className = "wb-proj-item-icon";
    ic.innerHTML = icon("folderLine", 14);

    const nameEl = document.createElement("span");
    nameEl.className = "wb-proj-item-name";
    const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
    nameEl.textContent = name;

    item.append(ic, nameEl);
    item.onclick = (e) => {
      e.stopPropagation();
      setWelcomeProject(p.cwd);
      closeAllMenus();
    };
    listEl.appendChild(item);
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
  // 向上弹出：菜单底边贴着胶囊顶边上方 4px
  menu.style.top = "auto";
  menu.style.bottom = (backCard.clientHeight - $("wbProjectBtn").offsetTop + 4) + "px";

  const searchInput = $("wbProjSearchInput");
  if (searchInput) searchInput.value = "";
  renderWbProjectList("");
  menu.classList.add("open");

  setTimeout(() => searchInput?.focus(), 40);
});

$("wbProjSearchInput")?.addEventListener("input", (e) => {
  renderWbProjectList(e.target.value);
});

$("wbProjSearchInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const firstItem = $("wbProjList")?.querySelector(".wb-proj-item");
    if (firstItem) firstItem.click();
  } else if (e.key === "Escape") {
    closeAllMenus();
  }
});

$("wbProjectMenu")?.addEventListener("click", (e) => {
  e.stopPropagation();
});

$("wbProjOpenFolder")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllMenus();
  if (invoke) {
    invoke("plugin:dialog|open", { options: { directory: true, title: "选择项目文件夹" } })
      .then((p) => {
        if (p) {
          send({ type: "add_project", cwd: p });
          setWelcomeProject(p);
        }
      })
      .catch((err) => {
        console.warn("打开文件夹失败:", err);
      });
  } else {
    const manual = prompt("请输入项目文件夹绝对路径：");
    if (manual && manual.trim()) {
      const p = manual.trim();
      send({ type: "add_project", cwd: p });
      setWelcomeProject(p);
    }
  }
});

$("wbProjRemote")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toast("远程连接功能即将推出");
  closeAllMenus();
});

$("wbProjNoProject")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toast("不在项目中工作功能即将推出");
  closeAllMenus();
});

$("wbProjClear")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toast("不在项目中工作功能即将推出");
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
  // 向上弹出：菜单底边贴着胶囊顶边上方 4px
  menu.style.top = "auto";
  menu.style.bottom = (backCard.clientHeight - $("wbBranchBtn").offsetTop + 4) + "px";
  menu.innerHTML = "";
  for (const b of newSessionBranches) {
    const mi = document.createElement("div");
    mi.className = "mi";
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = b === newSessionBranch ? "✓" : "";
    // 分支图标与分支选择胶囊同款（branch），保持全局图标风格一致
    const ic = document.createElement("span");
    ic.className = "mi-ic";
    ic.style.color = "var(--dim)";
    ic.innerHTML = icon("branch", 14);
    mi.append(ck, ic, document.createTextNode(b));
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
  if (n >= 1024) return (n / 1024).toFixed(1) + "k";
  return String(n);
}

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

function buildLimitsSection(limits) {
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

function fillCtxCard(detail) {
  ringDetail = detail;
  refreshRingPop();
}

function fillLimits(limits) {
  ringLimits = limits;
  refreshRingPop();
}

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
    const prov = newSessionModel ? newSessionModel.split("/")[0] : "";
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

// 工具消息摘要：工具名 + 命令/文件，逗号连接
function railToolText(item) {
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

// 刻度尺寸单位是设备物理像素（Retina 下 1 CSS px = 2 设备像素），换算：CSS px = 设备像素 / devicePixelRatio；
// 从轨道中线向两边等距扩张（数量撑不下时等比压缩间距）；点击刻度滚动定位到该消息
function buildMsgRail(entries, sessionId) {
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

// ---------- 菜单开合（原型同款：composer 内 absolute + 互斥） ----------
function closeAllMenus() {
  closeCtxMenu();
  closeThemeMenu();
  closeProjPopups();
  document.querySelector(".wb-back-card")?.classList.remove("menu-open");
  $("wbProjectBtn")?.classList.remove("active");
  $("wbBranchBtn")?.classList.remove("active");
  for (const b of document.querySelectorAll(".pill-btn.active")) b.classList.remove("active");
  for (const m of document.querySelectorAll(".menu.open")) m.classList.remove("open");
}
window.addEventListener("click", closeAllMenus);
window.addEventListener("blur", closeAllMenus);
// 窗口尺寸变化时，打开中的 composer 菜单锚点随按钮位置改变而失效，直接收起
window.addEventListener("resize", () => {
  if (composerEl?.querySelector(".menu.open")) closeAllMenus();
});

// 打开 composer 内菜单：锚定按钮（left 跟随、顶部贴按钮上方），右缘不越界。
// 垂直方向按按钮实时 offsetTop 计算而非固定 bottom:44px——后者只在单行布局侥幸成立，
// 换行/分级收缩导致按钮位移后弹窗会脱离按钮（新建会话窄窗口错位 bug 的根因）
function openComposerMenu(menu, btn) {
  closeAllMenus();
  document.querySelectorAll(".pill-btn.active").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  menu.classList.add("open");
  const maxLeft = composerEl.clientWidth - menu.offsetWidth - 4;
  menu.style.left = Math.max(0, Math.min(btn.offsetLeft, maxLeft)) + "px";
  menu.style.top = Math.max(4, btn.offsetTop - menu.offsetHeight - 8) + "px";
  menu.style.bottom = "auto";
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
// 置顶图钉（极简线条，悬停会话行时浮现于左侧）

let projMenu = null; // 项目行「⋯」弹出菜单（fixed 定位，zoom 补偿走 placeMenu）
let projAddPop = null; // 「项目」标题栏 ＋ 手动添加弹层
function closeProjPopups() {
  projMenu?.remove();
  projMenu = null;
  projAddPop?.remove();
  projAddPop = null;
}

// 全局二次确认弹窗：严格遵照 ring-pop 视觉规范与 ringpop 动效
function showConfirmDialog({ title, message, confirmText = "确定", cancelText = "取消", danger = false, onConfirm }) {
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

function taskRow(s, { sub, showRepo, pinnedList } = {}) {
  const b = document.createElement("button");
  b.className = "task" + (sub ? " sub" : "") + (s.path === activePath ? " on" : "");
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
  if (isProjectManageMode) {
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
          if (activePath === s.path) {
            openSessions.delete(s.path);
            activePath = null;
            showWelcomeScreen(s.cwd || newSessionProject);
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
    isCreatingNew = false;
    hideWelcomeScreen();
    unseenFinished.delete(s.path);
    saveUnseen();
    if (openSessions.has(s.path)) {
      activePath = s.path;
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
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
    secTrash.className = "sec-trash" + (isProjectManageMode ? " active" : "");
    secTrash.innerHTML = icon("trash", 12);
    secTrash.title = isProjectManageMode ? "退出清理模式" : "清理项目与会话";
    secTrash.onclick = (e) => {
      e.stopPropagation();
      isProjectManageMode = !isProjectManageMode;
      if (isProjectManageMode) {
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
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.innerHTML = icon("caret");
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
      name.title = p.cwd;
      if (isProjectManageMode) {
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
          projMenu.style.zoom = zoomLevel;
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
      // 点击组头折叠/展开；展开态写入宿主 omp-desktop.json（收起即从配置移除，未记录的默认收起）；再展开时分页重置回默认 5 条
      proj.onclick = () => {
        const on = !expandedProjects.has(p.cwd);
        if (on) {
          expandedProjects.add(p.cwd);
          projectLimits.delete(p.cwd);
          animateProjectKids = true; // 本次 renderList 的子行播放入场动画
        } else {
          expandedProjects.delete(p.cwd);
        }
        send({ type: "set_project_expanded", cwd: p.cwd, expanded: on });
        renderList();
        animateProjectKids = false;
      };
      tasklistEl.appendChild(proj);
      if (!expandedProjects.has(p.cwd)) continue;
      // 管理模式下显示全部会话；默认 5 条，按需每次多加载 5 条
      const limit = isProjectManageMode ? Infinity : (projectLimits.get(p.cwd) ?? 5);
      const visibleSessions = p.sessions.slice(0, limit);
      for (const [i, s] of visibleSessions.entries()) {
        const row = taskRow(s, { sub: true });
        if (animateProjectKids) {
          row.classList.add("kids-in");
          row.style.animationDelay = i * 25 + "ms"; // 逐行错峰展开
        }
        tasklistEl.appendChild(row);
      }
      if (!isProjectManageMode && p.sessions.length > visibleSessions.length) {
        const moreLink = document.createElement("button");
        moreLink.className = "more-link";
        moreLink.textContent = "显示更多";
        moreLink.onclick = () => {
          projectLimits.set(p.cwd, visibleSessions.length + 5);
          renderList();
        };
        if (animateProjectKids) moreLink.classList.add("kids-in");
        tasklistEl.appendChild(moreLink);
      }
      if (p.sessions.length === 0) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "暂无任务";
        if (animateProjectKids) hint.classList.add("kids-in");
        tasklistEl.appendChild(hint);
      }
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

// ---------- 动作行图标（极简线性风格,与参考客户端一致） ----------
// 图标本体统一注册在 icons.js：term / think / pencil / todo / read / plug /
// down / chevronRight / ftHtml / ftCss / ftJs / ftImg / ftFile

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
  if (ext === "html" || ext === "htm") return icon("ftHtml");
  if (ext === "css") return icon("ftCss");
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "tsx") return icon("ftJs");
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return icon("ftImg");
  return icon("ftFile");
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
function fileChip(path, opts = {}) {
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

function renderCmd(item) {
  const command = item.args?.command || item.text || "";
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "cmd";
  const ic = document.createElement("span");
  ic.className = "c-ic";
  ic.innerHTML = icon("termBox", 14) + (item.name === "eval" ? "求值" : "终端");
  const tx = document.createElement("span");
  tx.className = "c-tx";
  tx.textContent = command || "";
  tx.title = command || "";
  div.append(ic, tx);
  if (item.running) {
    const sp = document.createElement("span");
    sp.className = "cmd-spin";
    div.appendChild(sp);
  }
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.cmdExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  div.appendChild(arrow);
  div.style.cursor = "pointer";
  let cardEl = null;
  div.onclick = () => {
    item.cmdExpanded = !item.cmdExpanded;
    arrow.classList.toggle("open", item.cmdExpanded); // 同元素原地旋转，不跳动
    if (item.cmdExpanded) {
      if (!cardEl) {
        cardEl = buildCmdCard(command, item, true);
        div.after(cardEl);
      }
    } else if (cardEl) {
      cardEl.remove();
      cardEl = null;
    }
  };
  wrap.appendChild(div);
  if (item.cmdExpanded) wrap.appendChild(buildCmdCard(command, item));
  return wrap;
}
// 终端行展开的圆角卡片：上命令、下输出；animate=true 时播放从上往下的揭示动画
function buildCmdCard(command, item, animate = false) {
  const card = document.createElement("div");
  card.className = "cmd-card" + (animate ? " drop" : "");
  const cmdEl = document.createElement("div");
  cmdEl.className = "cmd-card-cmd";
  cmdEl.textContent = command || "（无命令）";
  const outEl = document.createElement("pre");
  outEl.className = "cmd-card-out";
  outEl.textContent = item.output || (item.running ? "运行中…" : "（无输出）");
  card.append(attachFadeMask(cmdEl), attachFadeMask(outEl));
  return card;
}
// 后台工具（hub）：终端图标+后台标签+详细参数/输出展开
function renderHubTool(item) {
  const args = item.args || {};
  const op = args.op || "hub";
  const target = args.name || args.application || "";
  let summary = `hub ${op}${target ? " " + target : ""}`;
  if (args.application && Array.isArray(args.args)) {
    summary += `: ${args.application} ${args.args.join(" ")}`;
  } else if (args.command) {
    summary += `: ${args.command}`;
  } else if (args.text) {
    summary += `: ${args.text}`;
  }

  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "cmd";
  const ic = document.createElement("span");
  ic.className = "c-ic";
  ic.innerHTML = icon("termBox", 13) + "后台";
  const tx = document.createElement("span");
  tx.className = "c-tx";
  tx.textContent = summary;
  tx.title = summary;
  div.append(ic, tx);
  if (item.running) {
    const sp = document.createElement("span");
    sp.className = "cmd-spin";
    div.appendChild(sp);
  }
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.cmdExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  div.appendChild(arrow);
  div.style.cursor = "pointer";
  let cardEl = null;
  div.onclick = () => {
    item.cmdExpanded = !item.cmdExpanded;
    arrow.classList.toggle("open", item.cmdExpanded);
    if (item.cmdExpanded) {
      if (!cardEl) {
        cardEl = buildCmdCard(summary, item, true);
        div.after(cardEl);
      }
    } else if (cardEl) {
      cardEl.remove();
      cardEl = null;
    }
  };
  wrap.appendChild(div);
  if (item.cmdExpanded) wrap.appendChild(buildCmdCard(summary, item));
  return wrap;
}
function renderThink(item) {
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "act think";
  const ic = document.createElement("span");
  ic.className = "th-ic";
  ic.innerHTML = icon("think");
  div.append(ic, document.createTextNode(item.text || "思考 · 持续了几秒"));
  if (item.expandable || item.thinking) {
    const more = document.createElement("span");
    more.className = "th-more" + (item.expanded ? " open" : "");
    more.innerHTML = icon("chevronRight", 10);
    div.appendChild(more);
    div.style.cursor = "pointer";
    div.onclick = () => {
      item.expanded = !item.expanded;
      if (item.expanded) animateThinkBody = true; // 本次 renderChat 的 think-body 播放入场动画
      renderChat();
      animateThinkBody = false;
    };
  }
  wrap.appendChild(div);
  if (item.expanded && (item.thinking || item.streaming)) {
    const body = document.createElement("div");
    body.className = "think-body";
    if (animateThinkBody) body.classList.add("kids-in");
    body.textContent = item.thinking || "…";
    // 滚到底(或内容不足一屏)时解除底部虚化,否则遮住最末半行制造截断感
    const syncFade = () => {
      body.classList.toggle("no-fade", body.scrollTop + body.clientHeight >= body.scrollHeight - 1);
    };
    body.addEventListener("scroll", syncFade, { passive: true });
    requestAnimationFrame(syncFade);
    wrap.appendChild(body);
  }
  return wrap;
}
function renderEdit(item) {
  const files = uniqueFiles(item.files?.length ? item.files : item.args?.files || (item.args?.path ? [item.args.path] : []));
  const path = files[0] || "";
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "act edit";
  div.insertAdjacentHTML("beforeend", icon("pencil"));
  div.appendChild(document.createTextNode("编辑 "));
  if (path) {
    div.appendChild(
      fileChip(path, {
        nameClass: "ed-name",
        onNameClick: () => openFileDiffInSidebar(path),
      }),
    );
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
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.diffExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  div.appendChild(arrow);
  div.style.cursor = "pointer";
  let briefEl = null;
  div.onclick = () => {
    item.diffExpanded = !item.diffExpanded;
    arrow.classList.toggle("open", item.diffExpanded); // 同元素原地旋转，不跳动
    // 首次展开时按需拉取该文件 diff（回包经 file_diff 写入 briefDiffCache 后重渲染）
    const s = activeOpen();
    if (item.diffExpanded && path && s?.isGit && briefDiffCache[path] === undefined && briefDiffPending !== path) {
      briefDiffPending = path;
      send({ type: "get_file_diff", cwd: s.cwd, path });
    }
    // 原地插入/移除展开体，不整行重建
    if (item.diffExpanded && path) {
      if (!briefEl) {
        briefEl = buildEditBrief(path, true);
        div.after(briefEl);
      }
    } else if (briefEl) {
      briefEl.remove();
      briefEl = null;
    }
  };
  wrap.appendChild(div);
  if (item.diffExpanded && path) wrap.appendChild(buildEditBrief(path));
  return wrap;
}
// 底部渐变遮掩：滚到底(或内容不足一屏)时加 .no-fade 解除遮掩（与 think-body 同手法）
function attachFadeMask(el) {
  const sync = () => {
    el.classList.toggle("no-fade", el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  };
  el.addEventListener("scroll", sync, { passive: true });
  requestAnimationFrame(sync);
  return el;
}
// 编辑行内联展开的简略 diff 体；animate=true 时播放从上往下的揭示动画
function buildEditBrief(path, animate = false) {
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
function openFileDiffInSidebar(path) {
  const s = activeOpen();
  if (!s || !s.isGit) return;
  activateRightTab("gitdiff");
  selectedFile = path;
  fileDiffCache.loading = true;
  fileDiffCache.path = path;
  briefDiffCache[path] = undefined; // 详情与内联展开共用一次回包
  briefDiffPending = path;
  send({ type: "get_file_diff", cwd: s.cwd, path });
  expandRightPanel();
  renderRight();
}
function renderChange(item) {
  const files = uniqueFiles(item.files?.length ? item.files : item.args?.files || []);
  const div = document.createElement("div");
  div.className = "act change";
  div.insertAdjacentHTML("beforeend", icon("pencil"));
  div.appendChild(document.createTextNode(`更改 · ${files.length || "多"} 个文件`));
  if (files.length) {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "·";
    div.appendChild(document.createTextNode(" "));
    div.appendChild(sep);
    div.appendChild(document.createTextNode(" "));
    // 文件列表单行排布，超长在行尾出省略号
    const lane = document.createElement("span");
    lane.className = "chips-lane";
    for (const f of files) {
      lane.appendChild(fileChip(f));
      lane.appendChild(document.createTextNode(" "));
    }
    div.appendChild(lane);
  }
  return div;
}
function renderTodo(item) {
  const td = item.todo;
  const content = td?.content || item.args?.task || item.args?.i || item.text || "";
  const div = document.createElement("div");
  div.className = "act todo";
  div.insertAdjacentHTML("beforeend", icon("todo"));
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
  div.insertAdjacentHTML("beforeend", icon("read"));
  div.appendChild(document.createTextNode("读取 "));
  if (path) {
    // 读到过文本内容的读取行：文件名可点击（hover 下划线），右栏文件视图按行号范围展示
    const hasContent = !!(item.details?.displayContent?.text);
    div.appendChild(
      fileChip(
        path,
        hasContent ? { nameClass: "ed-name", onNameClick: () => openReadFileInSidebar(item, path) } : {},
      ),
    );
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
// 点击读取行文件名：文件页先用读取到的内容即时渲染，同时请求全文件——回包后整文件展示并高亮/定位读取范围
function openReadFileInSidebar(item, path) {
  const d = item.details;
  if (!d?.displayContent?.text) return;
  // 原始路径可能带行号选择器（path:59-123）：解析出请求范围用于行号高亮，并剥掉后缀得到干净路径
  const raw = String(d.resolvedPath || path);
  const m = raw.match(/:(\d+)(?:-(\d+))?$/);
  let clean = m ? raw.slice(0, m.index) : raw;
  if (!clean.startsWith("/")) clean = (activeOpen()?.cwd || "") + "/" + clean;
  fileView = {
    path: clean,
    text: d.displayContent.text,
    startLine: d.displayContent.startLine || 1,
    lineNumbers: Array.isArray(d.displayContent.lineNumbers) ? d.displayContent.lineNumbers : null,
    reqRange: m ? [Number(m[1]), Number(m[2] || m[1])] : null,
  };
  fileViewPending = clean;
  send({ type: "read_file", path: clean });
  activateRightTab("file");
  expandRightPanel();
  renderRight();
}
function renderGenericTool(item) {
  const div = document.createElement("div");
  div.className = "act";
  div.textContent = item.name || item.text || "";
  return div;
}
// grep 行：放大镜图标 + 「搜索」+ 模式串（截断省略）
function renderGrep(item) {
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", icon("read"));
  div.appendChild(document.createTextNode("搜索 "));
  const pat = item.args?.pattern || item.text || "";
  const tx = document.createElement("span");
  tx.className = "path";
  tx.textContent = pat;
  tx.title = pat;
  div.appendChild(tx);
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  if (dir) {
    const p = document.createElement("span");
    p.className = "path";
    p.textContent = dir;
    div.appendChild(p);
  }
  return div;
}
// glob 行：文件图标 + 「查找」+ 说明/模式 + 目录
function renderGlob(item) {
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", icon("ftFile"));
  div.appendChild(document.createTextNode("查找 "));
  const what = item.args?.pattern || item.args?.i || item.text || "";
  const tx = document.createElement("span");
  tx.className = "path";
  tx.textContent = what;
  tx.title = what;
  div.appendChild(tx);
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  if (dir) {
    const p = document.createElement("span");
    p.className = "path";
    p.textContent = dir;
    div.appendChild(p);
  }
  return div;
}
function renderMcp(item) {
  const div = document.createElement("div");
  div.className = "act mcp";
  div.insertAdjacentHTML("beforeend", icon("plug"));
  div.appendChild(document.createTextNode("MCP"));
  const tool = String(item.name || "").split("__").slice(2).join("__");
  if (tool) {
    const t = document.createElement("span");
    t.className = "path";
    t.textContent = ` ${tool}`;
    t.title = item.name;
    div.appendChild(t);
  }
  return div;
}
function toolKind(item) {
  const name = item.name || item.text || "";
  if (item.role === "thinking" || name === "thinking") return "think";
  if (name === "bash" || name === "shell" || name === "eval") return "cmd";
  if (name === "hub") return "hub";
  if (name === "grep" || name === "ast-grep") return "grep";
  if (name === "glob") return "glob";
  if (name.startsWith("mcp__")) return "mcp";
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
      return renderCmd(item);
    case "hub":
      return renderHubTool(item);
    case "grep":
      return renderGrep(item);
    case "glob":
      return renderGlob(item);
    case "mcp":
      return renderMcp(item);
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
  if (isJunkPlaceholder(text)) {
    const div = document.createElement("div");
    div.style.display = "none";
    return div;
  }
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
    btn.innerHTML = icon("down");
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
// 单条消息 → DOM（append 到 streamEl）+ 轨道刻度；loop 组展开时对子 items 递归复用
function appendChatItem(item, railEntries) {
  if (item.role === "user") {
    const div = document.createElement("div");
    div.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = item.text;
    div.appendChild(bubble);
    streamEl.appendChild(div);
    railEntries.push({ el: div, role: "user", text: item.text });
  } else if (item.role === "assistant") {
    if (isJunkPlaceholder(item.text)) return;
    const div = renderAssistantMessage(item.text);
    streamEl.appendChild(div);
    railEntries.push({ el: div, role: "assistant", text: item.text });
  } else if (item.role === "thinking") {
    const frag = renderThink(item); // 任何设置下思考标签都显示，hideThinkingBlock 只决定默认展开与否
    const anchor = frag.firstChild; // 标题行为刻度定位锚（fragment append 后引用仍有效）
    streamEl.appendChild(frag);
    railEntries.push({ el: anchor, role: "thinking", text: item.thinking || item.text });
  } else if (item.role === "tool") {
    const el = renderToolItem(item);
    const anchor = el.nodeType === 11 ? el.firstChild : el; // 先取锚点：append 后 fragment 即被清空（think 类工具返回 fragment）
    streamEl.appendChild(el);
    railEntries.push({ el: anchor, role: "tool", text: railToolText(item) });
  } else if (item.role === "loop") {
    const row = document.createElement("div");
    row.className = "act loop";
    row.appendChild(buildLoopSummary(item));
    const arrow = document.createElement("span");
    arrow.className = "lp-arrow" + (item.collapsed ? "" : " open");
    arrow.innerHTML = icon("chevronRight");
    row.appendChild(arrow);
    row.style.cursor = "pointer";
    row.onclick = () => {
      item.collapsed = !item.collapsed;
      renderChat();
    };
    streamEl.appendChild(row);
    railEntries.push({ el: row, role: "meta", text: loopSummaryText(item) });
    if (!item.collapsed) for (const sub of item.items || []) appendChatItem(sub, railEntries);
  } else if (item.role === "meta") {
    const div = document.createElement("div");
    div.className = "act";
    div.textContent = item.text;
    streamEl.appendChild(div);
    railEntries.push({ el: div, role: "meta", text: item.text });
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
    railEntries.push({ el: div, role: "approval", text: item.title });
  } else {
    const div = document.createElement("div");
    div.className = "act err";
    div.textContent = `✗ ${item.text}`;
    streamEl.appendChild(div);
    railEntries.push({ el: div, role: "err", text: item.text });
  }
}

// token 数值 <1000 原样，≥1K/1M 切换单位保留 1 位小数
function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
// loop 组收起时的汇总文本：「已工作 xx 分 xx 秒, 总消耗 input xx, output xx, cache read xx[, cache write xx]」
function loopSummaryText(item) {
  const parts = [];
  if (item.durationSec != null) parts.push(`已工作 ${fmtDuration(item.durationSec)}`);
  const u = item.usage;
  if (u) {
    const seg = [`input ${fmtTokens(u.input)}`, `output ${fmtTokens(u.output)}`, `cache read ${fmtTokens(u.cacheRead)}`];
    if (u.cacheWrite > 0) seg.push(`cache write ${fmtTokens(u.cacheWrite)}`);
    parts.push(`总消耗 ${seg.join(", ")}`);
  }
  return parts.join(", ");
}
function buildLoopSummary(item) {
  const span = document.createElement("span");
  span.className = "lp-tx";
  span.textContent = loopSummaryText(item);
  return span;
}

function renderChat() {
  const s = activeOpen();
  if (!s || isCreatingNew) {
    showWelcomeScreen(activeOpen()?.cwd);
    $("msgRail").hidden = true;
    dismissRailPop();
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
      const holder = document.createElement("div");
      holder.className = "cf-in";
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
        holder.appendChild(row);
      }
      if (fs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "f";
        empty.style.cursor = "default";
        empty.textContent = "工作区干净";
        holder.appendChild(empty);
      }
      files.appendChild(holder);
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
  const railEntries = []; // 消息轨道数据：每条消息 → 一道刻度（元素锚点 + 角色 + 摘要）
  for (const item of s.items) appendChatItem(item, railEntries);
  if (s.streaming || s.assistantDraft) {
    const act = document.createElement("div");
    act.className = "act t2";
    const elapsed = s.turnStartAt ? Math.floor((Date.now() - s.turnStartAt) / 1000) : 0;
    act.innerHTML = `工作中 <span id="workSec">${elapsed}</span> 秒`;
    streamEl.appendChild(act);
  }
  if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
    const d = renderAssistantMessage(s.assistantDraft);
    d.classList.add("streaming-draft");
    streamEl.appendChild(d);
  }
  buildMsgRail(railEntries.filter((e) => e.role === "user"), s.sessionId); // 轨道只刻用户消息
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
  activateRightTab("gitdiff");
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
    // 上下文环无会话时也展示为空环:hover 弹出配额(见 ctxRing mouseenter)
    $("ctxRing").hidden = false;
    $("ctxRingFill").style.strokeDashoffset = String(RING_C);
    $("ctxRing").className = "ctx-ring";
    updateBgTaskButton();
    updateBgSubagentButton();
    fitComposerBar();
    return;
  }
  modelBtn.disabled = thinkBtn.disabled = !s;
  $("modelLabel").textContent = s?.model ? (modelNames.get(s.model) ?? s.model.split("/").pop()) : "模型";
  $("modelIcon").textContent = PROV_IC[s?.model?.split("/")[0]] || "✦";
  $("thinkLabel").textContent = s ? (s.thinking ? THINKING_LABELS[s.thinking] ?? s.thinking : "思考") : "思考";
  // 上下文环：从顶端顺时针填充；无数据空环
  const ring = $("ctxRing");
  ring.hidden = !s;
  if (s) {
    const p = s.ctx ? Math.min(1, s.ctx.percent / 100) : 0;
    $("ctxRingFill").style.strokeDashoffset = String(RING_C * (1 - p));
    ring.className = "ctx-ring" + (s.ctx ? (s.ctx.percent >= 85 ? " hot" : s.ctx.percent >= 60 ? " warm" : "") : "");
  }
  updateBgTaskButton();
  updateBgSubagentButton();
  fitComposerBar();
}

// 底栏分级收缩：布局宽度不足时按固定顺序逐级收缩——
// 1 权限模式→纯图标 → 2 思考级别→纯图标 → 3 模型→纯图标 → 4 隐藏子智能体 → 5 隐藏后台任务。
// 用布局宽度判定（scrollWidth > clientWidth 即溢出），界面缩放(zoom)下两端同比例换算，依然准确；
// 全部收完仍不够就不再处理，由 #composer min-width 托底
const BAR_STAGES = 5;
let barStage = 0;
function fitComposerBar() {
  if (!composerEl) return;
  composerEl.classList.remove("bar-1", "bar-2", "bar-3", "bar-4", "bar-5");
  const cbar = composerEl.querySelector(".cbar");
  let stage = 0;
  if (cbar) {
    // 需求宽度 = 各可见子项 offsetWidth 之和 + 间隙（flex 子项不压缩、.sp 弹性间隔除外）。
    // 不用 scrollWidth：overflow:hidden 的 flex 容器在 Chrome/WebKit 下对 flex:none
    // 子项的 scrollWidth 返回值不可靠（实测被钳到 clientWidth）
    const gap = parseFloat(getComputedStyle(cbar).columnGap) || 6;
    const needWidth = () => {
      const vis = [...cbar.children].filter((k) => !k.classList.contains("sp") && k.offsetWidth > 0);
      return vis.reduce((a, k) => a + k.offsetWidth, 0) + gap * Math.max(0, vis.length - 1);
    };
    while (stage < BAR_STAGES && needWidth() > cbar.clientWidth) {
      stage++;
      composerEl.classList.add("bar-" + stage);
    }
  }
  if (stage !== barStage) {
    barStage = stage;
    // 阶段变化会移动按钮，打开中的菜单锚点随之失效，直接收起
    if (composerEl.querySelector(".menu.open")) closeAllMenus();
  }
}
// 窗口/分栏/缩放引起 composer 宽度变化时重新适配
new ResizeObserver(() => fitComposerBar()).observe(composerEl);

// ---------- 右栏 ----------
function renderRight() {
  const s = activeOpen();
  // 非 git 会话不保留 Git Diff tab（打开的列表与激活项都回落）
  if (!s?.isGit && rightTabs.includes("gitdiff")) {
    const i = rightTabs.indexOf("gitdiff");
    rightTabs.splice(i, 1);
    if (rightTab === "gitdiff") rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  }
  // 工具条 project 名
  $("wsName").textContent = s ? s.cwd.split("/").filter(Boolean).pop() : "—";
  // 进程状态卡（TODO）
  renderStatusCard();
  renderRightTabs();
  const isGitTab = rightTab === "gitdiff";
  $("gitRefresh").style.display = isGitTab ? "" : "none";
  $("gitViewToggle").style.display = isGitTab ? "" : "none";
  $("gitViewToggle").textContent = gitViewMode === "tree" ? "树" : "平铺";
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
    b.className = "rtab" + (name === rightTab ? " on" : "");
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
      if (rightTab !== name) {
        rightTab = name;
        renderRight();
      }
    };
    wrap.appendChild(b);
  }
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
  activateRightTab("subagent");
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
  if (rightTab === null) renderStartPage(); // tab 全部关闭：居中起始页
  else if (rightTab === "gitdiff") renderGitDiff();
  else if (rightTab === "bgcmd") renderBgCmdList();
  else if (rightTab === "file") renderFileView();
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
  for (const name of ["subagent", "gitdiff", "file", "bgcmd"]) {
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
    caret.innerHTML = expanded ? icon("caret") : icon("chevronRight", 10);
    const name = document.createElement("span");
    name.className = "gd-name";
    name.textContent = seg;
    const count = document.createElement("span");
    count.className = "gd-count";
    count.textContent = countFiles(dir);
    row.append(caret, name, count);
    if (animateGdKids) {
      row.classList.add("kids-in");
      row.style.animationDelay = depth * 15 + "ms"; // 按目录深度错峰
    }
    row.onclick = () => {
      if (expandedDirs.has(dirPath)) {
        expandedDirs.delete(dirPath);
      } else {
        expandedDirs.add(dirPath);
        animateGdKids = true; // 本次 renderRightBody 的子行播放入场动画
      }
      renderRightBody();
      animateGdKids = false;
    };
    rightBodyEl.appendChild(row);
    if (expanded) renderTreeLevel(dir, dirPath, depth + 1);
  }
  for (const f of node.files) {
    const fr = gitFileRow(f, f.path, depth);
    if (animateGdKids) {
      fr.classList.add("kids-in");
      fr.style.animationDelay = depth * 15 + "ms";
    }
    rightBodyEl.appendChild(fr);
  }
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

// ---------- 文件页（读取行点击 / 文件树点击进入） ----------
const FILE_VIEW_MAX_LINES = 800; // 全文件超长时的展示窗口：有读取范围则以范围起始行开头，否则从头
function renderFileView() {
  if (fileView) renderFileDetail();
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
function renderFileDetail() {
  const fv = fileView;
  const back = document.createElement("button");
  back.className = "sub-back";
  back.textContent = "‹ 文件树";
  back.onclick = () => {
    fileView = null;
    renderRightBody();
  };
  rightBodyEl.appendChild(back);
  rightBodyEl.appendChild(buildFileCrumb(fv.path));
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
  const entries = fileTreeDirs.get(dirPath);
  if (entries === undefined) {
    if (!fileTreePending.has(dirPath)) {
      fileTreePending.add(dirPath);
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
      const expanded = fileTreeExpanded.has(full);
      const caret = document.createElement("span");
      caret.className = "ft-caret";
      caret.innerHTML = expanded ? icon("caret") : icon("chevronRight", 10);
      const name = document.createElement("span");
      name.className = "ft-name";
      name.textContent = e.name;
      row.append(caret, name);
      row.onclick = () => {
        if (fileTreeExpanded.has(full)) fileTreeExpanded.delete(full);
        else fileTreeExpanded.add(full);
        renderRightBody();
      };
      rightBodyEl.appendChild(row);
      if (expanded) renderFileTreeLevel(full, depth + 1);
    } else {
      row.innerHTML = `<span class="ft-caret ft-file-ic">${icon("ftFile")}</span><span class="ft-name">${e.name.replace(/</g, "&lt;")}</span>`;
      row.title = full;
      row.onclick = () => {
        fileView = { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null };
        fileViewPending = full;
        send({ type: "read_file", path: full });
        renderRightBody();
      };
      rightBodyEl.appendChild(row);
    }
  }
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

function updateBgTaskButton() {
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
  btn.classList.toggle("on", rightTab === "bgcmd" && !isRightCollapsed());
}

function getRunningSubagentCount(s) {
  if (!s || !s.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}

function updateBgSubagentButton() {
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
  btn.classList.toggle("on", rightTab === "subagent" && !isRightCollapsed());
}

let bgcmdOpenRow = null;

function closeBgCmdRow() {
  if (bgcmdOpenRow) {
    bgcmdOpenRow.classList.remove("on");
    const exp = bgcmdOpenRow.nextElementSibling;
    if (exp && exp.classList.contains("bgcmd-expand")) exp.remove();
    bgcmdOpenRow = null;
  }
}

function toggleBgCmdRow(row, task) {
  if (bgcmdOpenRow === row) {
    closeBgCmdRow();
    return;
  }
  closeBgCmdRow();
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

// 底部后台任务终端按钮点击事件：展开并切换到后台命令 tab，或 toggle 收起
$("bgTaskBtn").addEventListener("click", () => {
  const s = activeOpen();
  if (!s) return;
  if (!isRightCollapsed() && rightTab === "bgcmd") {
    setRightCollapsed(true);
  } else {
    activateRightTab("bgcmd");
    selectedFile = null;
    selectedSubagent = null;
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
  if (!isRightCollapsed() && rightTab === "subagent") {
    setRightCollapsed(true);
  } else {
    activateRightTab("subagent");
    selectedFile = null;
    selectedSubagent = null;
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
    btn.title = off ? "展开侧边栏 (⌘B)" : "收起侧边栏 (⌘B)";
    // 展开态显示「向左收起」，收起态显示「向右展开」
    btn.innerHTML = icon(off ? "collapseRight" : "collapseLeft");
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
  const btn = $("panelToggle");
  btn.title = off ? "展开侧边面板" : "收起侧边面板";
  // 展开态显示「向右收起」，收起态显示「向左展开」
  btn.innerHTML = icon(off ? "collapseLeft" : "collapseRight");
  if (!off) {
    todoCollapsed = true;
    renderStatusCard();
  }
  updateBgTaskButton();
  updateBgSubagentButton();
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

// 仅左栏禁用原生右键响应（选词高亮 + 系统菜单），其余区域照常响应系统右键（同 zcode）。
// WebKit 的选词发生在 contextmenu 默认行为阶段（拦 mousedown 无效，Chromium 才吃这套），
// 故记录右键前选区，contextmenu 后对比：仅撤销本次右键新产生的选词，用户已有选区保留。
let selBeforeCtx = null;
const inSidebar = (e) => e.target.closest("#sidebar");
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
  // zoom 会改变布局宽度但不触发 ResizeObserver（Chrome/WebKit 行为），手动重算底栏收缩
  fitComposerBar();
  updateRailVisibility();
}
// 对话区内容列宽度分段上限（占屏幕宽度的比例，而非 app 窗口）：
// 60% 为默认上限，35% 为第二段收缩目标。窗口从宽往窄收时边距先持续缩小，
// 钉到 75px/边后内容缩到 35% 屏幕宽，边距再缩到 20px/边，最后内容继续缩。
// 由 JS 读 screen.width 写入 --col-max / --col-max-35。
function updateContentColMax() {
  const w = window.screen.width;
  document.documentElement.style.setProperty("--col-max", Math.round(w * 0.6) + "px");
  document.documentElement.style.setProperty("--col-max-35", Math.round(w * 0.35) + "px");
}
updateContentColMax();
window.addEventListener("resize", updateContentColMax);
// 窗口跨屏拖动不一定触发 resize，兜底周期同步
setInterval(updateContentColMax, 2000);

// 实测内容列边距（dock 左缘 − 主卡片左缘），边距 < 65px 时隐藏左侧消息轨道
function updateRailVisibility() {
  const main = $("main");
  const dock = document.querySelector(".dock");
  if (!main || !dock || dock.classList.contains("hidden")) return;
  const m = dock.getBoundingClientRect().left - main.getBoundingClientRect().left;
  main.classList.toggle("rail-off", m < 65);
}
new ResizeObserver(updateRailVisibility).observe($("main"));
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
  fill("askTimeoutInput", hostSettings.askTimeout ? String(hostSettings.askTimeout) : "");
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
  // 主页面左下角同步显示当前 profile 名
  const sideName = $("sideProfileName");
  if (sideName) sideName.textContent = activeProfile;
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
  if ($("askTimeoutInput")) $("askTimeoutInput").value = hostSettings.askTimeout ? String(hostSettings.askTimeout) : "";
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

// 设置页右上角手动刷新(已取消 host 自动监听):模型页重载配置+目录,资产页重拉磁盘列表
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".pg-refresh");
  if (!btn) return;
  if (btn.dataset.refresh === "models") {
    send({ type: "reload_settings" });
    send({ type: "get_models_catalog" });
  } else {
    send({ type: "list_agent_assets" });
  }
  btn.classList.add("spin");
  setTimeout(() => btn.classList.remove("spin"), 500);
});
function closeSettings() {
  closeAllMenus();
  $("settings").classList.add("hidden");
}
function switchSetPage(id) {
  for (const x of document.querySelectorAll(".set-item")) x.classList.toggle("on", x.dataset.page === id);
  for (const p of document.querySelectorAll(".set-page")) p.classList.toggle("hidden", p.id !== id);
  $("setBody").scrollTop = 0;
  if (id === "pg-skills") renderSkillsPage();
  if (id === "pg-mcp") renderMcpPage();
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
// ---------- 记忆详情 Markdown 渲染（整体先转义再排版，防注入） ----------
function mdEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}
function renderMarkdown(src) {
  const lines = mdEscape(String(src ?? "")).split("\n");
  const out = [];
  let para = [],
    list = null,
    code = null,
    quote = [],
    table = null;
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${mdInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.t}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join("")}</${list.t}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((q) => `<p>${mdInline(q)}</p>`).join("")}</blockquote>`);
      quote = [];
    }
  };
  const flushTable = () => {
    if (table) {
      out.push(
        `<table><thead><tr>${table.head.map((h) => `<th>${mdInline(h.trim())}</th>`).join("")}</tr></thead><tbody>${table.rows
          .map((r) => `<tr>${r.map((c) => `<td>${mdInline(c.trim())}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      table = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
    flushTable();
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    const t = line.trim();
    if (/^```/.test(t)) {
      flushAll();
      code = [];
      continue;
    }
    if (!t) {
      flushAll();
      continue;
    }
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      flushAll();
      out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    if ((m = t.match(/^&gt;\s?(.*)$/))) {
      flushPara();
      flushList();
      flushTable();
      quote.push(m[1]);
      continue;
    }
    if ((m = t.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      flushQuote();
      flushTable();
      if (!list || list.t !== "ul") {
        flushList();
        list = { t: "ul", items: [] };
      }
      list.items.push(m[1]);
      continue;
    }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      flushQuote();
      flushTable();
      if (!list || list.t !== "ol") {
        flushList();
        list = { t: "ol", items: [] };
      }
      list.items.push(m[1]);
      continue;
    }
    if (t.startsWith("|") && t.endsWith("|")) {
      const cells = t.slice(1, -1).split("|");
      if (cells.every((c) => /^\s*:?-+:?\s*$/.test(c))) {
        if (table) table.rows = [];
        continue;
      }
      flushPara();
      flushList();
      flushQuote();
      if (!table) table = { head: cells, rows: [] };
      else table.rows.push(cells);
      continue;
    }
    flushList();
    flushQuote();
    flushTable();
    para.push(t);
  }
  if (code) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushAll();
  return out.join("");
}
// 记忆详情当前状态：条目路径、顶层 .md 清单、rollout 清单、rollout 组展开态、当前选中文件
let memDetailBase = null;
let memDetailFiles = null;
let memDetailRollouts = null;
let memRolloutOpen = true;
let animateMdKids = false; // 下一次 renderMdSide 为 rollout 组展开动作的子项播放入场动画（同步渲染后立即复位）
let memDetailActive = null; // { name, rollout }
// 当前向下延展的记忆行，及其详情区域内的左栏 / 内容元素
let memOpenRow = null;
let memSideEl = null;
let memContentEl = null;
function closeMemoryRow() {
  if (!memOpenRow) return;
  memOpenRow.classList.remove("on");
  memOpenRow.nextElementSibling?.remove(); // .mem-expand
  memOpenRow = null;
  memSideEl = null;
  memContentEl = null;
  memDetailBase = null;
  memDetailFiles = null;
  memDetailRollouts = null;
  memDetailActive = null;
}
// 点击项目行：该行向下延展出详情区；再次点击收起，点其他行则切换
function toggleMemoryRow(row, m) {
  if (memOpenRow === row) {
    closeMemoryRow();
    return;
  }
  closeMemoryRow();
  row.classList.add("on");
  const exp = document.createElement("div");
  exp.className = "mem-expand";
  exp.innerHTML =
    '<div class="mem-exp-head"><span>记忆详情</span><span class="sp"></span><button type="button" class="save-btn">收起</button></div>' +
    '<div class="mem-body"><div class="md-side"></div><div class="md-main"></div></div>';
  exp.querySelector(".save-btn").onclick = (e) => {
    e.stopPropagation();
    closeMemoryRow();
  };
  row.after(exp);
  memOpenRow = row;
  memSideEl = exp.querySelector(".md-side");
  memContentEl = exp.querySelector(".md-main");
  memRolloutOpen = true;
  memContentEl.textContent = "读取中…";
  send({ type: "memory_file_read", path: m.path });
}
// rollout 文件名隐藏 threadId 前缀，只留 slug 部分
function rolloutLabel(n) {
  return n.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-?/i, "") || n;
}
// 左栏文件树：顶层 .md + rollout_summaries 二级组（默认展开）
function renderMdSide() {
  const side = memSideEl;
  if (!side) return;
  side.replaceChildren();
  if (!memDetailFiles) return;
  const addIt = (name, rollout) => {
    const it = document.createElement("div");
    const on = memDetailActive && memDetailActive.name === name && memDetailActive.rollout === rollout;
    it.className = "md-it" + (rollout ? " sub" : " top") + (on ? " on" : "");
    if (rollout && animateMdKids) it.classList.add("kids-in"); // 组展开时子项入场
    it.textContent = rollout ? rolloutLabel(name) : name;
    it.title = name;
    it.onclick = () => {
      if (memDetailActive && memDetailActive.name === name && memDetailActive.rollout === rollout) return;
      memDetailActive = { name, rollout };
      renderMdSide();
      if (memContentEl) {
        memContentEl.textContent = "读取中…";
        memContentEl.scrollTop = 0;
      }
      send({ type: "memory_file_read", path: `${memDetailBase}/${rollout ? "rollout_summaries/" : ""}${name}` });
    };
    side.appendChild(it);
  };
  for (const f of memDetailFiles) addIt(f, false);
  if (memDetailRollouts && memDetailRollouts.length) {
    const grp = document.createElement("div");
    grp.className = "md-grp" + (memRolloutOpen ? "" : " closed");
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.innerHTML = icon("caret");
    const lb = document.createElement("span");
    lb.textContent = "rollout_summaries";
    lb.style.overflow = "hidden";
    lb.style.textOverflow = "ellipsis";
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = String(memDetailRollouts.length);
    grp.append(caret, lb, cnt);
    grp.onclick = () => {
      memRolloutOpen = !memRolloutOpen;
      if (memRolloutOpen) animateMdKids = true; // 本次 renderMdSide 的子项播放入场动画
      renderMdSide();
      animateMdKids = false;
    };
    side.appendChild(grp);
    if (memRolloutOpen) for (const f of memDetailRollouts) addIt(f, true);
  }
}
function renderMemoryDetail(msg) {
  renderMdSide();
  if (memContentEl) {
    memContentEl.innerHTML = renderMarkdown(msg.content) || '<p style="color:var(--faint)">（空文件）</p>';
    memContentEl.scrollTop = 0;
  }
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
// 磁盘资产页（子智能体）：作用域胶囊 + 列表 + 编辑器
// 每项 id 对应 index.html 中各页元素；rowsClickable=true 时列表行可点击读取进右侧编辑器
const ASSET_PAGES = {
  agent: {
    sel: "agentScopeSel", menu: "agentScopeMenu", label: "agentScopeLabel", hint: "agentsScopePath", list: "agentsList",
    editor: "agentEditor", name: "aeName", path: "aePath", newName: "aeNewName", create: "aeNew", save: "aeSave", text: "aeText", status: "aeStatus",
    rowsClickable: true,
  },
};
const assetScope = { agent: "profile" };
const assetSelPath = { agent: null };
// 把宿主三级负载归一化成 [{scope, label, dir, items}]
function assetSections(kind, data) {
  if (!data) return null;
  const sec = (scope, items, dir, label) => ({ scope, label, dir, items });
  return [
    sec("global", data.global, data.globalDir, "全局"),
    sec("profile", data.profile, data.profileDir, `Profile · ${data.profileName ?? "default"}`),
    ...data.projects.map((p) => sec(`project:${p.cwd}`, p.agents ?? [], p.dir, p.name)),
  ];
}
function assetData(kind) {
  if (!agentAssets) return null;
  return agentAssets.agents;
}
function renderAssetPage(kind) {
  const ids = ASSET_PAGES[kind];
  if (!ids) return;
  const sections = assetSections(kind, assetData(kind));
  if (!sections) return;
  if (!sections.some((s) => s.scope === assetScope[kind])) assetScope[kind] = "profile";
  const scope = assetScope[kind];
  // 胶囊菜单：全局 → Profile → 项目，组间分隔线，选中项打勾，超长项目名省略
  const menu = $(ids.menu);
  menu.replaceChildren();
  sections.forEach((s, i) => {
    if (i > 0) menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
    const mi = document.createElement("div");
    mi.className = "mi";
    mi.dataset.scope = s.scope;
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = "✓";
    ck.style.visibility = s.scope === scope ? "visible" : "hidden";
    const lb = document.createElement("span");
    lb.className = "mi-label";
    lb.textContent = s.label;
    lb.title = s.label;
    mi.appendChild(ck);
    const scopeIcon = s.scope === "global" ? icon("scopeGlobal") : s.scope === "profile" ? icon("scopeProfile") : icon("folder");
    if (scopeIcon) mi.insertAdjacentHTML("beforeend", scopeIcon);
    mi.appendChild(lb);
    menu.appendChild(mi);
  });
  // 触发器标签与当前级目录/文件提示
  const cur = sections.find((s) => s.scope === scope);
  $(ids.label).textContent = cur.label;
  $(ids.hint).textContent = cur.dir ?? "";
  fillAssetList(ids.list, cur.items, (tx, m) => assetTitle(tx, m.name, m.description || m.command || m.path));
  // 点击行读取定义进右侧编辑器（MCP 列表行是服务器条目，不可点）
  if (ids.rowsClickable) {
    const rows = $(ids.list).querySelectorAll(".srow");
    cur.items.forEach((m, i) => {
      const row = rows[i];
      if (!row) return;
      row.style.cursor = "pointer";
      row.onclick = () => {
        assetSelPath[kind] = m.path;
        assetStatus(kind, "读取中…");
        send({ type: "asset_file_read", kind, path: m.path });
      };
    });
  }
}
function assetStatus(kind, t) {
  const el = ASSET_PAGES[kind] ? $(ASSET_PAGES[kind].status) : null;
  if (el) el.textContent = t;
}
function openAssetEditor(kind, file, content) {
  const ids = ASSET_PAGES[kind];
  if (!ids) return;
  assetSelPath[kind] = file;
  $(ids.editor).classList.remove("hidden");
  $(ids.name).textContent = file.split("/").pop();
  $(ids.path).textContent = file;
  $(ids.text).value = content;
  assetStatus(kind, "");
}
// 当前作用域解析成 {scope, cwd?}
function assetScopeParts(kind) {
  const s = assetScope[kind];
  const ci = s.indexOf(":");
  return ci < 0 ? { scope: s } : { scope: s.slice(0, ci), cwd: s.slice(ci + 1) };
}
for (const [kind, ids] of Object.entries(ASSET_PAGES)) {
  wireSel(ids.sel, (mi) => {
    assetScope[kind] = mi.dataset.scope;
    assetSelPath[kind] = null;
    $(ids.editor).classList.add("hidden");
    renderAssetPage(kind);
  });
  $(ids.save).addEventListener("click", () => {
    if (!assetSelPath[kind]) return;
    assetStatus(kind, "保存中…");
    send({ type: "asset_file_write", kind, path: assetSelPath[kind], content: $(ids.text).value });
  });
  $(ids.create).addEventListener("click", () => {
    const parts = assetScopeParts(kind);
    const name = $(ids.newName).value.trim();
    if (!name) return assetStatus(kind, "先输入名称");
    send({ type: "asset_file_create", kind, name, ...parts });
  });
  if (ids.newName) {
    $(ids.newName).addEventListener("keydown", (e) => {
      if (e.key === "Enter") $(ids.create).click();
    });
  }
}

// ════════════════════════════════════════════════════════════
// 技能设置页面全新实现（仿最新设计图：多目录发现、开关、搜索、弹窗编辑）
// ════════════════════════════════════════════════════════════
let skillScope = "global"; // "global" (用户) / "profile" / "project:<cwd>"
let skillSearchQuery = "";
let skillEditingPath = null;
let skillsEventsWired = false;

function currentSkillSections() {
  const data = agentAssets?.skills;
  if (!data) return [];
  const sec = (scope, label, iconName, dir, items) => ({ scope, label, iconName, dir, items: items || [] });
  const list = [
    sec("global", "用户", "laptop", data.globalDir, data.global),
  ];
  if (data.profile && data.profile.length > 0) {
    list.push(sec("profile", `Profile · ${data.profileName ?? "default"}`, "scopeProfile", data.profileDir, data.profile));
  }
  for (const p of (data.projects || [])) {
    list.push(sec(`project:${p.cwd}`, p.name, "folder", p.dir, p.skills));
  }
  return list;
}

function getActiveSkillSection() {
  const sections = currentSkillSections();
  let found = sections.find((s) => s.scope === skillScope);
  if (!found) {
    skillScope = "global";
    found = sections[0] || { scope: "global", label: "用户", iconName: "laptop", dir: "", items: [] };
  }
  return found;
}

function renderSkillsPage() {
  const curSec = getActiveSkillSection();
  const allSections = currentSkillSections();

  // 更新作用域按钮文字与图标
  const labelEl = $("skillScopeLabel");
  if (labelEl) labelEl.textContent = curSec.label;
  const iconSpan = $("skillScopeBtn")?.querySelector(".skills-scope-icon");
  if (iconSpan) iconSpan.innerHTML = icon(curSec.iconName || "laptop", 14);

  // 渲染作用域下拉菜单
  const menu = $("skillScopeMenu");
  if (menu) {
    menu.replaceChildren();
    allSections.forEach((s, i) => {
      if (i > 0) menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.scope = s.scope;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = "✓";
      ck.style.visibility = s.scope === curSec.scope ? "visible" : "hidden";
      const lb = document.createElement("span");
      lb.className = "mi-label";
      lb.textContent = s.label;
      lb.title = s.label;
      mi.appendChild(ck);
      const ic = icon(s.iconName || "folder", 13);
      if (ic) mi.insertAdjacentHTML("beforeend", ic);
      mi.appendChild(lb);
      menu.appendChild(mi);
    });
  }

  // 统计数值
  const totalCount = curSec.items.length;
  const installedCount = curSec.items.filter((item) => item.enabled).length;

  if ($("skillsTotalCount")) $("skillsTotalCount").textContent = `技能 ${totalCount}`;
  if ($("skillsInstalledLabel")) $("skillsInstalledLabel").textContent = `已安装 ${installedCount}`;

  renderSkillsList();

  if (!skillsEventsWired) {
    initSkillsEvents();
    skillsEventsWired = true;
  }
}

function renderSkillsList() {
  closeSkillEditor(); // 重建列表前先收起延展区，避免引用已被移除的 DOM
  const curSec = getActiveSkillSection();
  const listEl = $("skillsList");
  if (!listEl) return;

  listEl.replaceChildren();

  const query = skillSearchQuery.trim().toLowerCase();
  const filtered = curSec.items.filter((item) => {
    if (!query) return true;
    return item.name.toLowerCase().includes(query) || (item.description && item.description.toLowerCase().includes(query));
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "skill-empty-row";
    empty.textContent = query ? "未找到匹配技能" : "当前作用域下暂无技能";
    listEl.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "skill-item-row";
    row.dataset.path = s.path;
    row.dataset.name = s.name;

    // 左侧图标徽标
    const badge = document.createElement("div");
    badge.className = "skill-badge";
    badge.innerHTML = icon("skills", 16);

    // 中间信息区
    const info = document.createElement("div");
    info.className = "skill-info";
    const titleRow = document.createElement("div");
    titleRow.className = "skill-title-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "skill-name";
    nameSpan.textContent = s.name;
    titleRow.appendChild(nameSpan);

    if (s.provider && s.provider !== "native") {
      const tag = document.createElement("span");
      tag.className = "skill-provider-tag";
      tag.textContent = s.provider;
      titleRow.appendChild(tag);
    }

    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = s.description || "暂无描述";
    desc.title = s.description || s.name;

    info.appendChild(titleRow);
    info.appendChild(desc);

    // 右侧控制区（Toggle 开关 + Trash 删除）
    const controls = document.createElement("div");
    controls.className = "skill-controls";

    const toggle = document.createElement("div");
    toggle.className = "tg" + (s.enabled ? " on" : "");
    toggle.title = s.enabled ? "已启用，点击禁用" : "已禁用，点击启用";
    toggle.appendChild(document.createElement("i"));

    toggle.onclick = (e) => {
      e.stopPropagation();
      const nextEnabled = !s.enabled;
      s.enabled = nextEnabled;
      toggle.classList.toggle("on", nextEnabled);
      toggle.title = nextEnabled ? "已启用，点击禁用" : "已禁用，点击启用";
      const sec = getActiveSkillSection();
      const instCount = sec.items.filter((item) => item.enabled).length;
      if ($("skillsInstalledLabel")) $("skillsInstalledLabel").textContent = `已安装 ${instCount}`;
      send({ type: "asset_skill_toggle", name: s.name, enabled: nextEnabled });
    };

    const trash = document.createElement("button");
    trash.type = "button";
    trash.className = "skill-trash-btn";
    trash.title = "删除技能";
    trash.innerHTML = icon("trash", 14);
    trash.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`确定彻底删除技能 "${s.name}" 吗？此操作将从磁盘移除该技能文件。`)) {
        send({ type: "asset_skill_delete", path: s.path });
      }
    };

    controls.appendChild(toggle);
    controls.appendChild(trash);

    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(controls);
    row.appendChild(caret);
    row.onclick = () => toggleSkillEditor(row, s);
    listEl.appendChild(row);
  }
}

function initSkillsEvents() {
  wireSel("skillScopeSel", (mi) => {
    skillScope = mi.dataset.scope;
    renderSkillsPage();
  });

  const searchInput = $("skillsSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      skillSearchQuery = e.target.value;
      renderSkillsList();
    });
  }

  const refreshBtn = $("skillsRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spin");
      send({ type: "list_agent_assets" });
      setTimeout(() => refreshBtn.classList.remove("spin"), 500);
    });
  }

  wireSel("skillsMoreSel", (mi) => {
    if (mi.id === "miOpenSkillsDir") {
      const curSec = getActiveSkillSection();
      if (curSec?.dir) send({ type: "open_folder", path: curSec.dir });
    } else if (mi.id === "miEnableAllSkills") {
      const curSec = getActiveSkillSection();
      for (const s of curSec.items) {
        if (!s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: true });
      }
    } else if (mi.id === "miDisableAllSkills") {
      const curSec = getActiveSkillSection();
      for (const s of curSec.items) {
        if (s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: false });
      }
    }
  });

  const newBtn = $("skillsNewBtn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      const name = prompt("请输入新技能名称（英文小写、数字、下划线或连字符）：");
      if (!name || !name.trim()) return;
      const cleanName = name.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleanName)) {
        toast("名称格式无效，仅允许小写字母、数字、-、_");
        return;
      }
      const curSec = getActiveSkillSection();
      const parts = curSec.scope.includes(":")
        ? { scope: curSec.scope.split(":")[0], cwd: curSec.scope.slice(curSec.scope.indexOf(":") + 1) }
        : { scope: curSec.scope };
      send({ type: "asset_file_create", kind: "skill", name: cleanName, ...parts });
    });
  }
}

// 当前向下延展的技能行；延展区即该行的行内编辑器（textarea + 操作行），同记忆页模式
let skillOpenRow = null;
function closeSkillEditor() {
  if (!skillOpenRow) return;
  skillOpenRow.classList.remove("on");
  skillOpenRow.nextElementSibling?.remove(); // .mem-expand
  skillOpenRow = null;
  skillEditingPath = null;
}
// 点击技能行：该行向下延展出编辑区；再次点击收起，点其他行则切换
function toggleSkillEditor(row, skill) {
  if (skillOpenRow === row) {
    closeSkillEditor();
    return;
  }
  closeSkillEditor();
  row.classList.add("on");
  const exp = document.createElement("div");
  exp.className = "mem-expand";
  exp.innerHTML =
    '<div class="mem-exp-head"><span>编辑技能</span><span class="sub" id="skEditPath"></span><span class="sp"></span><button type="button" class="save-btn">收起</button></div>' +
    '<div class="sem-body"><textarea id="skEditText" spellcheck="false" placeholder="在此编辑 SKILL.md 内容..."></textarea></div>' +
    '<div class="sem-foot"><span class="sem-status" id="skEditStatus"></span><span class="sp"></span><button type="button" class="confirm-btn danger" id="skEditDelete">删除</button><button type="button" class="confirm-btn" id="skEditSave">保存</button></div>';
  exp.querySelector(".save-btn").onclick = (e) => {
    e.stopPropagation();
    closeSkillEditor();
  };
  exp.querySelector("#skEditPath").textContent = skill.path;
  exp.querySelector("#skEditText").value = "读取中…";
  exp.querySelector("#skEditSave").onclick = () => {
    if (!skillEditingPath) return;
    if ($("skEditStatus")) $("skEditStatus").textContent = "保存中…";
    send({ type: "asset_file_write", kind: "skill", path: skillEditingPath, content: $("skEditText").value });
  };
  exp.querySelector("#skEditDelete").onclick = () => {
    if (!skillEditingPath) return;
    if (confirm(`确定删除技能 "${skill.name}" 吗？此操作不可撤销。`)) {
      send({ type: "asset_skill_delete", path: skillEditingPath });
      closeSkillEditor();
    }
  };
  row.after(exp);
  skillOpenRow = row;
  skillEditingPath = skill.path;
  send({ type: "asset_file_read", kind: "skill", path: skill.path });
}

// ════════════════════════════════════════════════════════════
// MCP 服务器设置页面全新实现（多源全量发现、红绿灯状态、iOS 开关、实时搜索、编辑弹窗）
// ════════════════════════════════════════════════════════════
let mcpScope = "all"; // "all" / "profile" / "project:<cwd>"
let mcpSearchQuery = "";
let mcpEditingServer = null;
let mcpEventsWired = false;
let mcpFormTransport = "stdio"; // "stdio" | "http" | "sse"

function currentMcpScopes() {
  const mcp = agentAssets?.mcp;
  if (!mcp || !Array.isArray(mcp.scopes)) {
    return [{ id: "all", name: "全部工作区", count: 0 }];
  }
  return mcp.scopes;
}

function getActiveMcpScope() {
  const scopes = currentMcpScopes();
  let found = scopes.find((s) => s.id === mcpScope);
  if (!found) {
    mcpScope = "all";
    found = scopes[0] || { id: "all", name: "全部工作区", count: 0 };
  }
  return found;
}

function getScopedMcpServers() {
  const allServers = agentAssets?.mcp?.servers || [];
  if (mcpScope === "all") return allServers;
  if (mcpScope === "profile") return allServers.filter((s) => s.scope === "profile");
  return allServers.filter((s) => s.scope === mcpScope);
}

function renderMcpPage() {
  const curScope = getActiveMcpScope();
  const allScopes = currentMcpScopes();
  const scopeServers = getScopedMcpServers();

  // 更新作用域按钮文字与图标
  const labelEl = $("mcpScopeLabel");
  if (labelEl) labelEl.textContent = curScope.name;
  const iconSpan = $("mcpScopeBtn")?.querySelector(".mcp-scope-icon");
  if (iconSpan) {
    const iconName = curScope.id === "profile" ? "scopeProfile" : "folder";
    iconSpan.innerHTML = icon(iconName, 14);
  }

  // 渲染作用域下拉菜单
  const menu = $("mcpScopeMenu");
  if (menu) {
    menu.replaceChildren();
    allScopes.forEach((s, i) => {
      if (i > 0 && (s.id === "profile" || (allScopes[i - 1].id === "profile" && s.id.startsWith("project:")))) {
        menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
      }
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.scope = s.id;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = "✓";
      ck.style.visibility = s.id === curScope.id ? "visible" : "hidden";
      const lb = document.createElement("span");
      lb.className = "mi-label";
      lb.textContent = s.name;
      lb.title = s.name;
      mi.appendChild(ck);
      const ic = icon(s.id === "profile" ? "scopeProfile" : "folder", 13);
      if (ic) mi.insertAdjacentHTML("beforeend", ic);
      mi.appendChild(lb);
      menu.appendChild(mi);
    });
  }

  // 统计数值
  const totalCount = scopeServers.length;
  const installedCount = scopeServers.filter((s) => s.enabled).length;
  if ($("mcpTotalCount")) $("mcpTotalCount").textContent = `MCP ${totalCount}`;
  if ($("mcpInstalledLabel")) $("mcpInstalledLabel").textContent = `已安装 ${installedCount}`;

  renderMcpList();

  if (!mcpEventsWired) {
    initMcpEvents();
    mcpEventsWired = true;
  }
}

function renderMcpList() {
  closeMcpEditor(); // 重建列表前先收起延展区，避免引用已被移除的 DOM
  const listEl = $("mcpServerList");
  if (!listEl) return;

  listEl.replaceChildren();

  const scopeServers = getScopedMcpServers();
  const q = mcpSearchQuery.trim().toLowerCase();
  const filtered = scopeServers.filter((s) => {
    if (!q) return true;
    const nameMatch = s.name.toLowerCase().includes(q);
    const cmdMatch = s.command && s.command.toLowerCase().includes(q);
    const argsMatch = Array.isArray(s.args) && s.args.some((a) => a.toLowerCase().includes(q));
    const urlMatch = s.url && s.url.toLowerCase().includes(q);
    const errMatch = s.error && s.error.toLowerCase().includes(q);
    return nameMatch || cmdMatch || argsMatch || urlMatch || errMatch;
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "mcp-empty-row";
    empty.textContent = q ? "未找到匹配的 MCP 服务器" : "当前工作区下暂无 MCP 服务器";
    listEl.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "mcp-server-row" + (s.enabled ? "" : " disabled");
    row.dataset.name = s.name;

    // 状态点样式与标题
    let dotClass = "off";
    let dotTitle = "已禁用";
    if (s.enabled) {
      if (s.status === "connected") {
        dotClass = "ok";
        dotTitle = "运行中 / 已连接";
      } else if (s.status === "error") {
        dotClass = "err";
        dotTitle = "连接异常";
      } else {
        dotClass = "ok";
        dotTitle = "就绪";
      }
    }

    // 左侧图标容器
    const iconBox = document.createElement("div");
    iconBox.className = "mcp-icon-box";
    iconBox.innerHTML = icon("mcp", 18);
    const statusDot = document.createElement("span");
    statusDot.className = `mcp-status-dot ${dotClass}`;
    statusDot.title = dotTitle;
    iconBox.appendChild(statusDot);

    // 中间服务信息
    const info = document.createElement("div");
    info.className = "mcp-server-info";
    info.title = "点击查看或编辑配置";

    const head = document.createElement("div");
    head.className = "mcp-server-head";
    const nameSpan = document.createElement("span");
    nameSpan.className = "mcp-server-name";
    nameSpan.textContent = s.name;
    head.appendChild(nameSpan);

    // 协议或来源徽标
    if (s.transport) {
      const trBadge = document.createElement("span");
      trBadge.className = "mcp-server-badge";
      trBadge.textContent = s.transport;
      head.appendChild(trBadge);
    }
    if (mcpScope === "all") {
      const srcName = s.projectName || s.source?.providerName;
      if (srcName) {
        const srcBadge = document.createElement("span");
        srcBadge.className = "mcp-server-badge";
        srcBadge.textContent = srcName;
        head.appendChild(srcBadge);
      }
    }
    info.appendChild(head);

    // 命令或 URL
    const cmdLine = document.createElement("div");
    cmdLine.className = "mcp-server-cmd";
    const cmdText = s.command ? [s.command, ...(s.args || [])].filter(Boolean).join(" ") : (s.url || "");
    cmdLine.textContent = cmdText;
    cmdLine.title = cmdText;
    info.appendChild(cmdLine);

    // 错误详情展示（红字 + ⓘ 提示）
    if (s.enabled && s.status === "error" && s.error) {
      const errDiv = document.createElement("div");
      errDiv.className = "mcp-server-err";
      errDiv.innerHTML = `<span class="mcp-err-icon" title="错误详情">ⓘ</span><span>${escapeHtml(s.error)}</span>`;
      info.appendChild(errDiv);
    }

    // 右侧开关控制
    const ctrl = document.createElement("div");
    ctrl.className = "mcp-server-ctrl";

    const toggle = document.createElement("div");
    toggle.className = "tg" + (s.enabled ? " on" : "");
    toggle.title = s.enabled ? "已启用，点击禁用" : "已禁用，点击启用";
    toggle.appendChild(document.createElement("i"));

    toggle.onclick = (e) => {
      e.stopPropagation();
      const nextEnabled = !s.enabled;
      s.enabled = nextEnabled;
      toggle.classList.toggle("on", nextEnabled);
      toggle.title = nextEnabled ? "已启用，点击禁用" : "已禁用，点击启用";
      row.classList.toggle("disabled", !nextEnabled);
      statusDot.className = `mcp-status-dot ${nextEnabled ? (s.status === "error" ? "err" : "ok") : "off"}`;
      statusDot.title = nextEnabled ? (s.status === "error" ? "连接异常" : "运行中") : "已禁用";

      const curScopeServers = getScopedMcpServers();
      const instCount = curScopeServers.filter((item) => item.enabled).length;
      if ($("mcpInstalledLabel")) $("mcpInstalledLabel").textContent = `已安装 ${instCount}`;

      send({
        type: "set_mcp_server_enabled",
        name: s.name,
        enabled: nextEnabled,
        cwd: s.cwd,
        sourcePath: s.source?.path,
      });
    };

    ctrl.appendChild(toggle);

    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");

    row.appendChild(iconBox);
    row.appendChild(info);
    row.appendChild(ctrl);
    row.appendChild(caret);
    row.onclick = () => toggleMcpEditor(row, s);
    listEl.appendChild(row);
  }
}

function handleMcpServerTested(msg) {
  const statusEl = $("mcpModalStatus");
  const testBtn = $("mcpModalTestBtn");
  if (testBtn) {
    testBtn.disabled = false;
    testBtn.textContent = "测试连接";
  }
  if (statusEl) {
    if (msg.status === "ok") {
      statusEl.style.color = "var(--green)";
      statusEl.textContent = "连接成功";
    } else {
      statusEl.style.color = "var(--err)";
      statusEl.textContent = msg.error || "连接失败";
    }
  }

  // 同步更新本地状态与对应行状态点（局部更新，不重建列表——重建会收起行内延展的编辑区）
  const allServers = agentAssets?.mcp?.servers || [];
  const target = allServers.find((s) => s.name === msg.name);
  if (target) {
    target.status = msg.status === "ok" ? "connected" : "error";
    target.error = msg.error;
    const row = $("mcpServerList")?.querySelector(`.mcp-server-row[data-name="${CSS.escape(msg.name)}"]`);
    const dot = row?.querySelector(".mcp-status-dot");
    if (dot) {
      dot.className = `mcp-status-dot ${target.enabled ? (msg.status === "ok" ? "ok" : "err") : "off"}`;
      dot.title = msg.status === "ok" ? "运行中 / 已连接" : "连接异常";
    }
  }

  toast(msg.status === "ok" ? `MCP [${msg.name}] 连接成功` : `MCP [${msg.name}] 探测失败: ${msg.error || ""}`);
}

function setMcpFormTransport(type) {
  mcpFormTransport = type;
  const pills = document.querySelectorAll("#mcpFormTypePills .mcp-type-pill");
  pills.forEach((p) => p.classList.toggle("on", p.dataset.type === type));

  const stdioSec = $("mcpFieldsStdio");
  const remoteSec = $("mcpFieldsRemote");
  if (type === "stdio") {
    stdioSec?.classList.remove("hidden");
    remoteSec?.classList.add("hidden");
  } else {
    stdioSec?.classList.add("hidden");
    remoteSec?.classList.remove("hidden");
  }
}

function initMcpEvents() {
  wireSel("mcpScopeSel", (mi) => {
    mcpScope = mi.dataset.scope;
    renderMcpPage();
  });

  const searchInput = $("mcpSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      mcpSearchQuery = e.target.value;
      renderMcpList();
    });
  }

  const refreshBtn = $("mcpRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spin");
      send({ type: "list_agent_assets" });
      setTimeout(() => refreshBtn.classList.remove("spin"), 500);
    });
  }

  wireSel("mcpMoreSel", (mi) => {
    if (mi.id === "miOpenCurrentMcpConfig") {
      const curScope = getActiveMcpScope();
      if (curScope?.dir) {
        send({ type: "open_folder", path: curScope.dir });
      } else if (agentAssets?.mcp?.userMcpPath) {
        send({ type: "open_folder", path: agentAssets.mcp.userMcpPath });
      }
    } else if (mi.id === "miOpenUserMcpConfig") {
      if (agentAssets?.mcp?.userMcpPath) {
        send({ type: "open_folder", path: agentAssets.mcp.userMcpPath });
      }
    } else if (mi.id === "miRetestAllMcp") {
      const curServers = getScopedMcpServers().filter((s) => s.enabled);
      if (!curServers.length) {
        toast("当前作用域无启用的 MCP 服务器");
        return;
      }
      toast(`开始检测 ${curServers.length} 个 MCP 服务器连接…`);
      for (const s of curServers) {
        send({ type: "test_mcp_server", name: s.name, server: s });
      }
    }
  });

  // 新建：在列表顶部插入临时行并向下延展编辑区（保存后 host 推送重建列表，临时行随之消失）
  $("mcpNewBtn")?.addEventListener("click", () => {
    closeMcpEditor();
    const listEl = $("mcpServerList");
    if (!listEl) return;
    listEl.querySelector(".mcp-empty-row")?.remove();
    const row = document.createElement("div");
    row.className = "mcp-server-row";
    row.dataset.temp = "1";
    const iconBox = document.createElement("div");
    iconBox.className = "mcp-icon-box";
    iconBox.innerHTML = icon("mcp", 18);
    const info = document.createElement("div");
    info.className = "mcp-server-info";
    info.innerHTML =
      '<div class="mcp-server-head"><span class="mcp-server-name">新服务器</span></div>' +
      '<div class="mcp-server-cmd">填写配置后保存</div>';
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");
    row.append(iconBox, info, caret);
    listEl.prepend(row);
    toggleMcpEditor(row, null);
  });
}

function buildMcpFormServerPayload(name) {
  if (mcpFormTransport === "stdio") {
    const cmd = $("mcpFormCmd")?.value.trim();
    if (!cmd) {
      toast("请输入执行命令");
      return null;
    }
    const rawArgs = $("mcpFormArgs")?.value.trim();
    const args = rawArgs
      ? rawArgs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
    const rawEnv = $("mcpFormEnv")?.value.trim();
    const env = {};
    if (rawEnv) {
      for (const line of rawEnv.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          const k = line.slice(0, eq).trim();
          const v = line.slice(eq + 1).trim();
          if (k) env[k] = v;
        }
      }
    }
    return { name, transport: "stdio", command: cmd, args, env };
  } else {
    const url = $("mcpFormUrl")?.value.trim();
    if (!url) {
      toast("请输入服务 URL");
      return null;
    }
    const rawHdrs = $("mcpFormHeaders")?.value.trim();
    const headers = {};
    if (rawHdrs) {
      for (const line of rawHdrs.split(/\r?\n/)) {
        const col = line.indexOf(":");
        if (col > 0) {
          const k = line.slice(0, col).trim();
          const v = line.slice(col + 1).trim();
          if (k) headers[k] = v;
        }
      }
    }
    return { name, transport: mcpFormTransport, url, headers };
  }
}

// MCP 编辑表单字段模板（id 与既有填充/取值逻辑保持一致；textarea 的 \n 对应原 HTML 的 &#10; 占位换行）
const MCP_FORM_TEMPLATE =
  '<div class="mcp-form-group"><label class="mcp-form-label">服务名称 <span class="req">*</span></label>' +
  '<input type="text" class="mcp-form-input" id="mcpFormName" placeholder="例如: codegraph、atlassian" spellcheck="false" /></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">保存目标</label><select class="mcp-form-select" id="mcpFormScope"></select></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">传输协议</label><div class="mcp-type-pills" id="mcpFormTypePills">' +
  '<button type="button" class="mcp-type-pill on" data-type="stdio">stdio (本地命令)</button>' +
  '<button type="button" class="mcp-type-pill" data-type="http">http (远程服务)</button>' +
  '<button type="button" class="mcp-type-pill" data-type="sse">sse (流式服务)</button></div></div>' +
  '<div id="mcpFieldsStdio">' +
  '<div class="mcp-form-group"><label class="mcp-form-label">执行命令 <span class="req">*</span></label>' +
  '<input type="text" class="mcp-form-input" id="mcpFormCmd" placeholder="例如: node、npx、uvx、python3" spellcheck="false" /></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">命令参数 (空格或换行分隔)</label>' +
  '<textarea class="mcp-form-textarea" id="mcpFormArgs" rows="2" placeholder="-y\n@upstash/context7-mcp" spellcheck="false"></textarea></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">环境变量 (KEY=VALUE，每行一个)</label>' +
  '<textarea class="mcp-form-textarea" id="mcpFormEnv" rows="2" placeholder="API_KEY=xxx" spellcheck="false"></textarea></div></div>' +
  '<div id="mcpFieldsRemote" class="hidden">' +
  '<div class="mcp-form-group"><label class="mcp-form-label">服务 URL <span class="req">*</span></label>' +
  '<input type="text" class="mcp-form-input" id="mcpFormUrl" placeholder="https://... 或 http://localhost:53333/mcp" spellcheck="false" /></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">请求头 (Header: Value，每行一个)</label>' +
  '<textarea class="mcp-form-textarea" id="mcpFormHeaders" rows="2" placeholder="Authorization: Bearer xxx" spellcheck="false"></textarea></div></div>';

// 当前向下延展的 MCP 行（含新建临时行）；延展区即该行的行内编辑表单，同记忆页模式
let mcpOpenRow = null;
function closeMcpEditor() {
  if (!mcpOpenRow) return;
  const wasTemp = mcpOpenRow.dataset.temp === "1";
  mcpOpenRow.classList.remove("on");
  mcpOpenRow.nextElementSibling?.remove(); // .mem-expand
  mcpOpenRow = null;
  mcpEditingServer = null;
  if (wasTemp) renderMcpList(); // 新建未保存：移除临时行后重建列表（恢复空态）
}
// 点击 MCP 行：该行向下延展出编辑表单；再次点击收起，点其他行则切换；server 为 null 表示新建
function toggleMcpEditor(row, server) {
  if (mcpOpenRow === row) {
    closeMcpEditor();
    return;
  }
  closeMcpEditor();
  mcpEditingServer = server;
  row.classList.add("on");
  const exp = document.createElement("div");
  exp.className = "mem-expand";
  exp.innerHTML =
    '<div class="mem-exp-head"><span id="mcpModalTitle"></span><span class="sub" id="mcpModalSub"></span><span class="sp"></span><button type="button" class="save-btn">收起</button></div>' +
    '<div class="sem-body form">' + MCP_FORM_TEMPLATE + '</div>' +
    '<div class="sem-foot"><span class="sem-status" id="mcpModalStatus"></span><button type="button" class="confirm-btn" id="mcpModalTestBtn">测试连接</button><span class="sp"></span><button type="button" class="confirm-btn danger hidden" id="mcpModalDeleteBtn">删除</button><button type="button" class="confirm-btn" id="mcpModalSaveBtn">保存</button></div>';
  exp.querySelector(".save-btn").onclick = (e) => {
    e.stopPropagation();
    closeMcpEditor();
  };
  row.after(exp);
  mcpOpenRow = row;
  fillMcpForm(server);
  bindMcpEditorEvents(exp);
}

// 按传入 server（或 null=新建）填充延展区表单
function fillMcpForm(server) {
  // 填充作用域下拉框
  const scopeSel = $("mcpFormScope");
  if (scopeSel) {
    scopeSel.replaceChildren();
    const scopes = currentMcpScopes();
    for (const sc of scopes) {
      if (sc.id === "all") continue;
      const opt = document.createElement("option");
      opt.value = sc.id;
      opt.textContent = sc.name;
      scopeSel.appendChild(opt);
    }
  }

  const titleEl = $("mcpModalTitle");
  const subEl = $("mcpModalSub");
  const nameInput = $("mcpFormName");
  const deleteBtn = $("mcpModalDeleteBtn");
  const statusEl = $("mcpModalStatus");
  if (statusEl) statusEl.textContent = "";

  if (server) {
    if (titleEl) titleEl.textContent = "编辑 MCP 服务器";
    if (subEl) subEl.textContent = `${server.name} · ${server.source?.providerName || "配置文件"}`;
    if (nameInput) {
      nameInput.value = server.name;
      nameInput.disabled = true;
    }
    if (scopeSel && server.scope) {
      scopeSel.value = server.scope;
    }
    setMcpFormTransport(server.transport || "stdio");

    if ($("mcpFormCmd")) $("mcpFormCmd").value = server.command || "";
    if ($("mcpFormArgs")) $("mcpFormArgs").value = (server.args || []).join("\n");
    if ($("mcpFormEnv")) {
      $("mcpFormEnv").value = server.env
        ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n")
        : "";
    }
    if ($("mcpFormUrl")) $("mcpFormUrl").value = server.url || "";
    if ($("mcpFormHeaders")) {
      $("mcpFormHeaders").value = server.headers
        ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
        : "";
    }
    deleteBtn?.classList.remove("hidden");
  } else {
    if (titleEl) titleEl.textContent = "新建 MCP 服务器";
    if (subEl) subEl.textContent = "配置标准 Model Context Protocol 服务";
    if (nameInput) {
      nameInput.value = "";
      nameInput.disabled = false;
    }
    if (scopeSel) {
      scopeSel.value = mcpScope === "all" ? "profile" : mcpScope;
    }
    setMcpFormTransport("stdio");

    if ($("mcpFormCmd")) $("mcpFormCmd").value = "";
    if ($("mcpFormArgs")) $("mcpFormArgs").value = "";
    if ($("mcpFormEnv")) $("mcpFormEnv").value = "";
    if ($("mcpFormUrl")) $("mcpFormUrl").value = "";
    if ($("mcpFormHeaders")) $("mcpFormHeaders").value = "";
    deleteBtn?.classList.add("hidden");
  }
}

// 延展区内的测试/保存/删除与协议切换绑定（元素随展开新建，每次展开重新绑定）
function bindMcpEditorEvents(exp) {
  exp.querySelectorAll("#mcpFormTypePills .mcp-type-pill").forEach((pill) => {
    pill.addEventListener("click", () => setMcpFormTransport(pill.dataset.type));
  });

  // 测试连接
  exp.querySelector("#mcpModalTestBtn").onclick = () => {
    const name = $("mcpFormName")?.value.trim();
    if (!name) {
      toast("请先输入服务名称");
      return;
    }
    const serverObj = buildMcpFormServerPayload(name);
    if (!serverObj) return;

    const testBtn = $("mcpModalTestBtn");
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
    }
    const statusEl = $("mcpModalStatus");
    if (statusEl) {
      statusEl.style.color = "var(--dim)";
      statusEl.textContent = "正在连接测试…";
    }
    send({ type: "test_mcp_server", name, server: serverObj });
  };

  // 保存配置
  exp.querySelector("#mcpModalSaveBtn").onclick = () => {
    const name = $("mcpFormName")?.value.trim();
    if (!name) {
      toast("请先输入服务名称");
      return;
    }
    const scope = $("mcpFormScope")?.value || "profile";
    const serverObj = buildMcpFormServerPayload(name);
    if (!serverObj) return;

    // 格式化为 MCP 服务器配置对象
    const config = {
      type: mcpFormTransport,
    };
    if (mcpFormTransport === "stdio") {
      config.command = serverObj.command;
      if (serverObj.args && serverObj.args.length) config.args = serverObj.args;
      if (serverObj.env && Object.keys(serverObj.env).length) config.env = serverObj.env;
    } else {
      config.url = serverObj.url;
      if (serverObj.headers && Object.keys(serverObj.headers).length) config.headers = serverObj.headers;
    }

    send({ type: "save_mcp_server", name, config, scope });
    closeMcpEditor();
    toast(`已保存 MCP 服务器 "${name}"`);
  };

  // 删除配置
  exp.querySelector("#mcpModalDeleteBtn").onclick = () => {
    if (!mcpEditingServer) return;
    const name = mcpEditingServer.name;
    if (confirm(`确定删除 MCP 服务器 "${name}" 吗？`)) {
      send({
        type: "delete_mcp_server",
        name,
        sourcePath: mcpEditingServer.source?.path,
      });
      closeMcpEditor();
      toast(`已请求删除 "${name}"`);
    }
  };
}

function renderAssetPages() {
  const a = agentAssets;
  if (!a) return;
  closeMemoryRow(); // 重建列表前先收起延展区，避免引用已被移除的 DOM
  // 记忆列表：标题优先展示项目末级目录名（host 端按 cwd 编码匹配），点击行向下延展出详情
  fillAssetList("memoryList", a.memories, (tx, m) => assetTitle(tx, m.project ?? m.name, m.path));
  const memRows = $("memoryList").querySelectorAll(".srow");
  a.memories.forEach((m, i) => {
    const row = memRows[i];
    if (!row) return;
    row.classList.add("mem-row");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");
    row.appendChild(caret);
    row.onclick = () => toggleMemoryRow(row, m);
  });
  fillAssetList("commandsList", a.commands, (tx, m) => assetTitle(tx, "/" + m.name, m.path));
  fillAssetList("hooksList", a.hooks, (tx, m) => assetTitle(tx, m.name, (m.phase || "") + " · " + m.path));
  renderAssetPage("agent");
  renderSkillsPage();
  renderMcpPage();
}
// 「添加供应商」视图:右卡三列等宽圆角卡片,列出全部受支持供应商
// 发起 OMP 登录流程(host 侧 AuthStorage.login,浏览器授权)
let loginReqId = 0;
function startProviderLogin(id) {
  if (loginBusy) {
    toast("已有登录流程进行中，可点击底部进度条取消");
    return;
  }
  loginBusy = true;
  loginReqId++;
  send({ type: "provider_login", provider: id, reqId: loginReqId });
  showLoginBanner(`${id}：正在启动登录…`);
}
// 登录进行中底部进度条:显示状态 + 取消按钮(关浏览器页后可手动中断)
function showLoginBanner(text) {
  let b = $("loginBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "loginBanner";
    b.className = "login-banner";
    const msg = document.createElement("span");
    msg.id = "loginBannerMsg";
    const cancel = document.createElement("button");
    cancel.className = "save-btn";
    cancel.textContent = "取消登录";
    cancel.onclick = () => send({ type: "provider_login_cancel" });
    b.append(msg, cancel);
    document.body.appendChild(b);
  }
  $("loginBannerMsg").textContent = text;
}
function hideLoginBanner() {
  $("loginBanner")?.remove();
}
// 登录流程的粘贴码弹窗(host 经 login_prompt 中转)
function closeLoginPrompt() {
  $("loginPromptMask")?.remove();
}
function showLoginPrompt(msg) {
  closeLoginPrompt();
  const wrap = document.createElement("div");
  wrap.className = "lp-mask";
  wrap.id = "loginPromptMask";
  const box = document.createElement("div");
  box.className = "lp-box";
  const t = document.createElement("div");
  t.className = "lp-msg";
  t.textContent = msg.message || "请输入授权码：";
  const inp = document.createElement("input");
  inp.className = "inp";
  if (msg.secret) inp.type = "password";
  inp.placeholder = "粘贴授权码或完整回调 URL";
  const row = document.createElement("div");
  row.className = "lp-row";
  const ok = document.createElement("button");
  ok.className = "save-btn";
  ok.textContent = "确定";
  const cancel = document.createElement("button");
  cancel.className = "save-btn";
  cancel.textContent = "取消";
  ok.onclick = () => {
    send({ type: "login_prompt_reply", id: msg.id, text: inp.value });
    closeLoginPrompt();
  };
  cancel.onclick = () => {
    send({ type: "login_prompt_reply", id: msg.id, text: "" });
    closeLoginPrompt();
  };
  row.append(ok, cancel);
  box.append(t, inp, row);
  wrap.appendChild(box);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) closeLoginPrompt(); // 仅关闭弹窗,host 侧流程仍等输入
  });
  document.body.appendChild(wrap);
  inp.focus();
}
function renderAddProviderView() {
  const detail = $("mpDetail");
  if (!detail) return;
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const hb = document.createElement("b");
  hb.textContent = "＋ 添加供应商";
  head.appendChild(hb);
  detail.appendChild(head);
  const note = document.createElement("div");
  note.className = "set-group-desc";
  note.textContent = "点击供应商卡片进入详情页，可选登录或配置 API key；最后一个「手动添加供应商」走配置层 models.yml。";
  detail.appendChild(note);
  if (!allProvidersCache) {
    const loading = document.createElement("div");
    loading.className = "set-group-desc";
    loading.textContent = "读取中…";
    detail.appendChild(loading);
    send({ type: "get_all_providers" });
    return;
  }
  const configured = new Set(modelCatalog.map((m) => m.provider));
  const grid = document.createElement("div");
  grid.className = "ap-grid";
  for (const p of allProvidersCache) {
    const card = document.createElement("div");
    card.className = "ap-card";
    const ic = document.createElement("span");
    ic.className = "pv-ic";
    ic.textContent = PROV_IC[p.id] || "✦";
    const nm = document.createElement("span");
    nm.className = "ap-name";
    nm.textContent = p.id;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = configured.has(p.id) ? "已配置" : p.label;
    card.append(ic, nm, tag);
    // 点击进入详情页:支持登录的供应商让用户二选一(登录 / API key),仅 key 的直达表单
    card.onclick = () => {
      mpDetailProv = p;
      renderProviderDetail();
    };
    grid.appendChild(card);
  }
  // 末位固定卡片:手动添加 = 配置层 models.yml
  const manual = document.createElement("div");
  manual.className = "ap-card ap-manual";
  const mic = document.createElement("span");
  mic.className = "pv-ic";
  mic.textContent = "✎";
  const mnm = document.createElement("span");
  mnm.className = "ap-name";
  mnm.textContent = "手动添加供应商";
  const mtag = document.createElement("span");
  mtag.className = "tag";
  mtag.textContent = "models.yml";
  manual.append(mic, mnm, mtag);
  manual.onclick = () => {
    send({ type: "open_models_config" });
    toast("已打开 models.yml，保存后回来刷新即可");
  };
  grid.appendChild(manual);
  detail.appendChild(grid);
}
// 供应商详情页:登录 与 配置 API key 二选一
function renderProviderDetail() {
  const detail = $("mpDetail");
  const p = mpDetailProv;
  if (!detail || !p) return;
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const back = document.createElement("button");
  back.className = "save-btn";
  back.textContent = "← 返回";
  back.onclick = () => {
    mpDetailProv = null;
    renderAddProviderView();
  };
  const hb = document.createElement("b");
  hb.textContent = `${PROV_IC[p.id] || "✦"} ${p.id}`;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = p.label;
  head.append(back, hb, tag);
  detail.appendChild(head);
  // 登录方式(供应商有 OMP 登录流时提供)
  if (p.login) {
    const loginCard = document.createElement("div");
    loginCard.className = "ap-card pd-login";
    const lic = document.createElement("span");
    lic.className = "pv-ic";
    lic.textContent = "🌐";
    const lnm = document.createElement("span");
    lnm.className = "ap-name";
    lnm.textContent = "登录";
    const ltag = document.createElement("span");
    ltag.className = "tag";
    ltag.textContent = "浏览器授权";
    loginCard.append(lic, lnm, ltag);
    loginCard.onclick = () => startProviderLogin(p.id);
    detail.appendChild(loginCard);
    // 分隔线:短于卡片宽度,左右不触边;不支持登录的供应商不渲染
    const div = document.createElement("div");
    div.className = "pd-div";
    detail.appendChild(div);
  }
  // API key 方式(所有供应商可用):标签在上,圆角输入框在下
  const keyWrap = document.createElement("div");
  keyWrap.className = "pd-key";
  const keyTx = document.createElement("div");
  keyTx.className = "srow-tx";
  const keyB = document.createElement("b");
  keyB.textContent = "API Key";
  const keySpan = document.createElement("span");
  keySpan.textContent = "粘贴供应商的 API key，保存后立即生效。";
  keyTx.append(keyB, keySpan);
  const keyRow = document.createElement("div");
  keyRow.className = "pd-key-row";
  const keyInp = document.createElement("input");
  keyInp.className = "inp";
  keyInp.type = "password";
  keyInp.placeholder = "sk-…";
  keyInp.id = "pdKeyInput";
  const keySave = document.createElement("button");
  keySave.className = "save-btn";
  keySave.textContent = "保存";
  keySave.onclick = () => {
    const key = keyInp.value.trim();
    if (!key) {
      toast("请输入 API key");
      return;
    }
    send({ type: "provider_set_key", provider: p.id, key });
  };
  keyRow.append(keyInp, keySave);
  keyWrap.append(keyTx, keyRow);
  detail.appendChild(keyWrap);
}
function renderModelPage() {
  const list = $("mpList");
  const detail = $("mpDetail");
  if (!list || !detail) return;
  if (mpAddView) {
    renderAddProviderView();
    return;
  }
  const groups = new Map();
  for (const m of modelCatalog) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  if (!selectedProvider || !groups.has(selectedProvider)) selectedProvider = groups.keys().next().value ?? null;
  list.innerHTML = "";
  const pipe = document.createElement("div");
  pipe.className = "set-sec mp-grp";
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
  // 分组:登录/API key 凭证在上,models.yml 配置在下,中间横线 + 组标识
  const credEntries = [];
  const configEntries = [];
  for (const entry of groups) {
    (entry[1][0]?.authSource === "config" ? configEntries : credEntries).push(entry);
  }
  const renderGroup = (label, entries) => {
    if (!entries.length) return;
    if (label) {
      const g = document.createElement("div");
      g.className = "set-sec mp-grp";
      g.textContent = label;
      list.appendChild(g);
    }
    for (const [prov, models] of entries) {
      const row = document.createElement("div");
      row.className = "pv" + (prov === selectedProvider ? " on" : "");
      const ic = document.createElement("span");
      ic.className = "pv-ic";
      ic.textContent = PROV_IC[prov] || "✦";
      row.appendChild(ic);
      const nm = document.createElement("span");
      nm.className = "pv-name";
      nm.textContent = prov;
      row.appendChild(nm);
      if (models.some((m) => m.enabled)) {
        const dot = document.createElement("span");
        dot.className = "dot";
        row.appendChild(dot);
      }
      row.onclick = () => {
        mpAddView = false;
        selectedProvider = prov;
        renderModelPage();
      };
      list.appendChild(row);
    }
  };
  renderGroup("", credEntries);
  if (credEntries.length && configEntries.length) {
    const hr = document.createElement("div");
    hr.className = "pd-div mp-div";
    list.appendChild(hr);
  }
  renderGroup("配置文件", configEntries);
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
  // 供应商配额:命中 host 侧 60s 缓存,切换供应商即重查
  const limSec = document.createElement("div");
  limSec.id = "mpLimSec";
  limSec.className = "mp-lim";
  limSec.textContent = "配额读取中…";
  detail.appendChild(limSec);
  send({ type: "get_provider_limits", provider: selectedProvider });
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
      // 上下文按二进制单位:204800 → 200k、1048576 → 1M
      t.textContent = m.context >= 1048576 ? Math.round(m.context / 1048576) + "M" : m.context >= 1024 ? Math.round(m.context / 1024) + "k" : String(m.context);
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
$("uiFsMinus")?.addEventListener("click", () => stepFont("uiFontSize", -1, 11, 18, "uiFsVal"));
$("uiFsPlus")?.addEventListener("click", () => stepFont("uiFontSize", 1, 11, 18, "uiFsVal"));
$("codeFsMinus")?.addEventListener("click", () => stepFont("codeFontSize", -1, 10, 18, "codeFsVal"));
$("codeFsPlus")?.addEventListener("click", () => stepFont("codeFontSize", 1, 10, 18, "codeFsVal"));
function saveDesktopField(field, inputId) {
  const env = { ...(hostSettings?.desktopEnv || { httpProxy: "", noProxy: "", caCerts: "" }), [field]: $(inputId).value.trim() };
  send({ type: "set_desktop_env", ...env });
}
$("proxySave")?.addEventListener("click", () => saveDesktopField("httpProxy", "proxyInput"));
$("noProxySave")?.addEventListener("click", () => saveDesktopField("noProxy", "noProxyInput"));
$("caSave")?.addEventListener("click", () => saveDesktopField("caCerts", "caInput"));
$("askTimeoutSave")?.addEventListener("click", () => {
  const raw = parseFloat($("askTimeoutInput").value);
  const secs = Number.isFinite(raw) && raw >= 0 ? raw : 0;
  send({ type: "set_setting", key: "ask.timeout", value: secs });
  toast(`提问超时时间已保存：${secs} 秒${secs === 0 ? "（永不超时）" : ""}`);
});
$("addProviderBtn")?.addEventListener("click", () => {
  mpAddView = true;
  renderAddProviderView();
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    $("settings").classList.contains("hidden") ? openSettings() : closeSettings();
  } else if (e.key === "Escape" && settingsOpen()) {
    e.preventDefault();
    closeSettings();
  }
});
hydrateIcons(); // 把 index.html 里的 [data-icon] 占位元素替换为 icons.js 注册表中的 svg
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
    { role: "tool", name: "hub", text: "hub", args: { op: "start", name: "api-server", application: "bun", args: ["run", "server.ts"] }, output: "Started api-server (PID 88219) on port 3000\nReady in 120ms" },
  ];
  isCreatingNew = false; // 初始 renderAll 已进过欢迎页（isCreatingNew=true），复位避免预览被短路回欢迎页
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
