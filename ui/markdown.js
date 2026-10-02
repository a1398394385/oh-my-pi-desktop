// Markdown rendering engine and code copy: md -> HTML rendering for assistant
// messages in the main chat area.
// Note: the settings-page memory details use a separate simplified implementation
// (renderMarkdown in settings/memory.js); the two stay independent.
// React migration cut: three symbols from the old core.js are localized here — the
// import chain would drag the whole imperative UI tree (old S and the per-domain render
// modules) into the React bundle. $/isJunkPlaceholder match the old core; streamEl is
// lazy (the React #stream is component-rendered and absent at module load; the three
// scroll functions below are only called by the old version — the React Chat has its
// own scrolling semantics).
const $ = (id) => document.getElementById(id);
const getStream = () => document.getElementById("stream");
function isJunkPlaceholder(text) {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

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

  // 1. Extract and protect all code blocks (including unclosed ones mid-stream)
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

    // Code block placeholder
    const cbMatch = trimmed.match(/^\x02MDCODEBLOCK(\d+)\x02$/);
    if (cbMatch) {
      out.push(codeBlocks[Number(cbMatch[1])]);
      i++;
      continue;
    }

    // Headings (# ~ ####)
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${renderInline(escapeHtml(hMatch[2]))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      out.push(`<hr class="md-hr">`);
      i++;
      continue;
    }

    // Blockquote (> ...)
    if (trimmed.startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${quoteLines.map((l) => renderInline(escapeHtml(l))).join("<br>")}</blockquote>`);
      continue;
    }

    // Table (| a | b |)
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

    // Unordered and task lists (- item, * item)
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

    // Ordered list (1. item)
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

    // Plain paragraph
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

// Show the button only while the message stream still has scroll room left (4px tolerance guards against sub-pixel jitter)
export function updateScrollBottomVis() {
  const btn = $("scrollBottom");
  if (!btn) return;
  const el = getStream();
  const canScrollDown = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
  btn.classList.toggle("hidden", !canScrollDown);
}

export function ensureScrollBottom() {
  let btn = $("scrollBottom");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "scrollBottom";
    btn.className = "scroll-bottom hidden"; // hidden initially; updateScrollBottomVis decides visibility
    btn.type = "button";
    btn.title = "滚动到底部";
    btn.innerHTML = icon("down");
    btn.addEventListener("click", () => {
      const el = getStream();
      el.scrollTop = el.scrollHeight;
    });
  }
  const el = getStream();
  if (btn !== el.lastElementChild) el.appendChild(btn);
}

export function initMarkdown() {
  const el = getStream();
  el.addEventListener("scroll", updateScrollBottomVis); // live visibility on scroll position change
  new MutationObserver(() => {
    const btn = $("scrollBottom");
    if (btn && el.contains(btn) && btn !== el.lastElementChild) el.appendChild(btn);
    updateScrollBottomVis(); // child additions/removals change scrollHeight; refresh visibility along the way
  }).observe(el, { childList: true });
}
