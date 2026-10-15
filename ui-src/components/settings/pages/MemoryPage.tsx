// Memory settings page: workspace memory master switch + memory file list; clicking a memory
// row expands the detail area downward
// (left file tree + right markdown rendering; semantics ported 1:1 from ui/settings/memory.js).
// The markdown rendering is a simplified memory-page-specific implementation (escape everything
// first, then lay out — injection-safe), independent of the main chat area's markdown engine.
import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import { t as ti } from "../../../i18n";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

// Memory entry (list item of memories in the agent_assets reply; sent by host, fields per the reply)
interface MemoryItem {
  path: string;
  name?: string;
  project?: string; // workspace name (displayed in preference to name)
}

// ---------- Memory-page-specific markdown rendering (escape everything first, then lay out; outputs safe HTML) ----------
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

// Hide the threadId prefix of rollout file names, keep only the slug part
function rolloutLabel(n: string): string {
  return n.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-?/i, "") || n;
}

// ---------- Expanded area: head + left file tree + right content ----------
function MemoryExpand({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const d = useAppStore((s) => s.memoryDetail);
  const [rolloutOpen, setRolloutOpen] = useState(true); // rollout group expanded state (the component remounts on row switch, naturally resets to expanded)
  // One-shot flag for child entrance animation (aligned with the old animateMdKids: this render carries kids-in, then resets)
  const [kidsIn, setKidsIn] = useState(false);
  useEffect(() => {
    if (!kidsIn) return;
    const t = requestAnimationFrame(() => setKidsIn(false));
    return () => cancelAnimationFrame(t);
  }, [kidsIn]);
  const mainRef = useRef<HTMLDivElement>(null);
  // Scroll the content area back to top after each file switch (aligned with the old scrollTop = 0)
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [d.active?.name, d.active?.rollout, d.status]);

  // Click a left-tree file: switch selection and read (active lands in the store via the memory_file reply; the click sends the request)
  const pickFile = (name: string, rollout: boolean) => {
    if (d.active && d.active.name === name && d.active.rollout === rollout) return;
    useAppStore.setState((st) => ({
      memoryDetail: { ...st.memoryDetail, active: { name, rollout }, status: "loading", error: null },
    }));
    send({ type: "memory_file_read", path: `${d.base}/${rollout ? "rollout_summaries/" : ""}${name}` });
  };
  const toggleRollout = () => {
    const open = !rolloutOpen;
    setRolloutOpen(open);
    if (open) setKidsIn(true); // children enter when the group expands
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

  // Body: loading / failed / markdown rendering (empty-file placeholder aligned with the old version)
  let body: ReactNode;
  if (d.status === "loading") body = t("settingsPage.shared.reading");
  else if (d.status === "error") body = t("settingsPage.memory.readFail", { error: d.error ?? "" });
  else
    body = (
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(d.content) || `<p style="color:var(--faint)">${ti("settingsPage.memory.emptyFile")}</p>` }} />
    );

  return (
    <div className="mem-expand">
      <div className="mem-exp-head">
        <span>{t("settingsPage.memory.detailTitle")}</span>
        <span className="sp"></span>
        <button type="button" className="save-btn" onClick={onClose}>
          {t("settingsPage.shared.collapse")}
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

// ---------- Page ----------
export default function MemoryPage() {
  const { t } = useTranslation();
  const memories = useAppStore((s) => s.agentAssets?.memories ?? null);
  // The file-backed memory list (agentDir/memories) is local-pipeline-only
  // property: hindsight keeps memories server-side and mnemopi in SQLite
  // banks, and the base explicitly blocks non-local callers from stale files
  // (memory-protocol.ts fileBackedRootUnavailableError)
  const backendLocal = useAppStore((s) => s.hostSettings?.values?.["memory.backend"]) === "local";
  const [openPath, setOpenPath] = useState<string | null>(null); // memory row currently expanded downward (entry path)

  // Click a project row: expand the detail area under that row; click again to collapse, click another row to switch
  const openRow = (m: MemoryItem) => {
    if (openPath === m.path) {
      setOpenPath(null);
      return;
    }
    setOpenPath(m.path);
    // Reset detail state: clear the file list, enter loading (the rollout group's expanded state is local to MemoryExpand, reset on remount)
    useAppStore.setState((st) => ({
      memoryDetail: { base: null, files: null, rollouts: [], active: null, status: "loading", content: "", error: null },
    }));
    send({ type: "memory_file_read", path: m.path });
  };
  const closeRow = () => setOpenPath(null);

  // After the list rebuilds (agent_assets reply), collapse an expanded row that no longer exists (aligned with the old renderAssetPages' closeMemoryRow)
  useEffect(() => {
    if (openPath && memories && !memories.some((m) => m.path === openPath)) setOpenPath(null);
  }, [memories, openPath]);

  return (
    <div className="set-page" id="pg-memory">
      <div className="set-tt">{t("settingsPage.nav.memory")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-memory"].slice(0, 2)} />
      {backendLocal && (
        <>
          <div className="set-group-tt">{t("settingsPage.memory.filesGroup")}</div>
          <div className="set-card" id="memoryList">
            {!memories ? (
              <div className="srow">
                <div className="srow-tx">
                  <span>{t("common.loading")}</span>
                </div>
              </div>
            ) : memories.length === 0 ? (
              <div className="srow">
                <div className="srow-tx">
                  <span>{t("settingsPage.shared.emptyNone")}</span>
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
        </>
      )}
      <SchemaRows sections={PAGE_PLACEMENT["pg-memory"].slice(2)} />
    </div>
  );
}
