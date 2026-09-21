// 中栏：标题 + 消息流。单条消息 → DOM（appendChatItem）+ 消息轨道刻度；
// loop 组展开时对子 items 递归复用；turn_end 后由 core 收进 loop 组自动收起。
import { $, S, streamEl, send, activeOpen, diskProjects, isJunkPlaceholder, fmtTokens, renderAll,
  sendNowQueueMsg, editQueueMsg, dropQueueMsg, requeueSteerMsg } from "./core.js";
import { renderAssistantMessage, ensureScrollBottom, updateScrollBottomVis } from "./markdown.js";
import { renderToolItem, renderThink } from "./tool-labels.js";
import { isEditEvent } from "./tool-rows.js";
import { railToolText, buildMsgRail, dismissRailPop } from "./ringpop.js";
import { sessionLabel, fmtDuration } from "./sidebar.js";
import { showWelcomeScreen, hideWelcomeScreen } from "./welcome.js";

// 渲染条目列表：连续编辑事件（edit/write/apply_patch）合并为一个「更改」组，其余逐条渲染。
// parent：挂载容器（默认 #stream；loop 组子项挂进 .lp-kids 容器做整组展开/收起动画）
// pfx：会话内查找的 DOM 锚前缀（顶层为 ""，loop 子项为 父key+"-"），最终 key 写入 data-fk
function renderItemList(items, railEntries, parent = streamEl, pfx = "") {
  const pendingSteers = []; // steer 待消费气泡收集到末尾统一渲染：消费前位置一直低于处理进程区
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = pfx + i;
    if (item.role === "user" && item.pending === "steer") {
      pendingSteers.push({ item, key });
      continue;
    }
    if (isEditEvent(item)) {
      const subs = [item];
      while (i + 1 < items.length && isEditEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem = { role: "tool", text: "更改", group: subs };
        const el = renderToolItem(groupItem);
        const anchor = el.nodeType === 11 ? el.firstChild : el; // fragment 先取锚点：append 后即被清空
        parent.appendChild(el);
        railEntries.push({ el: anchor, role: "tool", text: railToolText(groupItem) });
        continue;
      }
    }
    appendChatItem(item, railEntries, parent, key);
  }
  for (const st of pendingSteers) appendChatItem(st.item, railEntries, parent, st.key);
}

// 待消费气泡的左侧操作组：排队态（立即发送/编辑/删除）｜steer 态（编辑/放回队列顶端）
function buildPendingActions(item) {
  const s = activeOpen();
  const wrap = document.createElement("div");
  wrap.className = "qk-acts";
  const mk = (title, ic, fn) => {
    const b = document.createElement("button");
    b.className = "q-btn";
    b.title = title;
    b.innerHTML = icon(ic, 13);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (s) fn(s, item);
    });
    return b;
  };
  if (item.pending === "steer") {
    wrap.append(
      mk("编辑（放回输入框）", "pencil", editQueueMsg),
      mk("放回队列顶端", "down", requeueSteerMsg),
    );
  } else {
    wrap.append(
      mk("立即发送（当前步骤后注入）", "upload", sendNowQueueMsg),
      mk("编辑（放回输入框）", "pencil", editQueueMsg),
      mk("删除", "trash", dropQueueMsg),
    );
  }
  return wrap;
}

// 带 entryId 的历史用户消息 hover 出现的分叉按钮：从此条消息之前分叉出新会话。
// 分叉是文件级操作（几百 ms），点击后置 item.branching 防连点，session_branched 回包清除
function buildBranchBtn(item) {
  const s = activeOpen();
  const wrap = document.createElement("div");
  wrap.className = "qk-acts";
  const b = document.createElement("button");
  b.className = "q-btn";
  b.title = "从此处分叉新分支";
  b.innerHTML = icon("fork", 13);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (item.branching || !s) return;
    item.branching = true; // 全量重绘后仍保持禁用（标记随 item 数据存活）
    b.disabled = true;
    send({ type: "branch_session", sessionId: s.sessionId, entryId: item.entryId });
  });
  if (item.branching) b.disabled = true;
  wrap.appendChild(b);
  return wrap;
}

export function appendChatItem(item, railEntries, parent = streamEl, fk = "") {
  if (item.role === "user") {
    const div = document.createElement("div");
    div.className = "msg user";
    if (fk) div.dataset.fk = fk; // 会话内查找的消息级锚点（user/assistant/thinking 三类）
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = item.text;
    // 排队/steer 待消费消息：hover 气泡左侧出操作按钮组（消费后 pending 清除即普通历史消息）
    if (item.pending) {
      bubble.classList.add("pending");
      bubble.appendChild(buildPendingActions(item));
    } else if (item.entryId) {
      // 带 entryId 的历史消息：hover 出分叉按钮（host 未合并前 entryId 缺失，按钮不显示）
      bubble.classList.add("branchable");
      bubble.appendChild(buildBranchBtn(item));
    }
    div.appendChild(bubble);
    parent.appendChild(div);
    railEntries.push({ el: div, role: "user", text: item.text });
  } else if (item.role === "assistant") {
    if (isJunkPlaceholder(item.text)) return;
    const div = renderAssistantMessage(item.text);
    if (fk) div.dataset.fk = fk;
    parent.appendChild(div);
    railEntries.push({ el: div, role: "assistant", text: item.text });
  } else if (item.role === "thinking") {
    const frag = renderThink(item); // 任何设置下思考标签都显示，hideThinkingBlock 只决定默认展开与否
    const anchor = frag.firstChild; // 标题行为刻度定位锚（fragment append 后引用仍有效）
    if (fk) anchor.dataset.fk = fk;
    parent.appendChild(frag);
    railEntries.push({ el: anchor, role: "thinking", text: item.thinking || item.text });
  } else if (item.role === "tool") {
    const el = renderToolItem(item);
    const anchor = el.nodeType === 11 ? el.firstChild : el; // 先取锚点：append 后 fragment 即被清空（think 类工具返回 fragment）
    parent.appendChild(el);
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
      if (item.collapsed) {
        item.collapsed = false;
        S.animateLoopKids = true; // 本次 renderChat 的子行播放入场动画
        renderChat();
        S.animateLoopKids = false;
      } else {
        item.collapsed = true;
        arrow.classList.remove("open"); // 重绘延后到动画结束，箭头先回旋
        // 收起：容器高度收拢到 0（0.3s，与项目列表同一套），结束后重绘
        const kids = row.nextElementSibling;
        if (kids?.classList.contains("lp-kids")) {
          kids.classList.add("closing");
          setTimeout(() => renderChat(), 310);
        } else {
          renderChat();
        }
      }
    };
    parent.appendChild(row);
    railEntries.push({ el: row, role: "meta", text: loopSummaryText(item) });
    if (!item.collapsed) {
      // 子项包一层容器：grid 行高 0fr↔1fr 过渡做整组展开/收起动画（与项目列表一致）
      const kids = document.createElement("div");
      kids.className = "lp-kids";
      const kidsIn = document.createElement("div");
      kidsIn.className = "lp-kids-in";
      kids.appendChild(kidsIn);
      parent.appendChild(kids);
      renderItemList(item.items || [], railEntries, kidsIn);
      if (S.animateLoopKids) {
        // 同时入场（不加错峰：过程组子行数量无上限，错峰会导致后排长时间空白）
        for (const el of kidsIn.children) el.classList.add("kids-in");
        kids.style.gridTemplateRows = "0fr";
        requestAnimationFrame(() => requestAnimationFrame(() => { kids.style.gridTemplateRows = ""; }));
      }
    }
  } else if (item.role === "meta") {
    const div = document.createElement("div");
    div.className = "act";
    div.textContent = item.text;
    parent.appendChild(div);
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
    parent.appendChild(div);
    railEntries.push({ el: div, role: "approval", text: item.title });
  } else {
    const div = document.createElement("div");
    div.className = "act err";
    div.textContent = `✗ ${item.text}`;
    parent.appendChild(div);
    railEntries.push({ el: div, role: "err", text: item.text });
  }
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

export function renderChat() {
  const s = activeOpen();
  // 会话内查找只作用于打开时的会话：切换会话即收起（同会话的流式重绘不收）
  if (findBar && findPath !== S.activePath) closeFindBar();
  if (!s || S.isCreatingNew) {
    showWelcomeScreen(activeOpen()?.cwd);
    $("msgRail").hidden = true;
    dismissRailPop();
    return;
  }
  hideWelcomeScreen();
  let chatTitle = "选择左侧会话或新建任务";
  const entry = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === S.activePath);
  chatTitle = entry ? sessionLabel(entry) : s.cwd.split("/").filter(Boolean).pop() || s.cwd;
  $("chatTitle").textContent = chatTitle;

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
  renderItemList(s.items, railEntries);
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
  updateScrollBottomVis(); // scrollTop 恢复后刷新按钮显隐（scroll 事件异步，这里同步定准）
}

// ---------- 会话内查找（⌘F） ----------
// 第一版取舍：消息级定位——跳到命中消息并闪烁强调，不做文本内关键字高亮
// （markdown 渲染后的内联 mark 成本高收益低，后续可升级）。索引范围为当前会话
// items 中 user/assistant/thinking 的纯文本（含 loop 组子项，递归），工具行/审批卡跳过；
// 流式中的 assistantDraft 未定格成条目，不参与索引。
let findBar = null;
let findInp = null;
let findCountEl = null;
let findPath = null; // 打开时所在会话（切换会话由 renderChat 收起）
let findMatches = []; // 命中的消息：{ key, text }，key 与 data-fk 锚点一致
let findCursor = -1;

// 建文本索引：key 结构 = 顶层下标，或 "loop下标-子下标[-…]";（与 renderItemList 的 data-fk 同源）
function buildFindIndex(s) {
  const out = [];
  const walk = (items, pfx) => {
    items.forEach((it, i) => {
      const key = pfx + i;
      if (it.role === "user" || it.role === "assistant") {
        if (it.role === "assistant" && isJunkPlaceholder(it.text)) return;
        if (it.text) out.push({ key, text: it.text });
      } else if (it.role === "thinking") {
        if (it.thinking) out.push({ key, text: it.thinking });
      }
      if (it.role === "loop") walk(it.items || [], key + "-");
    });
  };
  walk(s.items, "");
  return out;
}

function updateFindCount() {
  if (!findCountEl) return;
  const q = findInp.value.trim();
  if (!q) {
    findCountEl.textContent = "";
    return;
  }
  if (!findMatches.length) {
    findCountEl.textContent = "无结果";
    findCountEl.classList.add("none");
    return;
  }
  findCountEl.classList.remove("none");
  findCountEl.textContent = `${findCursor + 1}/${findMatches.length}`;
}

// 命中元素短暂闪烁强调（背景高亮渐隐）；重触发需先移除类再强制 reflow
function flashFindTarget(el) {
  el.classList.remove("find-flash");
  void el.offsetWidth;
  el.classList.add("find-flash");
}

// 跳转：dir 1=下一个 -1=上一个，循环导航。命中的 loop 子项在组收起时先展开再定位
function gotoFindMatch(dir) {
  if (!findMatches.length) return;
  findCursor = (findCursor + dir + findMatches.length) % findMatches.length;
  updateFindCount();
  const m = findMatches[findCursor];
  const s = activeOpen();
  if (!s) return;
  const seg = m.key.split("-").map(Number);
  if (seg.length > 1) {
    // key 前缀段全是 loop 容器：逐层下钻，任一层收起都展开（外层收起时内层未渲染），
    // 有展开动作才重绘，之后按 data-fk 重新定位
    let expanded = false;
    let box = { items: s.items };
    for (let k = 0; k < seg.length - 1; k++) {
      box = box.items?.[seg[k]];
      if (!box) break;
      if (box.collapsed) {
        box.collapsed = false;
        expanded = true;
      }
    }
    if (expanded) renderChat();
  }
  const el = streamEl.querySelector(`[data-fk="${m.key}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  flashFindTarget(el);
}

function runFind() {
  const s = activeOpen();
  if (!s) return;
  const q = findInp.value.trim().toLowerCase();
  findMatches = q ? buildFindIndex(s).filter((m) => m.text.toLowerCase().includes(q)) : [];
  findCursor = -1;
  if (findMatches.length) gotoFindMatch(1);
  else updateFindCount();
}

function openFindBar() {
  const s = activeOpen();
  if (!s) return;
  if (!findBar) {
    findBar = document.createElement("div");
    findBar.className = "find-bar";
    findInp = document.createElement("input");
    findInp.className = "find-inp";
    findInp.placeholder = "在会话中查找…";
    findInp.type = "text";
    findInp.autocomplete = "off";
    findInp.spellcheck = false;
    findInp.addEventListener("input", runFind);
    findInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        gotoFindMatch(e.shiftKey ? -1 : 1);
      }
    });
    findCountEl = document.createElement("span");
    findCountEl.className = "find-count";
    const mkNav = (title, ic, dir) => {
      const b = document.createElement("button");
      b.className = "find-nav";
      b.title = title;
      b.innerHTML = icon(ic);
      b.addEventListener("click", () => gotoFindMatch(dir));
      return b;
    };
    const closeBtn = document.createElement("button");
    closeBtn.className = "find-nav find-close";
    closeBtn.title = "关闭 (Esc)";
    closeBtn.innerHTML = icon("xmark", 12);
    closeBtn.addEventListener("click", closeFindBar);
    findBar.append(findInp, findCountEl, mkNav("上一个 (⇧↵)", "chevronUp", -1), mkNav("下一个 (↵)", "chevronDown", 1), closeBtn);
    $("main").appendChild(findBar);
  }
  // 浮层贴消息流顶部（absolute 相对 #main）；水平居中交 CSS
  findBar.style.top = streamEl.offsetTop + 6 + "px";
  findPath = S.activePath;
  findInp.focus();
  findInp.select(); // 已有词时全选，直接输入即覆盖
  if (findInp.value.trim()) runFind();
}

function closeFindBar() {
  findBar?.remove();
  findBar = null;
  findInp = null;
  findCountEl = null;
  findPath = null;
  findMatches = [];
  findCursor = -1;
}

export function initChat() {
  // 「工作中 N 秒」每秒跳（重绘后 span 重建，按 id 重新查询）
  setInterval(() => {
    const s = activeOpen();
    const el = $("workSec");
    if (s?.turnStartAt && el) el.textContent = Math.floor((Date.now() - s.turnStartAt) / 1000);
  }, 1000);

  // ⌘F 打开会话内查找（preventDefault 阻止 WKWebView 默认行为）；Esc 关闭。
  // 仅当前激活会话可用；设置页为全屏覆盖层，打开时不响应
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      if (!activeOpen() || S.isCreatingNew || !$("settings").classList.contains("hidden")) return;
      e.preventDefault();
      openFindBar();
    } else if (e.key === "Escape" && findBar) {
      closeFindBar();
    }
  });
}
