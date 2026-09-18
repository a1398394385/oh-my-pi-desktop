// 极简前端：新建会话 / 切换会话 / 发消息 / 看流式回复。
// 协议见 host/host.ts：命令 {create_session|prompt|get_messages}，事件 {ready|session_created|event|messages|error}。
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const sessionListEl = $("session-list");
const inputEl = $("input");
const statusEl = $("conn-status");

/** @type {Map<string, {id:string,label:string,items:Array,assistantDraft:string,streaming:boolean}>} */
const sessions = new Map();
let activeId = null;
let ws = null;
let sessionSeq = 0;

function setConnected(ok, text) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "bad";
}

async function connect() {
  setConnected(false, "连接中…");
  const url = await invoke("ws_url");
  ws = new WebSocket(url);
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onopen = () => setConnected(true, "已连接");
  ws.onclose = () => setConnected(false, "连接已断开");
  ws.onerror = () => setConnected(false, "连接已断开");
}

function onMessage(msg) {
  switch (msg.type) {
    case "session_created": {
      sessionSeq += 1;
      const s = { id: msg.sessionId, label: `会话 ${sessionSeq}`, items: [], assistantDraft: "", streaming: false };
      sessions.set(s.id, s);
      activeId = s.id;
      renderAll();
      break;
    }
    case "event": {
      const s = sessions.get(msg.sessionId);
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
      }
      if (s.items.length === 1 && s.items[0].role === "user") s.label = s.items[0].text.slice(0, 18) || s.label;
      renderAll();
      break;
    }
    case "messages": {
      const s = sessions.get(msg.sessionId);
      if (!s) return;
      s.items = msg.messages.map((m) => ({ role: m.role, text: m.text }));
      renderAll();
      break;
    }
    case "error": {
      const s = msg.sessionId && sessions.get(msg.sessionId);
      (s ?? { items: [] }).items.push({ role: "error", text: msg.message });
      renderAll();
      break;
    }
  }
}

function sendPrompt() {
  const text = inputEl.value.trim();
  if (!text || !activeId || !ws || ws.readyState !== 1) return;
  const s = sessions.get(activeId);
  s.items.push({ role: "user", text });
  inputEl.value = "";
  renderAll();
  ws.send(JSON.stringify({ type: "prompt", sessionId: activeId, text }));
}

function renderAll() {
  // 会话列表
  sessionListEl.innerHTML = "";
  for (const s of sessions.values()) {
    const b = document.createElement("button");
    b.className = "session-item" + (s.id === activeId ? " active" : "");
    b.textContent = (s.streaming ? "● " : "") + s.label;
    b.onclick = () => {
      activeId = s.id;
      renderAll();
    };
    sessionListEl.appendChild(b);
  }
  // 消息区
  messagesEl.innerHTML = "";
  const s = activeId && sessions.get(activeId);
  if (!s) {
    messagesEl.innerHTML = '<div class="placeholder">点左侧「新建会话」开始</div>';
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
}

$("new-session").onclick = () => ws && ws.send(JSON.stringify({ type: "create_session" }));
$("send").onclick = sendPrompt;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

renderAll();
connect();
