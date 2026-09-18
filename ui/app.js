/* omp desktop 前端：纯 vanilla JS，经 Tauri IPC 与 Rust 会话 actor 通信。
 *
 * 已知坑（实测）：
 * - omp 会把 turn/message/tool 事件重复发送两遍 → 渲染必须幂等（按 key 去重）
 * - 审批帧是 extension_ui_request + method:"select"，工具名/路径/内容在多行 title 里
 * - 值域（模型/思考档位）一律来自 omp：get_available_models / get_state().model.thinking.efforts
 */
const T = window.__TAURI__;
const invoke = T.core.invoke;
const Channel = T.ipc.Channel;

const $ = (s, r = document) => r.querySelector(s);

const S = {
  cwd: "",
  key: null,
  sessionFile: null,
  sessionId: null,
  state: null, // 最近一次 get_state 快照
  models: [],
  running: false,
  decided: new Set(), // 已应答的审批 id
  seenMsgEnd: new Set(), // message_end 去重（omp 重复帧）
  cur: null, // 当前流式上下文 { turnEl, streamEl, textBuf, thinkBuf, startTs }
  tools: new Map(), // toolCallId -> { el, stEl, ioEl, done }
  busy: false, // spawn/close 进行中
};

/* ── 小工具 ── */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "i");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#ic-${name}`);
  s.appendChild(u);
  return s;
}
function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}
function fmtTime(ms) {
  const d = new Date(ms);
  const now = Date.now();
  if (now - ms < 60_000) return "刚刚";
  if (now - ms < 3600_000) return Math.floor((now - ms) / 60_000) + " 分前";
  if (now - ms < 86400_000) return Math.floor((now - ms) / 3600_000) + " 小时前";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function toast(msg, isErr) {
  const box = $(".toasts") || (() => { const d = el("div", "toasts"); document.body.appendChild(d); return d; })();
  const t = el("div", "toast" + (isErr ? " err" : ""), msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}
function scrollBottom() {
  const st = $("#stream");
  st.scrollTop = st.scrollHeight;
}
function setConn(text, s) {
  const c = $("#connState");
  c.textContent = text;
  c.dataset.s = s || "";
}

/* ── 消息流渲染 ── */
function appendUserTurn(text) {
  const turn = el("div", "turn");
  const u = el("div", "turn-user");
  u.appendChild(el("div", "bubble", text));
  turn.appendChild(u);
  $("#streamInner").appendChild(turn);
  scrollBottom();
  return turn;
}

function currentAgentTurn() {
  if (S.cur && document.contains(S.cur.turnEl)) return S.cur;
  // 无进行中的 turn：新开一个（历史渲染 / 事件乱序兜底）
  const turn = el("div", "turn");
  const a = el("div", "turn-agent");
  turn.appendChild(a);
  $("#streamInner").appendChild(turn);
  S.cur = { turnEl: a, streamEl: null, textBuf: "", thinkBuf: null, thinkEl: null, textEl: null };
  return S.cur;
}

function closeStream() {
  if (!S.cur) return;
  S.cur.streamEl = null;
  S.cur.textEl = null;
  S.cur.thinkEl = null;
  S.cur.textBuf = "";
}

function renderThinkingBlock(c) {
  if (!c.thinkBuf) return null;
  const d = el("details", "thinking-block");
  d.appendChild(el("summary", null, "思考过程"));
  d.appendChild(el("div", "thinking-body", c.thinkBuf));
  return d;
}

// 流式增量：thinking 先于 text 出现时也要分别持有占位
function ensureStreamEls(c) {
  if (!c.streamEl) {
    c.streamEl = el("div", "streaming");
    c.turnEl.appendChild(c.streamEl);
  }
  if (c.thinkBuf != null && !c.thinkEl) {
    const d = el("details", "thinking-block");
    d.open = true;
    d.appendChild(el("summary", null, "思考过程"));
    c.thinkBody = el("div", "thinking-body", "");
    d.appendChild(c.thinkBody);
    c.streamEl.appendChild(d);
    c.thinkEl = c.thinkBody;
  }
  if (c.textBuf !== "" && !c.textEl) {
    c.textEl = el("div", "prose");
    const p = el("p", null, "");
    p.style.whiteSpace = "pre-wrap";
    c.textEl.appendChild(p);
    c.streamEl.appendChild(c.textEl);
  }
}

function updateStreamText(c) {
  ensureStreamEls(c);
  if (c.thinkEl) c.thinkEl.textContent = c.thinkBuf;
  if (c.textEl) c.textEl.firstChild.textContent = c.textBuf;
  scrollBottom();
}

// message_end 定稿：thinking 折叠 + text 正式块（含 toolCall 占位在外层处理）
function renderFinalAssistant(c, msg) {
  if (c.streamEl) {
    // 用最终内容重建流式区（含未完成的 toolcall_delta 等）
    const parts = el("div");
    for (const part of msg.content ?? []) {
      if (part.type === "thinking" && part.thinking) {
        const d = el("details", "thinking-block");
        d.appendChild(el("summary", null, "思考过程"));
        d.appendChild(el("div", "thinking-body", part.thinking));
        parts.appendChild(d);
      } else if (part.type === "text" && part.text) {
        const p = el("div", "prose");
        const t = el("p", null, part.text);
        t.style.whiteSpace = "pre-wrap";
        p.appendChild(t);
        parts.appendChild(p);
      }
      // toolCall 由 tool_execution_start 渲染，这里跳过
    }
    c.streamEl.replaceWith(parts);
  }
  closeStream();
}

function toolSummary(frame) {
  const args = frame.args ?? {};
  if (frame.intent) return frame.intent;
  for (const k of ["path", "file_path", "command", "url", "query", "pattern", "description"]) {
    if (typeof args[k] === "string" && args[k]) {
      const one = args[k].split("\n")[0];
      return one.length > 120 ? one.slice(0, 120) + "…" : one;
    }
  }
  const j = JSON.stringify(args);
  return j.length > 120 ? j.slice(0, 120) + "…" : j;
}

function appendToolLine(frame) {
  const c = currentAgentTurn();
  if (S.tools.has(frame.toolCallId)) return S.tools.get(frame.toolCallId);
  const d = el("details", "toolline");
  const sum = el("summary");
  sum.appendChild(el("span", "name", frame.toolName ?? "tool"));
  sum.appendChild(el("span", "arg", toolSummary(frame)));
  const st = el("span", "st");
  st.appendChild(el("span", "dot"));
  sum.appendChild(st);
  d.appendChild(sum);
  const io = el("div", "io");
  io.hidden = true;
  d.appendChild(io);
  c.turnEl.appendChild(d);
  const rec = { el: d, stEl: st, ioEl: io, done: false };
  S.tools.set(frame.toolCallId, rec);
  scrollBottom();
  return rec;
}

function toolResultText(result) {
  if (!result) return "";
  return (result.content ?? [])
    .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
    .join("\n");
}

function completeToolLine(frame) {
  const rec = S.tools.get(frame.toolCallId);
  if (!rec || rec.done) return;
  rec.done = true;
  const err = !!frame.isError;
  rec.stEl.className = "st " + (err ? "err" : "ok");
  rec.stEl.textContent = "";
  rec.stEl.appendChild(icon(err ? "x" : "check"));
  const text = toolResultText(frame.result);
  if (text) {
    rec.ioEl.textContent = text;
    rec.ioEl.hidden = false;
  }
  refreshSoon();
}

/* ── 审批卡（fail closed：取消 = cancelled）── */
function appendApproval(frame) {
  if (S.decided.has(frame.id)) return;
  const c = currentAgentTurn();
  const card = el("div", "permission");
  const head = el("div", "permission-head");
  head.appendChild(el("div", "ttl", frame.method === "confirm" ? "需要确认" : "需要授权"));
  head.appendChild(el("span", "when", "等待确认"));
  card.appendChild(head);

  // 多行 title 拆分展示：首行标题、Path/命令行为 mono、Content 之后进代码块
  const lines = String(frame.title ?? "").split("\n");
  let i = 0;
  if (lines.length && lines[0]) {
    card.appendChild(el("p", null, lines[0]));
    i = 1;
  }
  const mid = [];
  let codeLines = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (codeLines !== null) codeLines.push(l);
    else if (/^(Content|命令|Command|Code|Diff)\s*:/i.test(l)) {
      codeLines = [];
      if (l) mid.push(l);
    } else mid.push(l);
  }
  if (mid.length) card.appendChild(el("p", null, mid.join("\n")));
  if (codeLines !== null && codeLines.join("").trim()) {
    card.appendChild(el("div", "cmdbox", codeLines.join("\n")));
  }
  if (frame.message) card.appendChild(el("p", null, frame.message));

  const actions = el("div", "permission-actions");
  card.appendChild(actions);
  const done = (verdictText) => {
    S.decided.add(frame.id);
    card.classList.add("done");
    actions.replaceChildren();
    const v = el("div", "verdict");
    v.appendChild(icon("check"));
    v.appendChild(el("span", null, verdictText));
    card.appendChild(v);
    if (S.approval?.id === frame.id) S.approval = null;
  };

  const answer = async (payload, verdictText) => {
    try {
      await invoke("omp_ui_response", { key: S.key, frame: { type: "extension_ui_response", id: frame.id, ...payload } });
      done(verdictText);
    } catch (e) {
      toast("审批应答失败: " + e, true);
    }
  };
  const cancel = () => answer({ cancelled: true }, "已取消（未放行）");

  if (frame.method === "select") {
    for (const opt of frame.options ?? []) {
      const b = el("button", "btn" + (/deny|reject|no\b/i.test(opt) ? " danger" : " primary"), opt);
      b.onclick = () => answer({ value: opt }, `已选择：${opt}`);
      actions.appendChild(b);
    }
    const c2 = el("button", "btn", "取消");
    c2.onclick = cancel;
    actions.appendChild(c2);
  } else if (frame.method === "confirm") {
    const ok = el("button", "btn primary", "允许");
    ok.onclick = () => answer({ confirmed: true }, "已允许");
    const no = el("button", "btn danger", "拒绝");
    no.onclick = cancel;
    actions.append(ok, no);
  } else if (frame.method === "input" || frame.method === "editor") {
    const input = document.createElement("input");
    input.style.cssText = "flex:1;background:var(--code-bg);border:1px solid var(--line);border-radius:6px;padding:6px 9px;font-size:var(--fs-sm);outline:none";
    input.value = frame.placeholder ?? "";
    if (frame.placeholder) input.disabled = true;
    actions.appendChild(input);
    const ok = el("button", "btn primary", "提交");
    ok.onclick = () => answer({ value: input.value }, "已提交");
    const no = el("button", "btn", "取消");
    no.onclick = cancel;
    actions.append(ok, no);
    input.focus();
  } else {
    // 未知 method：绝不默认放行，直接取消
    card.appendChild(el("p", null, `未支持的审批类型：${frame.method}，将自动取消。`));
    const c2 = el("button", "btn", "取消");
    c2.onclick = cancel;
    actions.appendChild(c2);
  }

  c.turnEl.appendChild(card);
  scrollBottom();
  S.approval = { id: frame.id, cancel };
}

/* ── 事件分发 ── */
function handleFrame(f) {
  switch (f.type) {
    case "desktop_ready": onReady(); return;
    case "desktop_error": toast(f.error ?? "未知错误", true); setConn("异常", "err"); return;
    case "desktop_exit":
      setConn(`进程退出(${f.code ?? "?"})`, "err");
      toast(`omp 进程已退出（code=${f.code ?? "?"}）`, true);
      S.running = false;
      updateSendBtn();
      refreshSoon();
      return;
    case "response":
      // 带 id 的响应已被 invoke 等待；unknown-id 的失败响应提示
      if (f.success === false) toast(`${f.command ?? "?"} 失败: ${f.error ?? ""}`, true);
      return;
    case "agent_start":
      S.running = true;
      updateSendBtn();
      setConn("生成中", "ok");
      return;
    case "agent_end": {
      const terminal = f.isTerminal !== false;
      if (terminal) {
        S.running = false;
        closeStream();
        S.cur = null;
        updateSendBtn();
        setConn("已就绪", "ok");
        refreshSoon();
        refreshSessions();
      }
      return;
    }
    case "message_start": {
      const m = f.message ?? {};
      if (m.role !== "assistant") return;
      const c = currentAgentTurn();
      if (c.streamEl) return; // 重复帧幂等
      ensureStreamEls(c);
      return;
    }
    case "message_update": {
      const ev = f.assistantMessageEvent;
      if (!ev) return;
      const c = currentAgentTurn();
      if (ev.type === "text_delta") {
        c.textBuf = (c.textBuf ?? "") + (ev.delta ?? "");
        updateStreamText(c);
      } else if (ev.type === "thinking_delta") {
        if (c.thinkBuf == null) c.thinkBuf = "";
        c.thinkBuf += ev.delta ?? "";
        updateStreamText(c);
      }
      // toolcall_delta：等 message_end 的完整 toolCall
      return;
    }
    case "message_end": {
      const m = f.message ?? {};
      const key = `${m.role}:${m.timestamp}`;
      if (S.seenMsgEnd.has(key)) return;
      S.seenMsgEnd.add(key);
      if (m.role === "assistant") {
        const c = currentAgentTurn();
        renderFinalAssistant(c, m);
      } else if (m.role === "toolResult") {
        completeToolLine(m);
      }
      return;
    }
    case "tool_execution_start": {
      appendToolLine(f);
      return;
    }
    case "tool_execution_end": {
      completeToolLine(f);
      return;
    }
    case "tool_execution_update": {
      // 进度输出：显示在对应工具行
      const rec = S.tools.get(f.toolCallId);
      if (rec && !rec.done) {
        const t = toolResultText(f.partialResult ?? f.result);
        if (t) { rec.ioEl.textContent = t; rec.ioEl.hidden = false; }
      }
      return;
    }
    case "extension_ui_request": {
      if (f.method === "notify" || f.method === "setStatus" || f.method === "setWidget" || f.method === "setTitle") return;
      appendApproval(f);
      return;
    }
    case "model_changed":
    case "thinking_level_changed":
      refreshSoon();
      return;
    case "notice":
      toast(f.message ?? "", false);
      return;
    default:
      // auto_compaction_* / turn_* / available_commands_update / todo_reminder 等暂不渲染
      return;
  }
}

/* ── 状态面板 ── */
function todoStats() {
  const phases = S.state?.todoPhases ?? [];
  let done = 0, total = 0;
  for (const ph of phases) for (const t of ph.tasks ?? []) { total++; if (t.status === "completed") done++; }
  return { done, total, phases };
}

function renderPanel() {
  const body = $("#panelBody");
  body.replaceChildren();
  const st = S.state;
  const sec = (iconName, label, n) => {
    const s = el("div", "p-sec");
    const h = el("div", "p-sec-head");
    h.appendChild(icon(iconName));
    h.appendChild(el("span", null, label));
    if (n !== undefined) h.appendChild(el("span", "n", n));
    s.appendChild(h);
    body.appendChild(s);
    return s;
  };

  // 进程（todoPhases）
  const { done, total, phases } = todoStats();
  const ps = sec("list", "进程", total ? `${done}/${total}` : "");
  if (!phases.length) ps.appendChild(el("div", "p-empty", "暂无任务清单"));
  for (const ph of phases) {
    if (phases.length > 1) ps.appendChild(el("div", "p-row", ph.name ?? "阶段"));
    for (const t of ph.tasks ?? []) {
      const r = el("div", "p-row");
      const stc = el("span", "st" + (t.status === "completed" ? " done" : t.status === "in_progress" ? " doing" : ""));
      stc.textContent = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○";
      r.appendChild(stc);
      r.appendChild(el("span", "lbl", t.content ?? ""));
      ps.appendChild(r);
    }
  }

  // 模型与思考档位
  const model = st?.model;
  const ms = sec("model", "模型");
  if (model) {
    const kv = el("div", "p-kv");
    kv.appendChild(el("span", "k", "当前"));
    kv.appendChild(el("span", "v mono", `${model.provider}/${model.id}`));
    ms.appendChild(kv);
    const kv2 = el("div", "p-kv");
    kv2.appendChild(el("span", "k", "思考档位"));
    kv2.appendChild(el("span", "v mono", st.thinkingLevel ?? "—"));
    ms.appendChild(kv2);
  } else {
    ms.appendChild(el("div", "p-empty", "未连接"));
  }

  // 上下文占用
  const cu = st?.contextUsage;
  const cs = sec("file", "上下文", cu ? `${fmtTokens(cu.tokens)} / ${fmtTokens(cu.contextWindow)}` : "");
  if (cu) {
    const bar = el("div", "p-bar");
    const fill = el("span", "fill");
    fill.style.width = Math.min(100, Math.max(0, cu.percent ?? 0)) + "%";
    bar.appendChild(fill);
    cs.appendChild(bar);
  }

  // 运行中的智能体（get_subagents 快照）
  const ag = sec("users", "智能体", S.subagents?.length ? String(S.subagents.length) : "");
  if (!S.subagents?.length) ag.appendChild(el("div", "p-empty", "无运行中的智能体"));
  for (const sa of S.subagents ?? []) {
    const r = el("div", "p-row");
    r.appendChild(el("span", "st", "·"));
    r.appendChild(el("span", "lbl", sa.name ?? sa.id ?? "subagent"));
    if (sa.description) r.appendChild(el("span", "sub", String(sa.description).slice(0, 40)));
    ag.appendChild(r);
  }

  $("#panelProgress").textContent = total ? `进程 ${done}/${total}` : "";
}

let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refreshState();
  }, 400);
}

async function refreshState() {
  if (!S.key) return;
  try {
    const res = await invoke("omp_request", { key: S.key, payload: { type: "get_state" } });
    if (res.success) {
      S.state = res.data ?? null;
      if (res.data?.sessionFile) S.sessionFile = res.data.sessionFile;
      if (res.data?.sessionId) S.sessionId = res.data.sessionId;
      if (res.data?.sessionName) $("#sessionTitle").textContent = res.data.sessionName || "新会话";
      const cu = res.data?.contextUsage;
      if (cu) {
        $("#ctxText").textContent = `${fmtTokens(cu.tokens)} / ${fmtTokens(cu.contextWindow)}`;
        $("#ctxFill").style.transform = `scaleX(${Math.min(1, (cu.percent ?? 0) / 100)})`;
      }
      renderPanel();
      renderModelPill();
    }
    const sa = await invoke("omp_request", { key: S.key, payload: { type: "get_subagents" } });
    if (sa.success) S.subagents = sa.data?.subagents ?? [];
    renderPanel();
  } catch (e) {
    // 会话不存在（进程退出中）等：静默，desktop_exit 已提示
    console.warn("refreshState", e);
  }
}

/* ── 模型 / 档位下拉 ── */
function renderModelPill() {
  const m = S.state?.model;
  $("#modelLabel").textContent = m ? (m.name || m.id) : "…";
  const efforts = m?.thinking?.efforts ?? [];
  const lv = S.state?.thinkingLevel;
  $("#effortLabel").textContent = lv ?? (efforts.length ? efforts[0] : "—");
}

function openMenu(anchor, title, items, onPick) {
  const menu = $("#menu");
  menu.replaceChildren();
  if (title) menu.appendChild(el("div", "mhead", title));
  for (const it of items) {
    const b = el("button", "mi");
    b.setAttribute("role", "menuitem");
    b.appendChild(el("span", null, it.label));
    if (it.sub) b.appendChild(el("span", "sub", it.sub));
    if (it.selected) {
      const t = el("span", "tick");
      t.appendChild(icon("check"));
      b.appendChild(t);
    }
    b.onclick = () => { closeMenu(); onPick(it); };
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 10);
  let top = r.top - mh - 6;
  if (top < 8) top = r.bottom + 6;
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = top + "px";
  setTimeout(() => document.addEventListener("click", closeMenuOnce, { once: true }), 0);
}
function closeMenuOnce(ev) {
  if ($("#menu").contains(ev.target)) {
    document.addEventListener("click", closeMenuOnce, { once: true });
    return;
  }
  closeMenu();
}
function closeMenu() { $("#menu").hidden = true; }

function showModelMenu() {
  const cur = S.state?.model;
  const items = S.models.map((m) => ({
    label: m.name || m.id,
    sub: `${m.provider}/${m.id}`,
    selected: cur && cur.provider === m.provider && cur.id === m.id,
    value: m,
  }));
  openMenu($("#modelPill"), "选择模型", items, async (it) => {
    try {
      const res = await invoke("omp_request", {
        key: S.key,
        payload: { type: "set_model", provider: it.value.provider, modelId: it.value.id },
      });
      if (!res.success) toast("切换模型失败: " + (res.error ?? ""), true);
    } catch (e) { toast("切换模型失败: " + e, true); }
    await refreshState();
  });
}

function showEffortMenu() {
  const efforts = S.state?.model?.thinking?.efforts ?? [];
  const cur = S.state?.thinkingLevel;
  if (!efforts.length) { toast("当前模型未提供思考档位", false); return; }
  const items = efforts.map((lv) => ({ label: lv, selected: lv === cur, value: lv }));
  openMenu($("#effortPill"), "思考档位", items, async (it) => {
    try {
      const res = await invoke("omp_request", {
        key: S.key,
        payload: { type: "set_thinking_level", level: it.value },
      });
      if (!res.success) toast("切换档位失败: " + (res.error ?? ""), true);
    } catch (e) { toast("切换档位失败: " + e, true); }
    await refreshState();
  });
}

/* ── 会话列表 ── */
async function refreshSessions() {
  try {
    const metas = await invoke("omp_list_sessions", { cwd: S.cwd });
    renderSessionList(metas ?? []);
  } catch (e) {
    console.warn("refreshSessions", e);
  }
}

function renderSessionList(metas) {
  const list = $("#sessionList");
  list.replaceChildren();
  if (!metas.length) {
    list.appendChild(el("div", "sb-empty", "暂无会话"));
    return;
  }
  for (const m of metas) {
    const b = el("button", "session");
    b.setAttribute("aria-current", String(m.path === S.sessionFile));
    const dot = el("span", "state-dot");
    dot.dataset.s = m.path === S.sessionFile && S.running ? "running" : "done";
    b.appendChild(dot);
    b.appendChild(el("span", "session-title", m.title || "未命名会话"));
    b.appendChild(el("span", "session-meta", fmtTime(m.mtime_ms)));
    b.title = m.path;
    b.onclick = () => switchSession(m.path);
    list.appendChild(b);
  }
}

/* ── 会话生命周期 ── */
async function startSession(resumePath) {
  if (S.busy) return;
  S.busy = true;
  try {
    if (S.key) {
      try { await invoke("omp_close", { key: S.key }); } catch (e) { console.warn("close old", e); }
      S.key = null;
    }
    S.running = false;
    S.tools.clear();
    S.seenMsgEnd.clear();
    S.decided.clear();
    S.cur = null;
    S.state = null;
    S.subagents = [];
    S.sessionFile = resumePath ?? null;
    S.sessionId = null;
    $("#streamInner").replaceChildren();
    $("#sessionTitle").textContent = resumePath ? "加载中…" : "新会话";
    setConn("连接中…", "");

    const ch = new Channel();
    ch.onmessage = handleFrame;
    const res = await invoke("omp_spawn", { cwd: null, resume: resumePath ?? null, onEvent: ch });
    S.key = res.key;
    S.cwd = res.cwd;
    $("#cwdLabel").textContent = res.cwd;
    $("#cwdLabel").title = res.cwd;
    $("#whereCwd").textContent = res.cwd.split("/").slice(-1)[0] || res.cwd;
    $("#whereCwd").title = res.cwd;
    updateSendBtn();
  } finally {
    S.busy = false;
  }
}

async function onReady() {
  setConn("已就绪", "ok");
  // 值域一律从 omp 读
  try {
    const r = await invoke("omp_request", { key: S.key, payload: { type: "get_available_models" } });
    if (r.success) S.models = r.data?.models ?? [];
  } catch (e) { console.warn("models", e); }
  await refreshState();
  if (S.sessionFile) await loadHistory();
  await refreshSessions();
}

async function switchSession(path) {
  if (path === S.sessionFile) return;
  if (S.running) { toast("生成中，请先停止再切换会话", true); return; }
  await startSession(path);
}

async function loadHistory() {
  let cursor;
  let messages = [];
  while (true) {
    let res;
    try {
      res = await invoke("omp_request", {
        key: S.key,
        payload: { type: "get_messages_page", ...(cursor ? { cursor } : {}), limit: 256 },
      });
    } catch (e) {
      toast("加载历史失败: " + e, true);
      return;
    }
    if (!res.success) {
      toast("加载历史失败: " + (res.error ?? ""), true);
      return;
    }
    messages.push(...(res.data?.messages ?? []));
    cursor = res.data?.nextCursor;
    if (!cursor) break;
  }
  for (const m of messages) renderHistoryMessage(m);
  scrollBottom();
}

function renderHistoryMessage(m) {
  if (m.role === "user") {
    const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text) {
      appendUserTurn(text);
      S.cur = null;
    }
    return;
  }
  if (m.role === "assistant") {
    for (const part of m.content ?? []) {
      if (part.type === "thinking" && part.thinking) {
        const c = currentAgentTurn();
        const d = el("details", "thinking-block");
        d.appendChild(el("summary", null, "思考过程"));
        d.appendChild(el("div", "thinking-body", part.thinking));
        c.turnEl.appendChild(d);
      } else if (part.type === "text" && part.text) {
        const c = currentAgentTurn();
        const p = el("div", "prose");
        const t = el("p", null, part.text);
        t.style.whiteSpace = "pre-wrap";
        p.appendChild(t);
        c.turnEl.appendChild(p);
      } else if (part.type === "toolCall") {
        appendToolLine({ toolCallId: part.id, toolName: part.name, args: part.arguments, intent: part.intent });
      }
    }
    return;
  }
  if (m.role === "toolResult") {
    completeToolLine({ toolCallId: m.toolCallId, result: { content: m.content }, isError: m.isError });
    return;
  }
}

/* ── 输入区 ── */
function updateSendBtn() {
  const btn = $("#sendBtn");
  const hasText = $("#input").value.trim().length > 0;
  btn.dataset.stop = String(S.running);
  btn.dataset.ready = String(hasText && !S.running);
  btn.title = S.running ? "停止生成" : "发送";
  btn.querySelector("use").setAttribute("href", S.running ? "#ic-stop" : "#ic-send");
}

async function sendOrStop() {
  const btn = $("#sendBtn");
  if (S.running) {
    btn.disabled = true;
    try {
      await invoke("omp_request", { key: S.key, payload: { type: "abort" } });
      toast("已发送中断", false);
    } catch (e) { toast("中断失败: " + e, true); }
    btn.disabled = false;
    return;
  }
  const input = $("#input");
  const text = input.value.trim();
  if (!text || !S.key) return;
  appendUserTurn(text);
  input.value = "";
  updateSendBtn();
  try {
    const res = await invoke("omp_request", { key: S.key, payload: { type: "prompt", message: text } });
    if (!res.success) {
      toast("发送失败: " + (res.error ?? ""), true);
    }
  } catch (e) {
    toast("发送失败: " + e, true);
  }
  updateSendBtn();
}

/* ── 启动 ── */
function wireUI() {
  const input = $("#input");
  input.addEventListener("input", () => {
    updateSendBtn();
    input.style.height = "auto";
    input.style.height = Math.min(168, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      if (!S.running) sendOrStop();
      else toast("生成中——先点停止，或等待完成", false);
    }
  });
  $("#sendBtn").onclick = sendOrStop;
  $("#modelPill").onclick = showModelMenu;
  $("#effortPill").onclick = showEffortMenu;
  $("#btnNewSession").onclick = async () => {
    if (S.running) { toast("生成中，请先停止", true); return; }
    await startSession(null);
  };
  $("#panelMini").onclick = () => {
    $("#panel").dataset.mode = "hidden";
    $("#panelCapsule").hidden = false;
  };
  $("#panelCapsule").onclick = () => {
    $("#panel").dataset.mode = "expanded";
    $("#panelCapsule").hidden = true;
  };
  document.addEventListener("keydown", (ev) => {
    // fail closed：Esc = 取消当前审批（不放行）
    if (ev.key === "Escape") {
      if (!$("#menu").hidden) { closeMenu(); return; }
      S.approval?.cancel?.();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "n") {
      ev.preventDefault();
      $("#btnNewSession").click();
    }
  });
}

async function boot() {
  wireUI();
  await startSession(null);
}

boot();
