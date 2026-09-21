// React 版数据层：全局状态 S + 内容可变容器 + WS 连接 + 事件路由（onMessage）。
// 自 ui/core.js 平移；与命令式版的差异：所有渲染调用（renderAll/renderXxx）统一替换为
// notify()，组件经 useStore() 订阅版本号由 React 重渲染；设置页/ringpop 等尚未组件化的
// 域，回包只落地数据 + notify，DOM 副作用调用跳过（标 TODO(xxx-wave)，组件就位后自然消费）。
import { useSyncExternalStore } from "react";

const invoke = window.__TAURI__?.core?.invoke;
export { invoke };

// ---------- 版本号订阅桥（renderAll 的 React 等价物） ----------
let version = 0;
const listeners = new Set();
export function notify() {
  version++;
  for (const fn of listeners) fn();
}
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** 任意组件调用即订阅全局重渲染（与原 renderAll 同心智模型，diff 交给 React） */
export function useStore() {
  return useSyncExternalStore(subscribe, () => version);
}

// ---------- 跨模块重绑定状态（唯一写法：S.xxx；字段与 core.js 一致） ----------
export const S = {
  activePath: null,
  selectedSubagent: null,
  ws: null,
  pendingCreate: false,
  hostSettings: null,
  modelCatalog: [],
  selectedProvider: null,
  mpAddView: false,
  mpRolesView: false,
  modelRoles: null,
  mpDetailProv: null,
  allProvidersCache: null,
  loginBusy: false,
  agentAssets: null,
  usageStats: null,
  isCreatingNew: false,
  newSessionProject: "",
  newSessionBranch: "",
  newSessionBranches: [],
  newSessionIsGit: false,
  newSessionModel: "",
  newSessionThinking: "auto",
  defaultModelCfg: null,
  defaultThinkingCfg: null,
  newSessionDirty: false,
  pendingNewPrompt: null,
  pendingFiles: [],
  fileSeq: 0,
  viewMode: "project",
  isProjectManageMode: false,
  allProjects: [],
  removedProjects: [],
  archivedSessions: [],
  animateGdKids: false,
  animateThinkBody: false,
  todoCollapsed: false,
  gitViewMode: "tree",
  selectedFile: null,
  fileView: null,
  fileViewPending: null,
  briefDiffPending: null,
  rightTab: "subagent",
  zoomLevel: 1,
  approvalMode: "always-ask",
  loginReqId: 0,
  // ---- React 版新增 UI 态（原版散在 DOM class / 局部变量上） ----
  connected: false,
  connText: "连接中…",
  toastMsg: null, // 当前 toast 文本（null = 隐藏）
  composerSetSignal: null, // { text, images, seq } 外部填输入框的信号（分叉回填 / 排队消息编辑）
  sidebarCollapsed: localStorage.getItem("omp-sidebar-collapsed") === "1",
  // 右栏默认折叠（对齐旧版 index.html <aside id="right" class="collapsed">）；手动展开过后按 localStorage 记忆
  rightCollapsed: localStorage.getItem("omp-right-collapsed") === null ? true : localStorage.getItem("omp-right-collapsed") === "1",
  // ---- 设置中心（阶段 2 七件套共享态） ----
  settingsOpen: false, // 全屏 overlay 开合
  settingsPage: "pg-general", // 当前设置页 id
  providerLimits: null, // provider_limits_result 配额帧
  loginBanner: null, // OMP 登录进度横幅文本
  loginPromptData: null, // login_prompt 粘贴码弹窗数据
  assetFile: null, // asset_file 回包 { kind, path, content }（skills/agents 编辑器按 kind 过滤）
  assetFileSaved: null, // asset_file_saved 回包 { kind, at }（引用变化驱动「已保存」态）
  assetSaved: null, // 同上，agents 页消费
  assetErr: null, // error 帧带 kind 时 { kind, message, at }
  mcpTestResults: {}, // MCP 单服务器测试结果：name -> { status, error?, ts }
  memoryDetail: { base: null, files: null, rollouts: [], active: null, status: "idle", content: "", error: null }, // memory_file 帧落地
  // ---- ringpop 弹卡瞬态数据（hover 上下文环明细卡，移开即弃，下次悬停清零重请求） ----
  ctxDetail: null, // 最近一次 context_detail 回包
  ctxLimits: null, // 最近一次 limits_result 回包
};

// ---------- 内容可变容器（引用恒定，直接导出） ----------
export const diskProjects = [];
export const projectLimits = new Map(); // cwd -> 已显示条数（默认 5，步进 5）
export const expandedProjects = new Set();
export const pinnedSessions = new Set();
/** 已打开（新建或加载）的会话：path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...} */
export const openSessions = new Map();
export const unseenFinished = new Set(JSON.parse(localStorage.getItem("omp-unseen-finished") || "[]"));
export const gitDiffCache = { cwd: null, files: [], loading: false };
export const fileDiffCache = { path: null, diff: "", loading: false };
export const briefDiffCache = {}; // 编辑行内联展开用的单文件 diff，path -> diff 文本
export const modelNames = new Map(); // "provider/id" -> 显示名（原 composer.js 平移）
export const modelEfforts = new Map(); // "provider/id" -> 思考档位列表
/** 右栏运行态（原 right.js rightState 平移；onMessage 写、RightPanel 组件读） */
export const rightState = {
  fileTreeDirs: new Map(),
  fileTreeExpanded: new Set(),
  fileTreePending: new Set(),
  expandedDirs: new Set(),
  commitMsg: "",
  sessionTree: null,
  sessionTreePending: false,
  treeFor: null,
  imageContent: null,
  gitWrite: null,
};

// ---------- UI 偏好（localStorage 合并；外观应用由 App 层 effect 负责） ----------
export const uiPrefs = { uiFont: "default", uiFontSize: 13, codeFontSize: 12, lineNumbers: true, codeWrap: false, showThinking: true, lang: "zh-CN" };
try {
  Object.assign(uiPrefs, JSON.parse(localStorage.getItem("omp-ui-settings") || "{}"));
} catch {}

// ---------- 公共工具 ----------
export function isJunkPlaceholder(text) {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}
export function saveUnseen() {
  localStorage.setItem("omp-unseen-finished", JSON.stringify([...unseenFinished].slice(-200)));
}
export function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
export function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}
export function setConnected(ok, text) {
  S.connected = ok;
  S.connText = text;
  notify();
}
export function activeOpen() {
  return S.activePath ? openSessions.get(S.activePath) : undefined;
}
export function findBySessionId(id) {
  for (const s of openSessions.values()) if (s.sessionId === id) return s;
  return undefined;
}

// toast：App 层 Toast 组件消费 S.toastMsg（2.2s 自动隐藏）
let toastTimer;
export function toast(msg) {
  S.toastMsg = String(msg);
  notify();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    S.toastMsg = null;
    notify();
  }, 2200);
}

// 外部填输入框（分叉回填 / 排队消息编辑）：Composer 组件 effect 监听 seq
let composerSetSeq = 0;
export function setComposerValue(text, images = []) {
  S.composerSetSignal = { text, images, seq: ++composerSetSeq };
  notify();
}

// ---------- 设置中心开合与数据拉取（Settings 容器消费） ----------
export function openSettings(pageId = "pg-general") {
  S.settingsOpen = true;
  S.settingsPage = pageId;
  notify();
}
export function closeSettings() {
  S.settingsOpen = false;
  notify();
}
// 打开设置中心时的四连数据请求（旧版 refreshSettingsData 平移；send 在未连接时静默丢弃，
// 连接就绪由 connect 的 onopen 补拉）
export function refreshSettingsData() {
  send({ type: "get_settings" });
  send({ type: "get_models_catalog" });
  send({ type: "list_agent_assets" });
  send({ type: "get_usage_stats" });
}

// WKWebView 无 console：未捕获错误上报宿主日志 + toast
window.onerror = (msg) => {
  toast(String(msg).slice(0, 120));
  send({ type: "ui_error", message: String(msg).slice(0, 300) });
};
window.addEventListener("unhandledrejection", (e) => {
  send({ type: "ui_error", message: "unhandledrejection: " + String(e.reason).slice(0, 300) });
});

// ---------- 模型目录（原 composer.js ingestModels 平移） ----------
export function ingestModels(models) {
  for (const m of models ?? []) {
    modelNames.set(m.id, m.name || m.id);
    if (Array.isArray(m.efforts)) modelEfforts.set(m.id, m.efforts);
  }
}

// ---------- 欢迎页数据逻辑（原 welcome.js 数据部分平移；DOM 渲染归组件） ----------
export function getAvailableProjects() {
  const removedSet = new Set(S.removedProjects);
  const sessionsOf = new Map(diskProjects.map((p) => [p.cwd, p.sessions]));
  // 顺序 = omp-desktop.json allProjects 的手工/自动发现顺序；磁盘上兜底并入的新项目按磁盘序缀尾
  const known = [...new Set([...S.allProjects, ...diskProjects.map((p) => p.cwd)])];
  return known
    .filter((cwd) => !removedSet.has(cwd))
    .map((cwd) => ({ cwd, sessions: sessionsOf.get(cwd) ?? [] }));
}

export function getSupportedThinkingForModel(modelId) {
  const efforts = modelEfforts.get(modelId) ?? [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

// force = 点新建/配置下发刷新：模型与档位回到配置文件默认；非 force 只做缺失兜底
export function initNewSessionModel(force = false) {
  if (force && S.defaultModelCfg && modelNames.has(S.defaultModelCfg)) {
    S.newSessionModel = S.defaultModelCfg;
  } else if (!S.newSessionModel || !modelNames.has(S.newSessionModel)) {
    const saved = localStorage.getItem("omp-new-model");
    if (saved && modelNames.has(saved)) {
      S.newSessionModel = saved;
    } else {
      const all = Array.from(modelNames.keys());
      const glm = all.find((id) => id.toLowerCase().includes("glm"));
      S.newSessionModel = glm || all[0] || "";
    }
  }
  const validLevels = getSupportedThinkingForModel(S.newSessionModel);
  let th = force && S.defaultThinkingCfg
    ? S.defaultThinkingCfg
    : S.newSessionThinking || localStorage.getItem("omp-new-thinking") || "auto";
  if (!validLevels.includes(th)) {
    th = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
  }
  S.newSessionThinking = th;
}

export function setWelcomeProject(cwd) {
  if (!cwd) {
    const avail = getAvailableProjects();
    cwd = avail[0]?.cwd || diskProjects[0]?.cwd || "/";
  }
  S.newSessionProject = cwd;
  try {
    localStorage.setItem("omp-new-project", cwd);
  } catch {}
  S.newSessionIsGit = false;
  S.newSessionBranch = "";
  S.newSessionBranches = [];
  send({ type: "get_git_branches", cwd });
}

// 欢迎页显隐（原 welcome.js show/hide 的数据部分；显隐本身由组件按 isCreatingNew 渲染）
export function showWelcomeScreen(preferredCwd) {
  const alreadyOpen = S.isCreatingNew;
  S.isCreatingNew = true;
  S.activePath = null;
  if (!alreadyOpen) {
    send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
    S.newSessionDirty = false;
    initNewSessionModel(true);
  }
  const targetProject = preferredCwd || S.newSessionProject || localStorage.getItem("omp-new-project") || diskProjects[0]?.cwd;
  if (!alreadyOpen || targetProject !== S.newSessionProject) setWelcomeProject(targetProject);
  initNewSessionModel();
  notify();
}
export function hideWelcomeScreen() {
  S.isCreatingNew = false;
  notify();
}

// ---------- 过程封存 / 排队消息（core.js 平移，渲染调用改 notify） ----------
// 把本轮自 turnItemStart 起的过程封存为 loop 组（中间 assistant 留组外），并把
// turnItemStart 重置到组后：用于流式中插入用户消息时的预封存，与 steer 消费续跑
export function sealRunItems(s, usage) {
  const startIdx = s.turnItemStart ?? s.items.length;
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
      usage: usage ?? null,
    });
  }
  s.items.push(...finalOut);
  s.turnItemStart = s.items.length;
}

function queueIndexOf(list, text) {
  return (list ?? []).findIndex((m) => (m.text || "") === text);
}

// 删除：出队 + 移除气泡
export function dropQueueMsg(s, item) {
  const which = item.pending === "steer" ? "steering" : "followUp";
  const list = which === "steering" ? s.steering : s.queued;
  const i = queueIndexOf(list, item.text);
  if (i < 0) return;
  list.splice(i, 1);
  const j = s.items.lastIndexOf(item);
  if (j >= 0) s.items.splice(j, 1);
  send({ type: "drop_queued", sessionId: s.sessionId, queue: which, index: i });
  notify();
}

// 编辑：内容回输入框（composerSetSignal 由 Composer effect 消费），再删除
export function editQueueMsg(s, item) {
  setComposerValue(item.text);
  dropQueueMsg(s, item);
}

// 立即发送：排队态转 steer。不截断过程、不预封存——分割只发生在消费时刻
// （steer_consumed 把气泡上方全部过程封存成 loop 组）；气泡由渲染层固定在消息流底部
export function sendNowQueueMsg(s, item) {
  const i = queueIndexOf(s.queued, item.text);
  if (i < 0) return;
  s.queued.splice(i, 1);
  s.steering = s.steering ?? [];
  s.steering.push({ text: item.text });
  s.items.push({ role: "user", text: item.text, pending: "steer" });
  send({ type: "send_now", sessionId: s.sessionId, index: i });
  notify();
}

// 放回队列：steer 态转回排队顶端，气泡同步移除（消息只保留在队列卡中）
export function requeueSteerMsg(s, item) {
  const i = queueIndexOf(s.steering, item.text);
  if (i < 0) return;
  s.steering.splice(i, 1);
  s.queued = s.queued ?? [];
  s.queued.unshift({ text: item.text });
  const j = s.items.lastIndexOf(item);
  if (j >= 0) s.items.splice(j, 1);
  send({ type: "requeue", sessionId: s.sessionId, index: i });
  notify();
}

// ---------- 系统通知（Tauri 壳 send_desktop_notification；事件重复两遍 → 10s 去重） ----------
const notifyLastAt = new Map();
function notifyDesktop(kind, s, title, body) {
  const now = Date.now();
  const key = `${s.sessionId}:${kind}`;
  if (now - (notifyLastAt.get(key) ?? 0) < 10_000) return;
  notifyLastAt.set(key, now);
  if (!invoke) return; // 非 Tauri 环境（浏览器直连调试）：功能不存在，静默跳过
  const path = [...openSessions.entries()].find(([, v]) => v === s)?.[0];
  if (path === S.activePath && document.hasFocus()) return;
  invoke("send_desktop_notification", { title, body, sessionId: s.sessionId }).catch((err) =>
    console.warn("send_desktop_notification:", err),
  );
}

// ---------- Git diff 预取（原 right.js refreshGitDiff 平移） ----------
export function refreshGitDiff(force = false) {
  const s = activeOpen();
  if (!s || !s.isGit) return; // 非 git 仓库不请求，不触发宿主报错
  if (!force && gitDiffCache.cwd === s.cwd) return;
  gitDiffCache.loading = true;
  gitDiffCache.cwd = s.cwd;
  send({ type: "get_git_diff", cwd: s.cwd });
}

// 从 models/ready 帧提取新建会话配置默认
function ingestModelDefaults(msg) {
  const has = "defaultModel" in msg || "defaultThinking" in msg;
  if (!has) return false;
  S.defaultModelCfg = msg.defaultModel ?? null;
  S.defaultThinkingCfg = msg.defaultThinking ?? null;
  return true;
}

// 流式增量帧的合并渲染：100ms 窗口内多帧只 notify 一次（防高频重渲染打爆主线程）
let deltaRenderTimer = null;
function scheduleDeltaRender() {
  if (deltaRenderTimer) return;
  deltaRenderTimer = setTimeout(() => {
    deltaRenderTimer = null;
    notify();
  }, 100);
}

// ---------- WS 连接 ----------
export async function connect() {
  if (!invoke) {
    setConnected(false, "无宿主");
    return;
  }
  setConnected(false, "连接中…");
  const url = await invoke("ws_url");
  S.ws = new WebSocket(url);
  S.ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  S.ws.onopen = () => {
    setConnected(true, "已连接");
    send({ type: "list_sessions" });
    // 启动时欢迎页先于连接渲染，get_git_branches 曾被 send 丢弃；连接就绪后补拉
    if (S.isCreatingNew && S.newSessionProject) send({ type: "get_git_branches", cwd: S.newSessionProject });
    // 设置页若在连接就绪前打开，4 个数据请求被 send 丢弃；连接就绪后补拉
    if (S.settingsOpen) refreshSettingsData();
  };
  S.ws.onclose = () => setConnected(false, "已断开");
  S.ws.onerror = () => setConnected(false, "已断开");
}

// ---------- 事件路由 ----------
function onMessage(msg) {
  switch (msg.type) {
    case "ready":
      S.approvalMode = msg.approvalMode ?? S.approvalMode;
      ingestModels(msg.models);
      // 启动即进欢迎页时 ready 帧晚于首次 initNewSessionModel：配置默认到位后立即重校准
      if (ingestModelDefaults(msg) && S.isCreatingNew && !S.newSessionDirty) initNewSessionModel(true);
      if (msg.settings) {
        S.hostSettings = msg.settings;
        // 字段级白名单合并：host 设置帧只有 hideThinkingBlock 影响本地外观偏好
        if (typeof msg.settings.hideThinkingBlock === "boolean") uiPrefs.showThinking = !msg.settings.hideThinkingBlock;
      }
      notify();
      break;
    case "models":
      ingestModels(msg.models);
      if (ingestModelDefaults(msg) && S.isCreatingNew && !S.newSessionDirty) initNewSessionModel(true);
      notify();
      break;
    case "models_catalog":
      S.modelCatalog = msg.models ?? [];
      notify(); // TODO(settings-wave)：模型页组件消费
      break;
    case "model_roles":
      S.modelRoles = msg.roles ?? [];
      notify();
      break;
    case "settings":
      S.hostSettings = msg.settings;
      if (typeof msg.settings?.hideThinkingBlock === "boolean") uiPrefs.showThinking = !msg.settings.hideThinkingBlock;
      if (msg.restartHint) toast("已保存，部分网络设置建议重启应用后完全生效");
      notify();
      break;
    case "profile_switched":
      openSessions.clear();
      S.activePath = null;
      S.selectedSubagent = null;
      S.selectedFile = null;
      notify();
      toast(`已激活 Profile: ${msg.profile}`);
      break;
    case "usage_stats":
      S.usageStats = msg.stats;
      notify();
      break;
    case "agent_assets":
      S.agentAssets = msg.assets;
      notify();
      break;
    case "approval_mode":
      S.approvalMode = msg.mode;
      notify();
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
      notify();
      notifyDesktop("approval", s, "等待审批", msg.title);
      break;
    }
    case "approval_resolved":
      break; // 本地点击已即时定格
    case "session_list": {
      // 归档条目拆出：不进 diskProjects，单独存 S.archivedSessions 供侧栏归档区渲染
      diskProjects.length = 0;
      S.archivedSessions = [];
      for (const p of msg.projects) {
        const sessions = [];
        for (const s of p.sessions) {
          if (s.archived) S.archivedSessions.push({ ...s, cwd: p.cwd });
          else sessions.push(s);
        }
        diskProjects.push({ ...p, sessions });
      }
      S.archivedSessions.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
      S.allProjects = msg.allProjects ?? [];
      S.removedProjects = msg.removedProjects ?? [];
      expandedProjects.clear();
      for (const c of msg.expandedProjects ?? []) expandedProjects.add(c);
      pinnedSessions.clear();
      for (const p of msg.pinnedSessions ?? []) pinnedSessions.add(p);
      if (S.isProjectManageMode) {
        for (const p of diskProjects) expandedProjects.add(p.cwd);
      }
      if (S.activePath && !diskProjects.some((p) => p.sessions.some((s) => s.path === S.activePath))) {
        openSessions.delete(S.activePath);
        S.activePath = null;
        showWelcomeScreen(S.newSessionProject || diskProjects[0]?.cwd);
      }
      notify();
      break;
    }
    case "session_model": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.model = msg.model;
        if (msg.thinking) s.thinking = msg.thinking;
      }
      notify();
      break;
    }
    case "session_thinking": {
      const s = findBySessionId(msg.sessionId);
      if (s) s.thinking = msg.level;
      notify();
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
      S.activePath = msg.path;
      S.selectedSubagent = null;
      S.selectedFile = null;
      S.isCreatingNew = false;
      refreshGitDiff(); // 右栏 Git Diff 页需要 git status 数据，提前预取
      notify();
      if (S.pendingNewPrompt) {
        const { text, files } = S.pendingNewPrompt;
        S.pendingNewPrompt = null;
        const s = activeOpen();
        if (s) {
          s.items.push({ role: "user", text });
          notify();
          S.ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
          // 钉底跟随由 Chat 组件的滚动 effect 处理
        }
      }
      if (S.pendingCreate) {
        S.pendingCreate = false;
        send({ type: "list_sessions" }); // 新会话已落盘，重拉列表
      }
      break;
    }
    case "git_branches": {
      if (msg.cwd === S.newSessionProject) {
        S.newSessionIsGit = !!msg.isGit;
        S.newSessionBranch = msg.current || "";
        S.newSessionBranches = msg.branches || [];
        notify();
      }
      break;
    }
    case "git_branch_switched": {
      if (msg.cwd === S.newSessionProject) {
        S.newSessionBranch = msg.branch;
        notify();
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
        s.workingText = "正在处理…";
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
          s.workingText = "思考中…";
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
          s.workingText = "正在处理…";
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
          running: msg.name === "bash" || msg.name === "shell" || msg.name === "eval",
        });
        if (msg.intent) s.workingText = msg.intent;
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
        s.workingText = null;
        // 每个模型轮结束（含排队消费/工具触发的 run 内续轮）：过程收进 loop 组自动收起，
        // 只留最后一条 assistant 对外展示。run 收尾帧（runEnd，宿主 agent_end 映射）额外做
        // entryId 回填/列表刷新/系统通知——这些只该发生一次，轮内续轮帧不做
        sealRunItems(s, msg.usage);
        if (msg.runEnd) {
          // 宿主在落盘完成后回贴本轮 user 消息的 entryId（消息行分叉按钮的寻址键）；
          // 贴给本轮最后一条无 entryId 的 user 消息（乐观插入的那条）
          if (msg.userEntryId) {
            const u = [...s.items].reverse().find((it) => it.role === "user" && !it.entryId);
            if (u) u.entryId = msg.userEntryId;
          }
          s.turnItemStart = null; // 本轮彻底结束，不再继续累积
          s.turnStartAt = null;
          send({ type: "list_sessions" }); // title/firstMessage 可能已更新
          if (s.isGit) refreshGitDiff(true); // agent 可能改了文件，强制重拉
          // 会话已结束：非当前正在查看的会话标记「未查看」，列表显示灰白圆点
          const p = [...openSessions.entries()].find(([, v]) => v === s)?.[0];
          if (p && p !== S.activePath) {
            unseenFinished.add(p);
            saveUnseen();
          }
          // 后台会话完成 → 系统通知：title 取磁盘列表里的会话标题（未收录时「后台会话」），
          // body 取最后一条 assistant 文本截断 80 字作摘要，无则「已完成」
          const lastA = [...s.items].reverse().find((it) => it.role === "assistant" && !isJunkPlaceholder(it.text));
          const summary = (lastA?.text || "").trim();
          notifyDesktop(
            "turn_end",
            s,
            diskProjects.flatMap((pr) => pr.sessions).find((x) => x.id === s.sessionId)?.title || "后台会话",
            summary ? (summary.length > 80 ? summary.slice(0, 80) + "…" : summary) : "已完成",
          );
        }
      } else if (msg.kind === "thinking_level") {
        // auto 档位判定帧：只记判定结果供右下角显示 auto·档位，不改 s.thinking
        if (msg.configured === "auto") s.autoResolved = msg.resolved;
      }
      if (msg.kind === "text_delta" || msg.kind === "thinking_delta") scheduleDeltaRender();
      else notify();
      break;
    }
    case "messages": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      s.items = msg.messages.map((m) => ({ ...m }));
      notify();
      break;
    }
    case "subagent_lifecycle": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      // 底座在结束时（completed/failed/aborted）会用同一 subagentId 重发 lifecycle——
      // 只更新状态保留累积内容，否则完成后详情被清空
      const prev = s.subagents.get(msg.subagentId);
      s.subagents.set(msg.subagentId, {
        agent: msg.agent,
        description: msg.description ?? "",
        status: msg.status,
        text: prev?.text ?? "",
        tools: prev?.tools ?? [],
        streaming: msg.status === "started",
      });
      notify();
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
      notify();
      break;
    }
    case "git_status": {
      gitDiffCache.cwd = msg.cwd;
      gitDiffCache.files = msg.files;
      gitDiffCache.loading = false;
      const { expandedDirs } = rightState;
      expandedDirs.clear();
      const dirs = new Set();
      for (const f of msg.files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      for (const d of dirs) expandedDirs.add(d);
      notify();
      break;
    }
    case "todos": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.todos = msg.phases ?? [];
        notify();
      }
      break;
    }
    case "queued": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.queued = msg.followUp ?? [];
        s.steering = msg.steering ?? [];
        notify();
      }
      break;
    }
    case "steer_consumed": {
      // 队列消息即将注入模型（消费即分割点）：摘气泡 → 封存气泡上方过程 → 气泡落底转正
      const s = findBySessionId(msg.sessionId);
      if (s) {
        const bubbles = [];
        // 气泡查找要穿透 loop 组：turn_end 可能先于此帧到达并把气泡封进了组里
        const findBubble = (t) => {
          for (let i = s.items.length - 1; i >= 0; i--) {
            const x = s.items[i];
            if (x.role === "loop") {
              const hit = [...x.items].reverse().find((k) => k.role === "user" && k.pending && k.text === t);
              if (hit) return { bubble: hit, loop: x };
            } else if (x.role === "user" && x.pending && x.text === t) {
              return { bubble: x, loop: null };
            }
          }
          return null;
        };
        for (const t of msg.texts ?? []) {
          const found = findBubble(t);
          const it = found?.bubble;
          // 重复消费帧（RPC 重复推送）:该文本已有转正过的气泡则跳过，不重复补画
          if (!it && [...s.items].reverse().some((x) => x.role === "user" && x.steerDone && x.text === t)) continue;
          bubbles.push({ ...found, fallback: it ?? { role: "user", text: t } });
          const q = s.queued ?? [];
          const i = q.findIndex((m) => (m.text || "") === t);
          if (i >= 0) q.splice(i, 1);
          const st = s.steering ?? [];
          const j = st.findIndex((m) => (m.text || "") === t);
          if (j >= 0) st.splice(j, 1);
        }
        const done = [];
        for (const b of bubbles) {
          const bubble = b.fallback;
          const k = s.items.indexOf(bubble);
          if (k >= 0) s.items.splice(k, 1);
          else if (b.loop) {
            const ki = b.loop.items.indexOf(bubble);
            if (ki >= 0) b.loop.items.splice(ki, 1);
            if (b.loop.items.length === 0) {
              const li = s.items.indexOf(b.loop);
              if (li >= 0) s.items.splice(li, 1);
            }
          }
          bubble.pending = null;
          bubble.steerDone = true;
          done.push(bubble);
        }
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
        s.assistantDraft = "";
        sealRunItems(s, null);
        for (const b of done) s.items.push(b);
        s.turnItemStart = s.items.length;
        s.streaming = true;
        s.workingText = "正在处理…";
        s.turnStartAt = Date.now();
        notify();
      }
      break;
    }
    case "file_diff": {
      fileDiffCache.path = msg.path;
      fileDiffCache.diff = msg.diff;
      fileDiffCache.loading = false;
      briefDiffCache[msg.path] = msg.diff; // 同一份回包同时喂给编辑行内联展开
      if (S.briefDiffPending === msg.path) S.briefDiffPending = null;
      notify();
      break;
    }
    case "file_content": {
      // 文件页全文件内容回包：无条件写入（用户可能已切走 tab）
      S.fileViewPending = null;
      if (S.fileView && S.fileView.path === msg.path) {
        if (msg.error) S.fileView.error = msg.error;
        else Object.assign(S.fileView, { text: msg.text, startLine: 1, lineNumbers: null, full: true, error: null });
      }
      notify();
      break;
    }
    case "dir_list": {
      // 文件树单层回包：填充缓存
      rightState.fileTreePending.delete(msg.path);
      rightState.fileTreeDirs.set(msg.path, msg.entries ?? []);
      notify();
      break;
    }
    case "context": {
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.ctx = { tokens: msg.tokens, window: msg.window, percent: msg.percent };
        notify();
      }
      break;
    }
    case "context_detail":
      S.ctxDetail = msg; // ringpop 弹卡瞬态数据，CtxCard 订阅重绘（卡收起时更新不重建，移开即弃）
      notify();
      break;
    case "limits_result":
      S.ctxLimits = msg;
      notify();
      break;
    case "provider_limits_result": {
      // 模型管理页配额：按选中供应商落地，组件按 S.providerLimits 渲染（防旧响应污染由组件判 provider）
      if (msg.provider === S.selectedProvider) {
        S.providerLimits = msg;
        notify();
      }
      break;
    }
    case "all_providers":
      S.allProvidersCache = msg.providers ?? [];
      notify();
      break;
    case "login_progress":
      if (msg.reqId !== S.loginReqId) break;
      S.loginBanner = `${msg.provider}：${msg.message}`;
      notify();
      break;
    case "login_prompt":
      if (msg.reqId !== S.loginReqId) break;
      S.loginPromptData = msg;
      notify();
      break;
    case "login_done":
      if (msg.reqId !== S.loginReqId) break;
      S.loginBusy = false;
      S.loginBanner = null;
      S.loginPromptData = null;
      if (msg.ok) {
        toast(`${msg.provider} 登录成功，模型列表已刷新`);
        S.mpAddView = false;
      } else if (msg.cancelled) {
        toast("登录已取消");
      } else {
        toast(`${msg.provider} 登录失败：${msg.message}`);
      }
      notify();
      break;
    case "provider_key_done":
      toast(`${msg.provider} API key 已保存，模型列表已刷新`);
      S.mpDetailProv = null;
      send({ type: "get_all_providers" });
      notify();
      break;
    case "models_config_path":
      toast(`配置文件：${msg.path}`);
      break;
    case "asset_file":
      // skills/agents/mcp 编辑器共用帧，全量落地，页面按 kind 过滤（每次赋新对象触发 effect）
      S.assetFile = { kind: msg.kind ?? "agent", path: msg.path, content: msg.content };
      notify();
      break;
    case "memory_file": {
      // 首次目录级读取带 files；行展开/rollout 只回 content（旧版 memInbox 语义平移）
      if (msg.files) {
        S.memoryDetail.base = msg.path;
        S.memoryDetail.files = msg.files;
        S.memoryDetail.rollouts = msg.rollouts ?? [];
        S.memoryDetail.active = { name: msg.file, rollout: false };
      }
      S.memoryDetail.content = msg.content;
      S.memoryDetail.status = "done";
      S.memoryDetail.error = null;
      notify();
      break;
    }
    case "asset_file_saved": {
      const at = Date.now();
      S.assetFileSaved = { kind: msg.kind, at };
      S.assetSaved = { kind: msg.kind, at };
      send({ type: "list_agent_assets" });
      notify();
      break;
    }
    case "asset_file_deleted":
      toast(msg.kind === "skill" ? "技能已删除" : "文件已删除");
      notify();
      break;
    case "mcp_server_tested": {
      // 旧版 handleMcpServerTested 平移：测试结果落地 + 行状态点同步 + toast
      S.mcpTestResults[msg.name] = { status: msg.status, error: msg.error, ts: Date.now() };
      const srv = S.agentAssets?.mcp?.servers?.find((x) => x.name === msg.name);
      if (srv) {
        srv.status = msg.status === "ok" ? "connected" : "error";
        srv.error = msg.error;
      }
      toast(msg.status === "ok" ? `MCP [${msg.name}] 连接成功` : `MCP [${msg.name}] 探测失败: ${msg.error || ""}`);
      notify();
      break;
    }
    case "session_renamed":
      if (msg.ok) {
        toast("已重命名");
        send({ type: "list_sessions" }); // 列表数据以宿主为唯一真源，重拉最稳
      } else toast(msg.error ?? "重命名失败");
      break;
    case "session_archived":
      if (msg.ok) {
        toast(msg.archived ? "已归档" : "已取消归档");
        send({ type: "list_sessions" });
      } else toast(msg.error ?? "归档操作失败");
      break;
    case "session_aborted":
      toast("已停止生成");
      break;
    case "session_compacted":
      toast(msg.ok ? "上下文已压缩" : (msg.error ?? "压缩失败"));
      break;
    case "session_branched": {
      // 分叉回执：清除防连点标记；transcript 由 load_session 推的 messages 帧重建
      const clearBranching = (items) => {
        for (const it of items) {
          if (it.branching) it.branching = false;
          if (it.items) clearBranching(it.items);
        }
      };
      const cur = activeOpen();
      if (cur) clearBranching(cur.items);
      if (!msg.ok) {
        toast(msg.error ?? "分叉失败");
        notify();
        break;
      }
      toast("已分叉到新分支");
      setComposerValue(msg.selectedText ?? "", msg.selectedImages);
      send({ type: "load_session", path: msg.newPath }); // 复用磁盘会话加载链路
      send({ type: "list_sessions" });
      break;
    }
    case "session_tree":
      rightState.sessionTree = { sessionId: msg.sessionId ?? rightState.treeFor, branches: msg.branches ?? [] };
      rightState.sessionTreePending = false;
      notify();
      break;
    case "image_content":
      rightState.imageContent = msg;
      notify();
      break;
    case "git_staged":
    case "git_unstaged":
    case "git_discarded":
    case "git_committed":
    case "git_pushed":
      rightState.gitWrite = msg;
      notify(); // 回包驱动按钮 busy 态收口
      if (msg.type === "git_staged" || msg.type === "git_unstaged" || msg.type === "git_discarded") {
        if (msg.ok) {
          if (msg.type === "git_discarded") toast("已丢弃更改");
          refreshGitDiff();
        } else toast(msg.error ?? "git 操作失败");
      } else if (msg.type === "git_committed") {
        if (msg.ok) {
          toast(`已提交 ${(msg.commit ?? "").slice(0, 7)}`);
          refreshGitDiff();
        } else toast(msg.error ?? "提交失败");
      } else {
        toast(msg.ok ? "已推送" : (msg.error ?? "推送失败"));
      }
      break;
    case "error": {
      gitDiffCache.loading = false;
      rightState.sessionTreePending = false; // 分支树请求失败解除挂起，下次渲染重拉
      // 设置中心资产/记忆读取失败的错误落地（旧版写 aeStatus / 记忆行内态）
      if (msg.kind) S.assetErr = { kind: msg.kind, message: msg.message, at: Date.now() };
      if (S.memoryDetail.status === "loading") {
        S.memoryDetail.status = "error";
        S.memoryDetail.error = msg.message;
      }
      const s = msg.sessionId && findBySessionId(msg.sessionId);
      if (s) {
        s.items.push({ role: "error", text: msg.message });
        notify();
      } else {
        toast(msg.message);
        notify();
      }
      break;
    }
  }
}

// 工具行文件清单去重（原 tool-rows.js uniqueFiles 平移；store 的 tool 处理需要）
function uniqueFiles(files) {
  return [...new Set(files ?? [])];
}
