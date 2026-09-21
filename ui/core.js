// 前端核心：全局状态（S/容器）、WebSocket 连接与事件路由（onMessage）、公共工具。
//
// 拆分约定（源自 app.js 巨无霸拆分）：
// - 跨模块整体重绑定（= 赋值）的变量一律挂 S 对象；内容可变的容器（Map/Set/数组/对象）
//   直接导出 const，跨模块改内容合法。
// - 各域模块顶层只做定义；原先散落顶层的立即执行代码（事件绑定/observer）收进各域
//   initXxx()，由 app.js 入口按依赖序统一调用——ESM 循环 import 下顶层互调会 TDZ 崩溃。
// - onMessage 是事件分发中枢，函数体内引用各域渲染函数（模块加载期不执行，循环安全）。
import { setApprovalModeUi, ingestModels, renderComposerBar, renderQueueLine, setComposerValue } from "./composer.js";
import { showWelcomeScreen, hideWelcomeScreen, updateWelcomeGitUI, initNewSessionModel } from "./welcome.js";
import { renderList } from "./sidebar.js";
import { fillCtxCard, fillLimits, buildLimitsSection } from "./ringpop.js";
import { uniqueFiles } from "./tool-rows.js";
import { renderChat } from "./chat.js";
import { refreshGitDiff, renderRightBody, renderRight, rightState } from "./right.js";
import { applyHostSettings, applyHostReadySettings, renderAssetPages } from "./settings/index.js";
import { openAssetEditor, assetStatus, ASSET_PAGES, assetSelPath } from "./settings/agents.js";
import { renderMemoryDetail } from "./settings/memory.js";
import { handleMcpServerTested } from "./settings/mcp.js";
import { showLoginBanner, showLoginPrompt, hideLoginBanner, closeLoginPrompt, renderAddProviderView } from "./settings/providers.js";
import { renderModelPage } from "./settings/models.js";
import { renderStatsPage } from "./settings/stats.js";

const invoke = window.__TAURI__?.core?.invoke;
export { invoke };

export const $ = (id) => document.getElementById(id);
export const streamEl = $("stream");
export const tasklistEl = $("tasklist");
export const inputEl = $("input");
export const statusEl = $("conn-status");
export const rightBodyEl = $("rightBody");
export const composerEl = $("composer");
export const modelBtn = $("modelBtn");
export const thinkBtn = $("thinkBtn");
export const modeBtn = $("modeBtn");

// ---------- 跨模块重绑定状态（唯一写法：S.xxx） ----------
export const S = {
  activePath: null,
  selectedSubagent: null, // 右栏流视图选中的 subagentId（null = 卡片列表）
  ws: null,
  pendingCreate: false,
  hostSettings: null,
  modelCatalog: [],
  selectedProvider: null,
  mpAddView: false, // 「添加供应商」视图开关:打开时右卡列出全部供应商
  mpRolesView: false, // 「模型角色」视图开关:右卡展示 @role → 模型分配
  modelRoles: null, // get_model_roles 回包缓存(get_model_roles → model_roles)
  mpDetailProv: null, // 添加视图内选中的供应商(详情页:登录 / API key 二选一)
  allProvidersCache: null, // get_all_providers 响应缓存
  loginBusy: false, // OMP 登录流程进行中
  agentAssets: null,
  usageStats: null,
  isCreatingNew: false,
  newSessionProject: "",
  newSessionBranch: "",
  newSessionBranches: [],
  newSessionIsGit: false,
  newSessionModel: "",
  newSessionThinking: "auto",
  defaultModelCfg: null, // 配置文件默认模型（host models/ready 帧下发，default 角色解析结果）
  defaultThinkingCfg: null, // 配置文件默认思考级别（defaultThinkingLevel 原文："auto" 或具体档位）
  newSessionDirty: false, // 欢迎页里用户手选过模型/档位：models 帧到达时不再用配置默认覆盖
  pendingNewPrompt: null, // { text, files }，新建会话创建成功后补发
  pendingFiles: [], // { id, name, kind: "image" | "text", mime, data }（image: base64；text: 文件内容）
  fileSeq: 0,
  viewMode: "project", // 左栏视图：project | recent
  isProjectManageMode: false, // 项目清理模式：展开所有项目与会话，展示移除/删除按钮
  allProjects: [], // 所有项目全路径（宿主 profile 配置目录 omp-desktop.json）
  removedProjects: [], // 已移除项目全路径（项目视图隐藏，最近视图仍显示其会话）
  archivedSessions: [], // 已归档会话条目（含 cwd），session_list 拆分落此，归档区渲染用
  animateGdKids: false, // 下一次 renderRightBody 为目录展开动作的子行播放入场动画（同步渲染后立即复位）
  animateThinkBody: false, // 下一次 renderChat 为思考展开动作的 think-body 播放入场动画（同步渲染后立即复位）
  todoCollapsed: false, // 进程卡收起为胶囊
  gitViewMode: "tree", // tree | flat
  selectedFile: null, // gitdiff 内选中的文件（详情视图）
  fileView: null, // 文件页详情数据：{ path, text, startLine, lineNumbers, reqRange, full?, error? }
  fileViewPending: null, // 等待 read_file 回包的详情路径
  briefDiffPending: null, // 等待 file_diff 回包的内联展开路径
  rightTab: "subagent", // 激活 tab；null = 全部关闭，显示起始页
  zoomLevel: 1,
  approvalMode: "always-ask",
  loginReqId: 0,
};

// ---------- 内容可变容器（引用恒定，直接导出） ----------
/** 磁盘会话列表：[{cwd, sessions:[{id,path,title,firstMessage,modified,messageCount}]}] */
export const diskProjects = [];
const projectLimits = new Map(); // cwd -> 已显示条数（默认 5，步进 5）
export { projectLimits };
export const expandedProjects = new Set(); // 需要展开的项目 cwd（宿主 omp-desktop.json 持久化，未记录的默认收起）
export const pinnedSessions = new Set(); // 置顶会话 path（宿主 omp-desktop.json pinnedSessions 持久化，重启保持）
/** 已打开（新建或加载）的会话：path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...} */
export const openSessions = new Map();
// 结束后未查看的会话（灰白圆点提示），localStorage 持久化
export const unseenFinished = new Set(JSON.parse(localStorage.getItem("omp-unseen-finished") || "[]"));
const gitDiffCache = { cwd: null, files: [], loading: false }; // 会话级 git status 缓存（right/chat 读写）
export { gitDiffCache };
const fileDiffCache = { path: null, diff: "", loading: false }; // gitdiff 详情页单文件 diff
export { fileDiffCache };
export const briefDiffCache = {}; // 编辑行内联展开用的单文件 diff，path -> diff 文本
// 记忆页读取状态（core.onMessage 写、settings/memory 读；sideEl/contentEl 为当前延展区元素）
export const memInbox = { base: null, files: null, rollouts: null, active: null, sideEl: null, contentEl: null };

// 从 models/ready 帧提取新建会话配置默认；返回是否携带了默认字段
function ingestModelDefaults(msg) {
  const has = "defaultModel" in msg || "defaultThinking" in msg;
  if (!has) return false;
  S.defaultModelCfg = msg.defaultModel ?? null;
  S.defaultThinkingCfg = msg.defaultThinking ?? null;
  return true;
}

// ---------- UI 偏好（settings 域读写，对象内容可变） ----------
export const uiPrefs = { uiFont: "default", uiFontSize: 13, codeFontSize: 12, lineNumbers: true, codeWrap: false, showThinking: true, lang: "zh-CN" };
try {
  Object.assign(uiPrefs, JSON.parse(localStorage.getItem("omp-ui-settings") || "{}"));
} catch {}

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

export function isJunkPlaceholder(text) {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}
export function saveUnseen() {
  localStorage.setItem("omp-unseen-finished", JSON.stringify([...unseenFinished].slice(-200)));
}

// token 数值 <1000 原样，≥1K/1M 切换单位保留 1 位小数
// （原 app.js 曾有两份 fmtTokens：明细卡「万/k」版从未生效——函数声明提升被本版覆盖，拆分时只保留生效版）
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
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = ok ? "ok" : "bad";
  }
}

export function activeOpen() {
  return S.activePath ? openSessions.get(S.activePath) : undefined;
}

export function findBySessionId(id) {
  for (const s of openSessions.values()) if (s.sessionId === id) return s;
  return undefined;
}

// ---------- toast（原型同款） ----------
const toastEl = $("toast");
let toastTimer;
export function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2200);
}

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
    // 设置页若在连接就绪前打开，4 个数据请求同样被 send 丢弃（profile 菜单停留预置单项）；动态 import 避免与 settings 模块循环依赖
    import("./settings/index.js").then(({ settingsOpen, refreshSettingsData }) => {
      if (settingsOpen()) refreshSettingsData();
    });
  };
  S.ws.onclose = () => setConnected(false, "已断开");
  S.ws.onerror = () => setConnected(false, "已断开");
}

// ---------- 总渲染 ----------
// working 状态行（输入框上方）：仅当前活跃会话流式期间显示。子元素只建一次，
// 之后仅更新文字——重建节点会重启 spinner 动画造成闪烁
function renderWorkLine() {
  const el = $("workLine");
  if (!el) return;
  const s = activeOpen();
  const text = s?.streaming ? s.workingText || "正在处理…" : "";
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  let tx = el.querySelector(".wl-tx");
  if (!tx) {
    el.textContent = "";
    const sp = document.createElement("span");
    sp.className = "wl-spin";
    tx = document.createElement("span");
    tx.className = "wl-tx";
    el.append(sp, tx);
  }
  if (tx.textContent !== text) {
    tx.textContent = text;
    tx.title = text;
  }
  el.hidden = false;
}

export function renderAll() {
  renderList();
  renderChat();
  renderComposerBar();
  renderRight();
  renderWorkLine();
  renderQueueLine();
}

// 发送后钉底：消息体内的图片等资源异步撑高 scrollHeight，单次 scrollTop 赋值只覆盖
// 渲染当下，随后长出的余量会让「滚动至结尾」按钮闪现且不再跟随。窗口内每 100ms 重钉，
// 用户滚轮/触摸立即取消（不绑架主动上翻）
let pinTimer = null;
export function pinBottom(ms = 1500) {
  const cancel = () => {
    clearInterval(pinTimer);
    pinTimer = null;
    streamEl.removeEventListener("wheel", cancel);
    streamEl.removeEventListener("touchstart", cancel);
  };
  cancel();
  streamEl.scrollTop = streamEl.scrollHeight;
  const until = Date.now() + ms;
  pinTimer = setInterval(() => {
    if (Date.now() >= until) return cancel();
    streamEl.scrollTop = streamEl.scrollHeight;
  }, 100);
  streamEl.addEventListener("wheel", cancel, { once: true });
  streamEl.addEventListener("touchstart", cancel, { once: true });
}

// 流式增量帧的合并渲染：100ms 窗口内多帧只渲一次，末帧经 setTimeout 兜底必渲
let deltaRenderTimer = null;
function scheduleDeltaRender() {
  if (deltaRenderTimer) return;
  deltaRenderTimer = setTimeout(() => {
    deltaRenderTimer = null;
    renderAll();
  }, 100);
}

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

// 排队/steer 待消费消息的气泡与排队卡共用动作（按文本在队列中定位下标）
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
  // turnItemStart 恒指本轮起点（< 气泡下标），移除气泡不影响它，无需校准
  send({ type: "drop_queued", sessionId: s.sessionId, queue: which, index: i });
  renderAll();
}

// 编辑：内容回输入框（触发 input 事件走既有监听），再删除
export function editQueueMsg(s, item) {
  inputEl.value = item.text;
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.focus();
  dropQueueMsg(s, item);
}

// 立即发送：排队态转 steer。不截断过程、不预封存——分割只发生在消费时刻
// （steer_consumed 把气泡上方全部过程封存成 loop 组）；此前流式照常累积，
// 气泡由渲染层固定在消息流底部（pending steer 收集到末尾渲染）
export function sendNowQueueMsg(s, item) {
  const i = queueIndexOf(s.queued, item.text);
  if (i < 0) return;
  s.queued.splice(i, 1);
  s.steering = s.steering ?? [];
  s.steering.push({ text: item.text });
  s.items.push({ role: "user", text: item.text, pending: "steer" });
  send({ type: "send_now", sessionId: s.sessionId, index: i });
  renderAll();
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
  // 同 dropQueueMsg：turnItemStart 在本轮起点，恒在气泡之前，移除气泡无需校准
  send({ type: "requeue", sessionId: s.sessionId, index: i });
  renderAll();
}

// ---------- 系统通知（Tauri 壳 send_desktop_notification，事件 dispatch 的副作用，不进渲染路径） ----------
// 防打扰：非激活会话 → 发（用户在看别的会话）；激活会话但窗口整体失焦 → 也发；
// 激活会话且窗口有焦点（用户正盯着）→ 绝不发。
// 去重节流：RPC 事件可能重复推送两遍（协议已知怪癖）、审批请求可能重复出现，
// 同 sessionId+类型 10 秒内只发一次。
const notifyLastAt = new Map(); // `${sessionId}:${kind}` -> 上次发送时间戳
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
  ); // macOS 未授权时 invoke 会 reject：记录即可，不打断事件主流程
}

function onMessage(msg) {
  switch (msg.type) {
    case "ready":
      setApprovalModeUi(msg.approvalMode);
      ingestModels(msg.models);
      // 启动即进欢迎页时 ready 帧晚于首次 initNewSessionModel：配置默认到位后立即重校准
      if (ingestModelDefaults(msg) && S.isCreatingNew && !S.newSessionDirty) initNewSessionModel(true);
      if (msg.settings) applyHostReadySettings(msg.settings);
      renderAll();
      break;
    case "models":
      ingestModels(msg.models);
      // 新建态且用户未手选：用最新下发的配置默认刷新右下角（点新建→reload_settings 异步回来的校准路径）
      if (ingestModelDefaults(msg) && S.isCreatingNew && !S.newSessionDirty) initNewSessionModel(true);
      renderAll();
      break;
    case "models_catalog":
      S.modelCatalog = msg.models ?? [];
      renderModelPage();
      break;
    case "model_roles":
      S.modelRoles = msg.roles ?? [];
      if (S.mpRolesView && !S.mpAddView) renderModelPage();
      break;
    case "settings":
      applyHostSettings(msg.settings);
      if (msg.restartHint) toast("已保存，部分网络设置建议重启应用后完全生效");
      break;
    case "profile_switched":
      openSessions.clear();
      S.activePath = null;
      S.selectedSubagent = null;
      S.selectedFile = null;
      renderAll();
      toast(`已激活 Profile: ${msg.profile}`);
      break;
    case "usage_stats":
      S.usageStats = msg.stats;
      renderStatsPage();
      break;
    case "agent_assets":
      S.agentAssets = msg.assets;
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
      // 后台会话等待审批 → 系统通知（msg.title 为宿主下发的审批标题，含工具名摘要）
      notifyDesktop("approval", s, "等待审批", msg.title);
      break;
    }
    case "approval_resolved":
      break; // 本地点击已即时定格
    case "session_list": {
      // 归档条目从正常列表数据拆出：不进 diskProjects（正常分组/最近/置顶消费方全部自动排除），
      // 单独存 S.archivedSessions（含 cwd 的完整条目，按修改时间倒序），侧栏归档区渲染用
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
      S.activePath = msg.path;
      S.selectedSubagent = null;
      S.selectedFile = null;
      S.isCreatingNew = false;
      refreshGitDiff(); // 右栏 Git Diff 页需要 git status 数据，提前预取
      hideWelcomeScreen();
      renderAll();
      if (S.pendingNewPrompt) {
        const { text, files } = S.pendingNewPrompt;
        S.pendingNewPrompt = null;
        const s = activeOpen();
        if (s) {
          s.items.push({ role: "user", text });
          renderAll();
          S.ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
          pinBottom(); // 钉底一小段时间，覆盖图片等资源异步撑高
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
        updateWelcomeGitUI();
      }
      break;
    }
    case "git_branch_switched": {
      if (msg.cwd === S.newSessionProject) {
        S.newSessionBranch = msg.branch;
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
        s.workingText = "正在处理…"; // working 状态行默认文案，后续被 intent/思考覆盖
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
          s.workingText = "正在处理…"; // 思考结束回到默认文案，等待工具 intent 或文本输出
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
        if (msg.intent) s.workingText = msg.intent; // 模型自述的动作（英文原样，如 Reading model role settings）
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
        // auto 档位判定帧：只记判定结果供右下角显示 auto·档位，不改 s.thinking——
        // 上拉菜单的 ✓ 与用户手选状态仍以 s.thinking 为准。切进 auto 的 provisional 帧无
        // resolved，会把上一轮判定清掉，回到纯 "auto" 显示；人工切档帧（无 configured）忽略。
        if (msg.configured === "auto") s.autoResolved = msg.resolved;
      }
      // 流式增量帧（text/thinking delta，长思考可达近千帧）只累积状态，渲染走 100ms
      // 合并节流——每帧同步 renderAll 全量重绘递增文本是 O(n²)，主线程被打爆表现为应用卡死
      if (msg.kind === "text_delta" || msg.kind === "thinking_delta") scheduleDeltaRender();
      else renderAll();
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
      // 底座在结束时（completed/failed/aborted）会用同一 subagentId 重发 lifecycle——
      // 整条覆盖会把运行中累积的 text/tools 清空，完成后详情就没了；只更新状态，保留内容
      const prev = s.subagents.get(msg.subagentId);
      s.subagents.set(msg.subagentId, {
        agent: msg.agent,
        description: msg.description ?? "",
        status: msg.status,
        text: prev?.text ?? "",
        tools: prev?.tools ?? [],
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
      const { expandedDirs } = rightState;
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
    case "queued": {
      // 排队消息快照（发送后入队 / send_now·requeue·drop 回包 / turn_end 消费后校准）
      const s = findBySessionId(msg.sessionId);
      if (s) {
        s.queued = msg.followUp ?? [];
        s.steering = msg.steering ?? [];
        renderQueueLine();
      }
      break;
    }
    case "steer_consumed": {
      // 队列消息即将注入模型（消费即分割点）：先把被消费的气泡从过程流中摘出
      // （消费前它插在流式过程中间，由渲染层固定在底部），再把气泡上方自本轮起点
      // 起的全部过程缩起封存成 loop 组，气泡落底转正，新过程从气泡下重开渲染
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
        renderAll();
      }
      break;
    }
    case "file_diff": {
      fileDiffCache.path = msg.path;
      fileDiffCache.diff = msg.diff;
      fileDiffCache.loading = false;
      briefDiffCache[msg.path] = msg.diff; // 同一份回包同时喂给编辑行内联展开
      if (S.briefDiffPending === msg.path) {
        S.briefDiffPending = null;
        renderChat();
      }
      if (S.rightTab === "gitdiff" && S.selectedFile === msg.path) renderRightBody();
      break;
    }
    case "file_content": {
      // 文件页全文件内容回包：无条件写入（用户可能已切走 tab），文件 tab 可见时立即重绘
      S.fileViewPending = null;
      if (S.fileView && S.fileView.path === msg.path) {
        if (msg.error) S.fileView.error = msg.error;
        else Object.assign(S.fileView, { text: msg.text, startLine: 1, lineNumbers: null, full: true, error: null });
        if (S.rightTab === "file") renderRightBody();
      }
      break;
    }
    case "dir_list": {
      // 文件树单层回包：填充缓存，文件 tab 空态（树视图）时重绘
      const { fileTreePending, fileTreeDirs } = rightState;
      fileTreePending.delete(msg.path);
      fileTreeDirs.set(msg.path, msg.entries ?? []);
      if (S.rightTab === "file" && !S.fileView) renderRightBody();
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
      // 模型管理页配额:仅当选中供应商未变、且模型页仍打开时回填,避免旧响应污染。
      // 多账号:逐账号各渲染一段(头部右侧显示账号身份);单账号走原有单段路径
      const el = $("mpLimSec");
      if (el && msg.provider === S.selectedProvider) {
        if (Array.isArray(msg.accounts) && msg.accounts.length > 1) {
          el.replaceChildren(
            ...msg.accounts.map((a, i) =>
              buildLimitsSection({ ...msg, ...a, label: a.label || a.accountLabel || `账号 ${i + 1}` }),
            ),
          );
        } else {
          el.replaceChildren(buildLimitsSection(msg));
        }
      }
      break;
    }
    case "all_providers":
      S.allProvidersCache = msg.providers ?? [];
      // 详情页打开时响应到达不重绘(会冲掉保存进行中的 pending 态),返回列表时自然用新缓存
      if (S.mpAddView && !S.mpDetailProv) renderAddProviderView();
      break;
    case "login_progress":
      if (msg.reqId !== S.loginReqId) break;
      showLoginBanner(`${msg.provider}：${msg.message}`);
      break;
    case "login_prompt":
      if (msg.reqId !== S.loginReqId) break;
      showLoginPrompt(msg);
      break;
    case "login_done":
      if (msg.reqId !== S.loginReqId) break;
      S.loginBusy = false;
      hideLoginBanner();
      closeLoginPrompt();
      if (msg.ok) {
        toast(`${msg.provider} 登录成功，模型列表已刷新`);
        S.mpAddView = false;
        renderModelPage();
      } else if (msg.cancelled) {
        toast("登录已取消");
      } else {
        toast(`${msg.provider} 登录失败：${msg.message}`);
      }
      break;
    case "provider_key_done":
      toast(`${msg.provider} API key 已保存，模型列表已刷新`);
      // 保存闭环:退出详情页回列表,重拉凭证数让卡片回显「已配置 · N」
      S.mpDetailProv = null;
      send({ type: "get_all_providers" });
      if (S.mpAddView) renderAddProviderView();
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
      if (!memInbox.contentEl) break;
      if (msg.files) {
        memInbox.base = msg.path;
        memInbox.files = msg.files;
        memInbox.rollouts = msg.rollouts ?? [];
        memInbox.active = { name: msg.file, rollout: false };
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
    // ===== 新增功能回包（数据落地集中在此，各域模块只做发起与渲染）=====
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
      // 停止回执：过程流由既有 agent_end/turn_end 事件归位，这里只做轻提示
      toast("已停止生成");
      break;
    case "session_compacted":
      // 压缩成功后宿主主动推 messages 帧重建 transcript（既有 case 处理），这里只提示
      toast(msg.ok ? "上下文已压缩" : (msg.error ?? "压缩失败"));
      break;
    case "session_branched": {
      // 分叉回执：清除防连点标记（成功切走/失败可重试都要清）；transcript 由 load_session
      // 推的 messages 帧重建（宿主在回包前主动推的那帧新会话尚未注册，会被 findBySessionId
      // 丢弃，无害）。新会话对象 streaming:false、队列为空，无需复位
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
        renderAll();
        break;
      }
      toast("已分叉到新分支");
      setComposerValue(msg.selectedText ?? "", msg.selectedImages);
      send({ type: "load_session", path: msg.newPath }); // 复用磁盘会话加载链路：新分支入池并激活（session_created + messages 既有 case）
      send({ type: "list_sessions" }); // 新分支文件入侧栏列表
      break;
    }
    case "session_tree":
      // 分支树回包：sessionId 优先取回包字段，未带时用发起时记录的会话（防切换会话后旧数据污染）
      rightState.sessionTree = { sessionId: msg.sessionId ?? rightState.treeFor, branches: msg.branches ?? [] };
      rightState.sessionTreePending = false;
      renderRight();
      break;
    case "image_content":
      rightState.imageContent = msg; // right.js 文件页图片渲染读取
      renderRight();
      break;
    case "git_staged":
    case "git_unstaged":
      rightState.gitWrite = msg;
      renderRight(); // 回包直接驱动按钮 busy 态收口（right.js 另有轮询兜底，两者兼容）
      if (msg.ok) refreshGitDiff();
      else toast(msg.error ?? "git 操作失败");
      break;
    case "git_discarded":
      rightState.gitWrite = msg;
      renderRight();
      if (msg.ok) {
        toast("已丢弃更改");
        refreshGitDiff();
      } else toast(msg.error ?? "丢弃失败");
      break;
    case "git_committed":
      rightState.gitWrite = msg;
      renderRight();
      if (msg.ok) {
        toast(`已提交 ${(msg.commit ?? "").slice(0, 7)}`);
        refreshGitDiff();
      } else toast(msg.error ?? "提交失败");
      break;
    case "git_pushed":
      rightState.gitWrite = msg;
      renderRight();
      toast(msg.ok ? "已推送" : (msg.error ?? "推送失败"));
      break;
    case "error": {
      gitDiffCache.loading = false;
      rightState.sessionTreePending = false; // 分支树请求失败解除挂起，下次渲染重拉
      if (msg.kind && assetSelPath[msg.kind] && !$(ASSET_PAGES[msg.kind].editor).classList.contains("hidden")) assetStatus(msg.kind, msg.message);
      if (memInbox.contentEl && memInbox.contentEl.textContent === "读取中…") memInbox.contentEl.textContent = `读取失败：${msg.message}`;
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
