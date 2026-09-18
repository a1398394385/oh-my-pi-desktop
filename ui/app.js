// 极简前端：按 project 分组的会话列表（磁盘）+ 新建会话 + 消息收发。
// 协议见 host/host.ts：命令 {create_session|load_session|list_sessions|prompt|get_messages}，
// 事件 {ready|session_list|session_created|event|messages|error}。
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const sessionListEl = $("session-list");
const inputEl = $("input");
const statusEl = $("conn-status");

// WKWebView 无 console：未捕获错误显示在状态栏，便于定位
window.onerror = (msg) => {
  statusEl.textContent = String(msg).slice(0, 120);
  statusEl.className = "bad";
};
window.addEventListener("unhandledrejection", (e) => {
  statusEl.textContent = String(e.reason).slice(0, 120);
  statusEl.className = "bad";
});

/** 磁盘会话列表：[{cwd, sessions:[{path,title,firstMessage,modified,messageCount}]}] */
const diskProjects = [];
/** 已打开（新建或加载）的会话：path -> {sessionId,cwd,items,assistantDraft,streaming,subagents} */
const openSessions = new Map();
let activePath = null;
let selectedSubagent = null; // 右栏流视图选中的 subagentId（null = 卡片列表）
let ws = null;
let loadingPath = null;
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

async function connect() {
  setConnected(false, "连接中…");
  const url = await invoke("ws_url");
  ws = new WebSocket(url);
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onopen = () => {
    setConnected(true, "已连接");
    send({ type: "list_sessions" });
  };
  ws.onclose = () => setConnected(false, "连接已断开");
  ws.onerror = () => setConnected(false, "连接已断开");
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
      // 本地点击已即时定格；此回执仅表示宿主已 resolve，无需处理
      break;
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
        if (msg.thinking) s.thinking = msg.thinking; // 模型切换后的钳制生效值
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
        subagents: new Map(), // subagentId -> {agent,description,status,text,tools,streaming}
        model: msg.model ?? null,
        thinking: msg.thinking ?? "auto",
      });
      activePath = msg.path;
      loadingPath = null;
      selectedSubagent = null;
      renderAll();
      if (pendingCreate) {
        // 新建的会话已落盘，重拉列表让左侧出现对应条目
        pendingCreate = false;
        send({ type: "list_sessions" });
      }
      break;
    }
    case "event": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      if (msg.kind === "turn_start") {
        s.streaming = true;
        s.assistantDraft = "";
      } else if (msg.kind === "text_delta") {
        s.assistantDraft += msg.text;
      } else if (msg.kind === "tool") {
        s.items.push({ role: "tool", text: msg.name });
        s.assistantDraft = ""; // 工具调用前后的文本分段，草稿重开
      } else if (msg.kind === "turn_end") {
        if (s.assistantDraft) s.items.push({ role: "assistant", text: s.assistantDraft });
        s.assistantDraft = "";
        s.streaming = false;
        send({ type: "list_sessions" }); // title/firstMessage 可能已更新
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
      if (msg.kind === "turn_start") {
        sub.streaming = true;
      } else if (msg.kind === "text_delta") {
        sub.text += msg.text;
      } else if (msg.kind === "tool") {
        sub.tools.push(msg.name);
      } else if (msg.kind === "turn_end") {
        sub.streaming = false;
      }
      renderAll();
      break;
    }
    case "error": {
      const s = msg.sessionId && findBySessionId(msg.sessionId);
      if (s) {
        s.items.push({ role: "error", text: msg.message });
        renderAll();
      } else {
        statusEl.textContent = msg.message;
        statusEl.className = "bad";
      }
      break;
    }
  }
}

function sendPrompt() {
  const text = inputEl.value.trim();
  const s = activeOpen();
  if (!text || !s || ws.readyState !== 1) return;
  s.items.push({ role: "user", text });
  inputEl.value = "";
  renderAll();
  ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text }));
}

function newSession() {
  // 新会话挂在当前 project（活跃会话的 cwd）下；无活跃则由宿主用 HOME
  createIn(activeOpen()?.cwd);
}

function createIn(cwd) {
  send(cwd ? { type: "create_session", cwd } : { type: "create_session" });
  pendingCreate = true;
}

function setApprovalModeUi(mode) {
  for (const b of document.querySelectorAll("#approval-bar button[data-mode]")) {
    b.className = b.dataset.mode === mode ? "active" : "";
  }
}

const modelSelect = $("model-select");
const thinkingSelect = $("thinking-select");
const modelNames = new Map(); // modelId -> 显示名
const modelEfforts = new Map(); // modelId -> 支持的思考档位数组
const THINKING_LABELS = { auto: "思考:自动", off: "思考:关", minimal: "思考:极低", low: "思考:低", medium: "思考:中", high: "思考:高", xhigh: "思考:超高", max: "思考:最大" };

// 自绘下拉（WKWebView 原生 select 的弹出菜单不可靠）
function attachDropdown(btn, getItems, onPick) {
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) return close();
    closeCtxMenu();
    const items = getItems();
    if (items.length === 0) return;
    menu = document.createElement("div");
    menu.className = "dd-menu";
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = r.bottom + 4 + "px";
    const maxW = Math.max(...items.map((i) => i.label.length)) * 13 + 40;
    menu.style.width = Math.min(Math.max(maxW, r.width), 280) + "px";
    for (const it of items) {
      const b = document.createElement("button");
      b.textContent = (it.active ? "✓ " : "") + it.label;
      if (it.active) b.className = "chosen";
      b.onclick = (ev) => {
        ev.stopPropagation();
        close();
        onPick(it.value);
      };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
  });
  window.addEventListener("click", close);
  return { close };
}

function currentThinkingLevels() {
  const cur = activeOpen();
  const efforts = cur ? modelEfforts.get(cur.model) ?? [] : [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

attachDropdown(
  modelSelect,
  () => {
    const cur = activeOpen();
    return [...modelNames.entries()].map(([id, name]) => ({ label: name, value: id, active: cur?.model === id }));
  },
  (model) => {
    const s = activeOpen();
    if (s) send({ type: "set_model", sessionId: s.sessionId, model });
  },
);

attachDropdown(
  thinkingSelect,
  () => {
    const cur = activeOpen();
    return currentThinkingLevels().map((lv) => ({ label: THINKING_LABELS[lv] ?? lv, value: lv, active: cur?.thinking === lv }));
  },
  (level) => {
    const s = activeOpen();
    if (s) send({ type: "set_thinking", sessionId: s.sessionId, level });
  },
);

modelSelect.onchange = () => {
  const s = activeOpen();
  if (s) send({ type: "set_model", sessionId: s.sessionId, model: modelSelect.value });
};
thinkingSelect.onchange = () => {
  const s = activeOpen();
  if (s) send({ type: "set_thinking", sessionId: s.sessionId, level: thinkingSelect.value });
};

// 审批模式条只圈三个权限按钮（下拉按钮同在 #approval-bar，不能一起绑）
document.querySelectorAll('#approval-bar button[data-mode]').forEach((b) => {
  b.onclick = () => send({ type: "set_approval_mode", mode: b.dataset.mode });
});

function renderAll() {
  // 左栏：project 分组
  sessionListEl.innerHTML = "";
  for (const p of diskProjects) {
    const group = document.createElement("div");
    group.className = "project-group";
    const head = document.createElement("div");
    head.className = "project-head";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
    name.title = p.cwd;
    const add = document.createElement("button");
    add.className = "project-add";
    add.textContent = "＋";
    add.title = `在 ${p.cwd} 新建会话`;
    add.onclick = () => createIn(p.cwd);
    head.appendChild(name);
    head.appendChild(add);
    group.appendChild(head);
    for (const s of p.sessions) {
      const b = document.createElement("button");
      b.className = "session-item" + (s.path === activePath ? " active" : "");
      b.dataset.path = s.path;
      const label = s.title || s.firstMessage || "（空会话）";
      b.textContent = (openSessions.get(s.path)?.streaming ? "● " : "") + label;
      b.onclick = () => {
        if (openSessions.has(s.path)) {
          activePath = s.path;
        } else {
          loadingPath = s.path;
          send({ type: "load_session", path: s.path });
        }
        selectedSubagent = null;
        renderAll();
      };
      group.appendChild(b);
    }
    sessionListEl.appendChild(group);
  }

  // 右侧消息区
  messagesEl.innerHTML = "";
  const s = activeOpen();
  if (!s) {
    messagesEl.innerHTML = '<div class="placeholder">点左侧会话或「新建会话」开始</div>';
    return;
  }
  for (const item of s.items) {
    const div = document.createElement("div");
    if (item.role === "user") {
      div.className = "bubble user";
      div.textContent = item.text;
    } else if (item.role === "assistant") {
      div.className = "bubble assistant";
      div.textContent = item.text;
    } else if (item.role === "tool") {
      div.className = "tool-line";
      div.textContent = `⚙ ${item.text}`;
    } else if (item.role === "approval") {
      div.className = "approval-card";
      const title = document.createElement("pre");
      title.className = "approval-title";
      title.textContent = item.title;
      div.appendChild(title);
      const btns = document.createElement("div");
      btns.className = "approval-buttons";
      let inputEl = null;
      if (item.editable) {
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "approval-input";
        inputEl.placeholder = "输入后点提交…";
        inputEl.value = item.prefill || "";
        if (item.answer !== null) inputEl.disabled = true;
        inputEl.oninput = () => {
          item.prefill = inputEl.value; // 全量重绘时保住已输入内容
        };
        btns.appendChild(inputEl);
      }
      for (const opt of item.options) {
        const b = document.createElement("button");
        b.textContent = item.answer !== null && item.answer === opt ? `✓ ${opt}` : opt;
        if (item.answer !== null) b.disabled = true;
        if (item.answer === opt) b.className = "chosen";
        else if (item.answer !== null && item.answer !== opt) b.className = "dim";
        b.onclick = () => {
          if (item.answer !== null) return;
          let answer = opt;
          if (item.editable) {
            if (opt === "提交") answer = inputEl.value.trim() || null; // 空输入按取消处理
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
      div.className = "error-line";
      div.textContent = `✗ ${item.text}`;
    }
    messagesEl.appendChild(div);
  }
  if (s.streaming || s.assistantDraft) {
    const div = document.createElement("div");
    div.className = "bubble assistant streaming";
    div.textContent = s.assistantDraft || "…";
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // 模型/思考按钮跟随当前会话（无活跃会话禁用）
  const cur = activeOpen();
  modelSelect.disabled = thinkingSelect.disabled = !cur;
  modelSelect.textContent = cur?.model ? (modelNames.get(cur.model) ?? cur.model) : "模型";
  thinkingSelect.textContent = cur ? (THINKING_LABELS[cur.thinking] ?? cur.thinking ?? "思考") : "思考";
  renderSubagentPanel();
}

// 右栏：当前会话的子代理卡片列表；点击卡片进入该子代理的实时流视图
function renderSubagentPanel() {
  const body = $("subagent-body");
  body.innerHTML = "";
  const s = activeOpen();
  if (!s || s.subagents.size === 0) {
    body.innerHTML = '<div class="placeholder">（暂无子代理）</div>';
    return;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    const sub = s.subagents.get(selectedSubagent);
    const back = document.createElement("button");
    back.className = "sub-back";
    back.textContent = "← 返回列表";
    back.onclick = () => {
      selectedSubagent = null;
      renderAll();
    };
    body.appendChild(back);
    const title = document.createElement("div");
    title.className = "sub-title";
    title.textContent = `${sub.agent} · ${sub.status}`;
    body.appendChild(title);
    const stream = document.createElement("div");
    stream.className = "sub-stream";
    for (const t of sub.tools) {
      const d = document.createElement("div");
      d.className = "tool-line";
      d.textContent = `⚙ ${t}`;
      stream.appendChild(d);
    }
    const d = document.createElement("div");
    d.className = "bubble assistant" + (sub.streaming ? " streaming" : "");
    d.textContent = sub.text || "…";
    stream.appendChild(d);
    body.appendChild(stream);
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
    name.className = "sub-name";
    name.textContent = sub.agent;
    head.appendChild(dot);
    head.appendChild(name);
    const desc = document.createElement("div");
    desc.className = "sub-desc";
    desc.textContent = sub.description || sub.text.slice(0, 60) || "…";
    card.appendChild(head);
    card.appendChild(desc);
    card.onclick = () => {
      selectedSubagent = id;
      renderAll();
    };
    body.appendChild(card);
  }
}

$("new-session").onclick = newSession;
$("send").onclick = sendPrompt;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

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

sessionListEl.addEventListener("contextmenu", (e) => {
  const el = e.target.closest(".session-item");
  if (!el) return;
  e.preventDefault();
  closeCtxMenu();
  const path = el.dataset.path;
  const entry = diskProjects.flatMap((p) => p.sessions).find((s) => s.path === path);
  if (!entry) return;
  ctxMenu = document.createElement("div");
  ctxMenu.className = "ctx-menu";
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 70);
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
  for (const [label, value] of [
    ["复制 sessionId", entry.id ?? ""],
    ["复制会话文件路径", entry.path],
  ]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      copyText(value);
      closeCtxMenu();
    };
    ctxMenu.appendChild(b);
  }
  document.body.appendChild(ctxMenu);
});
window.addEventListener("click", closeCtxMenu);
window.addEventListener("blur", closeCtxMenu);

// ---------- Cmd +/-/0 缩放 ----------
// 只缩放三个布局容器：body 整体 zoom 会把 position:fixed 的菜单二次缩放，
// 导致右键菜单/下拉的渲染偏移与点击命中错位
const zoomTargets = ["sidebar", "main", "subagent-panel"].map((id) => $(id));
let zoomLevel = 1;
function applyZoom() {
  for (const el of zoomTargets) el.style.zoom = zoomLevel;
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

renderAll();
connect();
