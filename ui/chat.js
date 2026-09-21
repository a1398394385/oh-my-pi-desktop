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
function renderItemList(items, railEntries, parent = streamEl) {
  const pendingSteers = []; // steer 待消费气泡收集到末尾统一渲染：消费前位置一直低于处理进程区
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.role === "user" && item.pending === "steer") {
      pendingSteers.push(item);
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
    appendChatItem(item, railEntries, parent);
  }
  for (const it of pendingSteers) appendChatItem(it, railEntries, parent);
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

export function appendChatItem(item, railEntries, parent = streamEl) {
  if (item.role === "user") {
    const div = document.createElement("div");
    div.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = item.text;
    // 排队/steer 待消费消息：hover 气泡左侧出操作按钮组（消费后 pending 清除即普通历史消息）
    if (item.pending) {
      bubble.classList.add("pending");
      bubble.appendChild(buildPendingActions(item));
    }
    div.appendChild(bubble);
    parent.appendChild(div);
    railEntries.push({ el: div, role: "user", text: item.text });
  } else if (item.role === "assistant") {
    if (isJunkPlaceholder(item.text)) return;
    const div = renderAssistantMessage(item.text);
    parent.appendChild(div);
    railEntries.push({ el: div, role: "assistant", text: item.text });
  } else if (item.role === "thinking") {
    const frag = renderThink(item); // 任何设置下思考标签都显示，hideThinkingBlock 只决定默认展开与否
    const anchor = frag.firstChild; // 标题行为刻度定位锚（fragment append 后引用仍有效）
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

export function initChat() {
  // 「工作中 N 秒」每秒跳（重绘后 span 重建，按 id 重新查询）
  setInterval(() => {
    const s = activeOpen();
    const el = $("workSec");
    if (s?.turnStartAt && el) el.textContent = Math.floor((Date.now() - s.turnStartAt) / 1000);
  }, 1000);
}
