// Markdown 渲染引擎与代码复制：主对话区 assistant 消息的 md → HTML 渲染。
// 注意：设置页记忆详情另有一套简化实现（settings/memory.js 的 renderMarkdown），两套保持独立。
import { $, streamEl, isJunkPlaceholder } from "./core.js";

export function escapeHtml(str) {
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

export function renderMarkdownToHtml(md) {
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

export function renderAssistantMessage(text) {
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

// 仅当消息流还有向下滚动余量时显示按钮（4px 容差防亚像素抖动）
export function updateScrollBottomVis() {
  const btn = $("scrollBottom");
  if (!btn) return;
  const canScrollDown = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight > 4;
  btn.classList.toggle("hidden", !canScrollDown);
}

export function ensureScrollBottom() {
  let btn = $("scrollBottom");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "scrollBottom";
    btn.className = "scroll-bottom hidden"; // 初始隐藏，由 updateScrollBottomVis 决定显隐
    btn.type = "button";
    btn.title = "滚动到底部";
    btn.innerHTML = icon("down");
    btn.addEventListener("click", () => {
      streamEl.scrollTop = streamEl.scrollHeight;
    });
  }
  if (btn !== streamEl.lastElementChild) streamEl.appendChild(btn);
}

export function initMarkdown() {
  streamEl.addEventListener("scroll", updateScrollBottomVis); // 滚动位置变化实时显隐
  new MutationObserver(() => {
    const btn = $("scrollBottom");
    if (btn && streamEl.contains(btn) && btn !== streamEl.lastElementChild) streamEl.appendChild(btn);
    updateScrollBottomVis(); // 子节点增删会改变 scrollHeight，顺带刷新显隐
  }).observe(streamEl, { childList: true });
}
