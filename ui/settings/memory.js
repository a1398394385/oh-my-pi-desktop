// 记忆设置页：项目记忆行向下延展的详情区（左栏文件树 + 右侧内容渲染）。
// Markdown 渲染是记忆页专用的简化实现（整体先转义再排版，防注入），与主对话区 markdown.js 引擎相互独立。
import { $, send, memInbox } from "../core.js";

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

// 记忆详情当前状态：rollout 组展开态、当前向下延展的记忆行及其详情区域内的左栏 / 内容元素
// （条目路径、顶层 .md 清单、rollout 清单、当前选中文件在 core.memInbox，onMessage 回包写入）
let memRolloutOpen = true;
let animateMdKids = false; // 下一次 renderMdSide 为 rollout 组展开动作的子项播放入场动画（同步渲染后立即复位）
let memOpenRow = null;

export function closeMemoryRow() {
  if (!memOpenRow) return;
  memOpenRow.classList.remove("on");
  memOpenRow.nextElementSibling?.remove(); // .mem-expand
  memOpenRow = null;
  memInbox.sideEl = null;
  memInbox.contentEl = null;
  memInbox.base = null;
  memInbox.files = null;
  memInbox.rollouts = null;
  memInbox.active = null;
}
// 点击项目行：该行向下延展出详情区；再次点击收起，点其他行则切换
export function toggleMemoryRow(row, m) {
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
  memInbox.sideEl = exp.querySelector(".md-side");
  memInbox.contentEl = exp.querySelector(".md-main");
  memRolloutOpen = true;
  memInbox.contentEl.textContent = "读取中…";
  send({ type: "memory_file_read", path: m.path });
}
// rollout 文件名隐藏 threadId 前缀，只留 slug 部分
function rolloutLabel(n) {
  return n.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-?/i, "") || n;
}
// 左栏文件树：顶层 .md + rollout_summaries 二级组（默认展开）
function renderMdSide() {
  const side = memInbox.sideEl;
  if (!side) return;
  side.replaceChildren();
  if (!memInbox.files) return;
  const addIt = (name, rollout) => {
    const it = document.createElement("div");
    const on = memInbox.active && memInbox.active.name === name && memInbox.active.rollout === rollout;
    it.className = "md-it" + (rollout ? " sub" : " top") + (on ? " on" : "");
    if (rollout && animateMdKids) it.classList.add("kids-in"); // 组展开时子项入场
    it.textContent = rollout ? rolloutLabel(name) : name;
    it.title = name;
    it.onclick = () => {
      if (memInbox.active && memInbox.active.name === name && memInbox.active.rollout === rollout) return;
      memInbox.active = { name, rollout };
      renderMdSide();
      if (memInbox.contentEl) {
        memInbox.contentEl.textContent = "读取中…";
        memInbox.contentEl.scrollTop = 0;
      }
      send({ type: "memory_file_read", path: `${memInbox.base}/${rollout ? "rollout_summaries/" : ""}${name}` });
    };
    side.appendChild(it);
  };
  for (const f of memInbox.files) addIt(f, false);
  if (memInbox.rollouts && memInbox.rollouts.length) {
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
    cnt.textContent = String(memInbox.rollouts.length);
    grp.append(caret, lb, cnt);
    grp.onclick = () => {
      memRolloutOpen = !memRolloutOpen;
      if (memRolloutOpen) animateMdKids = true; // 本次 renderMdSide 的子项播放入场动画
      renderMdSide();
      animateMdKids = false;
    };
    side.appendChild(grp);
    if (memRolloutOpen) for (const f of memInbox.rollouts) addIt(f, true);
  }
}
export function renderMemoryDetail(msg) {
  renderMdSide();
  if (memInbox.contentEl) {
    memInbox.contentEl.innerHTML = renderMarkdown(msg.content) || '<p style="color:var(--faint)">（空文件）</p>';
    memInbox.contentEl.scrollTop = 0;
  }
}
