// 记忆设置页：工作区记忆总开关 + 记忆文件列表，点击记忆行向下延展出详情区
// （左栏文件树 + 右侧 markdown 渲染，语义 1:1 平移 ui/settings/memory.js）。
// Markdown 渲染是记忆页专用的简化实现（整体先转义再排版，防注入），与主对话区 markdown 引擎相互独立。
import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { S, useStore, send, notify } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

// 记忆条目（agent_assets 回包 memories 列表项；host 下发，字段以回包为准）
interface MemoryItem {
  path: string;
  name?: string;
  project?: string; // 工作区名（优先于 name 展示）
}

// ---------- 记忆页专用 markdown 渲染（先整体转义再排版，输出安全 HTML） ----------
function mdEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}
function renderMarkdown(src: unknown): string {
  const lines = mdEscape(String(src ?? "")).split("\n");
  const out: string[] = [];
  let para: string[] = [],
    list: { t: "ul" | "ol"; items: string[] } | null = null,
    code: string[] | null = null,
    quote: string[] = [],
    table: { head: string[]; rows: string[][] } | null = null;
  let m: RegExpMatchArray | null;
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

// rollout 文件名隐藏 threadId 前缀，只留 slug 部分
function rolloutLabel(n: string): string {
  return n.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-?/i, "") || n;
}

// ---------- 延展区：头部 + 左栏文件树 + 右侧内容 ----------
function MemoryExpand({ onClose }: { onClose: () => void }) {
  const d = S.memoryDetail;
  const [rolloutOpen, setRolloutOpen] = useState(true); // rollout 组展开态（组件随切行重挂载，天然复位为展开）
  // 子项入场动画标记用后即焚（对齐旧版 animateMdKids：本次渲染带 kids-in，随后复位）
  const [kidsIn, setKidsIn] = useState(false);
  useEffect(() => {
    if (!kidsIn) return;
    const t = requestAnimationFrame(() => setKidsIn(false));
    return () => cancelAnimationFrame(t);
  }, [kidsIn]);
  const mainRef = useRef<HTMLDivElement>(null);
  // 每次切换文件后内容区滚回顶部（对齐旧版 scrollTop = 0）
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [d.active?.name, d.active?.rollout, d.status]);

  // 点击左栏文件：切选中并读取（active 由 memory_file 回包落 S，点击即发出请求）
  const pickFile = (name: string, rollout: boolean) => {
    if (d.active && d.active.name === name && d.active.rollout === rollout) return;
    d.active = { name, rollout };
    d.status = "loading";
    d.error = null;
    notify();
    send({ type: "memory_file_read", path: `${d.base}/${rollout ? "rollout_summaries/" : ""}${name}` });
  };
  const toggleRollout = () => {
    const open = !rolloutOpen;
    setRolloutOpen(open);
    if (open) setKidsIn(true); // 组展开时子项入场
  };

  const mdIt = (name: string, rollout: boolean) => {
    const on = d.active && d.active.name === name && d.active.rollout === rollout;
    return (
      <div
        key={(rollout ? "r/" : "t/") + name}
        className={"md-it" + (rollout ? " sub" : " top") + (on ? " on" : "") + (rollout && kidsIn ? " kids-in" : "")}
        title={name}
        onClick={() => pickFile(name, rollout)}
      >
        {rollout ? rolloutLabel(name) : name}
      </div>
    );
  };

  // 正文：读取中 / 失败 / markdown 渲染（空文件占位对齐旧版）
  let body: ReactNode;
  if (d.status === "loading") body = "读取中…";
  else if (d.status === "error") body = `读取失败：${d.error ?? ""}`;
  else
    body = (
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(d.content) || '<p style="color:var(--faint)">（空文件）</p>' }} />
    );

  return (
    <div className="mem-expand">
      <div className="mem-exp-head">
        <span>记忆详情</span>
        <span className="sp"></span>
        <button type="button" className="save-btn" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="mem-body">
        <div className="md-side">
          {d.files?.map((f) => mdIt(f, false))}
          {d.rollouts && d.rollouts.length > 0 && (
            <div className={"md-grp" + (rolloutOpen ? "" : " closed")} onClick={toggleRollout}>
              <span className="caret">
                <Icon name="caret" size={14} />
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>rollout_summaries</span>
              <span className="cnt">{String(d.rollouts.length)}</span>
            </div>
          )}
          {rolloutOpen && d.rollouts?.map((f) => mdIt(f, true))}
        </div>
        <div className="md-main" ref={mainRef}>
          {body}
        </div>
      </div>
    </div>
  );
}

// ---------- 页面 ----------
export default function MemoryPage() {
  useStore();
  const memories: MemoryItem[] | null = S.agentAssets?.memories ?? null;
  const [openPath, setOpenPath] = useState<string | null>(null); // 当前向下延展的记忆行（条目 path）

  // 点击项目行：该行向下延展出详情区；再次点击收起，点其他行则切换
  const openRow = (m: MemoryItem) => {
    if (openPath === m.path) {
      setOpenPath(null);
      return;
    }
    setOpenPath(m.path);
    // 重置详情态：清空清单，进入读取中（rollout 组展开态在 MemoryExpand 本地，随重挂载复位）
    Object.assign(S.memoryDetail, {
      base: null,
      files: null,
      rollouts: [],
      active: null,
      status: "loading",
      content: "",
      error: null,
    });
    notify();
    send({ type: "memory_file_read", path: m.path });
  };
  const closeRow = () => setOpenPath(null);

  // 列表重建（agent_assets 回包）后，已展开的行若不复存在则收起（对齐旧版 renderAssetPages 的 closeMemoryRow）
  useEffect(() => {
    if (openPath && memories && !memories.some((m) => m.path === openPath)) setOpenPath(null);
  }, [memories, openPath]);

  return (
    <div className="set-page" id="pg-memory">
      <div className="set-tt">记忆</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-memory"].slice(0, 1)} />
      <div className="set-group-tt">记忆文件</div>
      <div className="set-card" id="memoryList">
        {!memories ? (
          <div className="srow">
            <div className="srow-tx">
              <span>加载中…</span>
            </div>
          </div>
        ) : memories.length === 0 ? (
          <div className="srow">
            <div className="srow-tx">
              <span>暂无</span>
            </div>
          </div>
        ) : (
          memories.map((m) => (
            <Fragment key={m.path}>
              <div className={"srow mem-row" + (openPath === m.path ? " on" : "")} onClick={() => openRow(m)}>
                <div className="srow-tx">
                  <b>{m.project ?? m.name}</b>
                  {m.path && <span>{m.path}</span>}
                </div>
                <span className="mem-caret">
                  <Icon name="caretSlim" size={14} />
                </span>
              </div>
              {openPath === m.path && <MemoryExpand onClose={closeRow} />}
            </Fragment>
          ))
        )}
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-memory"].slice(1)} />
    </div>
  );
}
