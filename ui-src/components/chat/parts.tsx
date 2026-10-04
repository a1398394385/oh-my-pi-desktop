// Shared message-stream renderers: ellipsis truncation / file chips / inline code / external
// link text / fade mask / expand-body timing / inline diff expand body / right-panel actions.
// Migrated from the shared utilities in ui/tool-rows.js (imperative DOM construction
// translated to components); pure functions (splitPath/uniqueFiles) are re-imported from the
// old module instead of being rewritten.
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ChatItem, ToolItem } from "../../types/session";
import { useAppStore, setBump } from "../../store/index";
import { patchSessionItem } from "../../store/session";
import { invoke } from "../../store/ws";
import { migrateGroupExpand } from "../../store/groupExpand";
import { uniqueFiles, splitPath, stripReadSelector, readSelectorRange } from "./util";
import { MOD, modDown } from "../../platform";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";
import { langOfPath } from "../../lib/highlighter";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens";
import { openRightTab } from "../RightPanel";
import LightweightDiff from "../diff/LightweightDiff";
import { t } from "../../i18n";

export { uniqueFiles, splitPath };

/** setTimeout handle (DOM and Node environments return different types; unified alias) */
type TimerHandle = ReturnType<typeof setTimeout>;

// ---------- Item-level write channel (zustand migration: copy-replace + _v bump, replacing the old "mutate + notify") ----------

/** Locates an item by reference in the current session (piercing loop groups) and
 *  copy-replaces it: for item-level toggles such as expand/collapse state. The `it` passed
 *  to the patch callback is a copied entry of the same shape; read the current value and invert it. */
export function patchActiveItem<T extends object>(item: T, patch: (it: T) => void): void {
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  if (!s) return;
  // The props item is the current store entry reference (reference matching is naturally unique); route the copy through unknown to hand it back to the same-shape callback
  patchSessionItem(s.sessionId, (it) => it === item, (it) => {
    patch(it as unknown as T);
    migrateGroupExpand(item as unknown as ToolItem, it as unknown as ToolItem);
  });
}

/** Copy-replace for a sub-item inside a tool merged group (item.group):
 *  A merged group is a view grouping built dynamically by renderItems; the underlying real entries are stored flat as independent elements in s.items or loop.items.
 *  When locating, match the flat it === sub first, and also cover the case where it hangs directly under it.group.
 *  If the updated sub-item is the group head, migrate its group expand state in the groupExpand WeakMap accordingly. */
export function patchGroupSub(sub: ToolItem, patch: (it: ToolItem) => void): void {
  useAppStore.setState((st) => {
    const path = st.activePath;
    const s = path ? st.openSessions.get(path) : undefined;
    if (!path || !s) return {};
    const walk = (list: ChatItem[]): ChatItem[] | null => {
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (it === sub) {
          const next = list.slice();
          const copy = { ...sub };
          patch(copy);
          migrateGroupExpand(sub, copy);
          next[i] = copy;
          return next;
        }
        if (it.role === "tool" && Array.isArray(it.group) && it.group.includes(sub)) {
          const next = list.slice();
          const group = (it.group as ToolItem[]).slice();
          const copy = { ...sub };
          patch(copy);
          migrateGroupExpand(sub, copy);
          group[group.indexOf(sub)] = copy;
          next[i] = { ...it, group };
          return next;
        }
        if (it.role === "loop" && it.items) {
          const inner = walk(it.items);
          if (inner) {
            const next = list.slice();
            next[i] = { ...it, items: inner };
            return next;
          }
        }
      }
      return null;
    };
    const items = walk(s.items);
    if (!items) return {};
    return { openSessions: new Map(st.openSessions).set(path, { ...s, items }) };
  });
}

// ---------- Unified placeholder while a tool result is pending (spinner + ellipsis) ----------
// The criterion is fixed to item.running (tool frame arrived, tool_update not yet): every
// tool's output slot renders this before the result arrives. Rows must not infer running
// state from missing content — missing content may mean "not yet arrived" or "never present"
// (directory reads, empty results); only running distinguishes them (same-root lesson as BUG-016)
export function Spin() {
  return (
    <span className="flex-none inline-flex items-center gap-[6px] text-dim text-ui-base" role="status">
      <Icon name="loader" size={15} className="pend-ico" />
      …
    </span>
  );
}

// ---------- Ellipsis truncation (e-wrap: text segment e-tx + ellipsis segment e-dot) ----------
// 3px gap between "..." and the preceding text: native text-overflow:ellipsis cannot do this.
// The ellipsis segment only shows when the text segment is clipped; a shared ResizeObserver
// recomputes on container resize / UI zoom (componentized from the former ellipsizable)
const eObs = new ResizeObserver((list) => {
  for (const e of list) syncDot(e.target as HTMLElement); // observed targets are all spans of this component; target is declared as Element, just narrow it
});
function syncDot(tx: HTMLElement) {
  const dot = tx.nextElementSibling;
  if (!dot || !dot.classList.contains("e-dot")) return;
  (dot as HTMLElement).style.display = tx.scrollWidth > tx.clientWidth + 1 ? "" : "none";
}
export function Ellip({ className = "", title, children }: { className?: string; title?: string; children?: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const tx = ref.current;
    if (!tx) return;
    eObs.observe(tx);
    requestAnimationFrame(() => syncDot(tx));
    return () => eObs.unobserve(tx);
  });
  return (
    <span className={(className + " e-wrap").trim()} title={title}>
      <span className="e-tx" ref={ref}>{children}</span>
      <span className="e-dot" style={{ display: "none" }}>…</span>
    </span>
  );
}

// ---------- File chip (f-ic: file type icon + file name; the name is clickable when onNameClick is set) ----------
// fileTypeIcon (picks a vscode-icons color icon by extension/file name) lives in ui/icons.js
export function FileChip({ path, nameClass, onNameClick }: { path: string; nameClass?: string; onNameClick?: (e: ReactMouseEvent) => void }) {
  const cleanPath = stripReadSelector(path);
  const { name } = splitPath(cleanPath);
  return (
    <span className="f-ic" title={cleanPath}>
      <Icon name={fileTypeIcon(name || cleanPath)} />
      <span
        className={(nameClass || "") + (onNameClick ? " lnk" : "")}
        onClick={onNameClick ? (e) => { e.stopPropagation(); onNameClick(e); } : undefined}
      >
        {name || cleanPath}
      </span>
    </span>
  );
}

// ---------- Inline code (renders `code` segments in text as <code>, formerly fillInlineCode) ----------
export function InlineCode({ text }: { text?: string }) {
  return String(text || "")
    .split(/(`[^`]+`)/)
    .map((p, i) =>
      p.length > 2 && p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p || null,
    );
}

// ---------- External link text (URL segments in result output become links; only ⌘+click opens externally in the system browser) ----------
const LINK_RE = /https?:\/\/[^\s<>"'，、。；：！？]+/u;
const TRAIL_PUNCT_RE = /[.,;:!?，、。；：！？)\]}〉》」』】'"”’]+$/u;
async function openExternal(url: string) {
  try {
    if (invoke) await invoke("plugin:opener|open_url", { url });
    else window.open(url, "_blank", "noopener");
  } catch (err) {
    useAppStore.getState().toast(t("chat.openLinkFailed", { error: String(err) }));
  }
}
export function LinkedText({ text }: { text?: string }) {
  const out: ReactNode[] = [];
  let rest = String(text || "");
  let k = 0;
  for (;;) {
    const m = rest.match(LINK_RE);
    if (!m) break;
    if (m.index) out.push(rest.slice(0, m.index)); // index always exists (match is non-global); no prefix segment when it is 0
    const url = m[0].replace(TRAIL_PUNCT_RE, ""); // trailing dangling punctuation stays in the text
    out.push(
      <a
        key={k++}
        className="cursor-pointer text-blue no-underline hover:underline"
        title={t("chat.openInBrowser", { mod: MOD })}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation(); // do not bubble to the row-level expand/collapse click
          if (modDown(e)) openExternal(url);
        }}
      >
        {url}
      </a>,
    );
    rest = rest.slice((m.index ?? 0) + m[0].length);
  }
  if (rest) out.push(rest);
  return out;
}

// ---------- Fade mask (adds .no-fade to lift the bottom blur when scrolled to bottom or content is shorter than one screen, formerly attachFadeMask) ----------
export function FadeBox({ className, as = "div", children, html }: { className?: string; as?: "div" | "pre"; children?: ReactNode; html?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => el.classList.toggle("no-fade", el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    el.addEventListener("scroll", sync, { passive: true });
    requestAnimationFrame(sync);
    return () => el.removeEventListener("scroll", sync);
  });
  // Dynamic tag narrowing: `as` actually only takes "div" (default) / "pre" (CmdCard output body);
  // branch rendering + callback ref keeps the ref type of both concrete tags (equivalent to the former <Tag ref>)
  const refCb = (el: HTMLElement | null) => { ref.current = el; };
  if (as === "pre") {
    return html !== undefined
      ? <pre className={className} ref={refCb} dangerouslySetInnerHTML={{ __html: html }} />
      : <pre className={className} ref={refCb}>{children}</pre>;
  }
  return html !== undefined
    ? <div className={className} ref={refCb} dangerouslySetInnerHTML={{ __html: html }} />
    : <div className={className} ref={refCb}>{children}</div>;
}

// ---------- Expand-body timing (componentized equivalent of the former liftEl) ----------
// The expand body plays its .drop/.kids-in entrance animation on mount — React reuses nodes,
// so streaming redraws do not replay it (equivalent to the former "play only on the click
// that expands"; switching sessions remounts and replays once, an accepted difference);
// collapsing first plays the .lift/.closing collapse animation, and the data is committed and
// the node unmounted only after 210ms (310ms for loop groups).
export function useLift(): [boolean, (commit: () => void, delay?: number) => void] {
  const [closing, setClosing] = useState(false);
  const timer = useRef<TimerHandle | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = (commit: () => void, delay = 210) => {
    setClosing(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setClosing(false);
      commit();
    }, delay);
  };
  return [closing, close];
}

// ---------- Trailing +n/−n line-count changes (shared by edit rows / rows inside change groups, formerly appendCounts) ----------
export function Counts({ item }: { item: ToolItem }) {
  return (
    <>
      {(item.added ?? 0) > 0 && <> <span className="add">{`+${item.added}`}</span></>}
      {(item.removed ?? 0) > 0 && <> <span className="del">{`−${item.removed}`}</span></>}
    </>
  );
}

// ---------- This call's own diff (shared by the edit row's expansion request gate and EditBrief) ----------
// Prefer the file-specific diff from details.perFileResults (multi-file apply_patch), else the
// reply's diffContent. Both land with tool_update, so this is read live rather than snapshotted
// at expansion time: a row expanded while the tool was still running (which fell back to the
// git-diff cache) switches to the real per-call diff the moment it arrives.
export function ownDiffOf(item: ToolItem, path: string): string | undefined {
  const perFiles = (item.details as { perFileResults?: { path?: string; diff?: unknown }[] } | undefined)?.perFileResults;
  if (Array.isArray(perFiles) && path) {
    const match = perFiles.find((f) =>
      typeof f?.path === "string" && (f.path === path || f.path.endsWith("/" + path) || path.endsWith("/" + f.path)),
    );
    if (match && typeof match.diff === "string") return match.diff;
  }
  return item.diffContent;
}

// ---------- Brief diff body for the edit row's inline expansion (formerly buildEditBrief) ----------
// Diff source: ownDiffOf (the real modification from this tool response, takes priority) →
// briefDiffCache[path] (git diff; the right-panel detail and inline expansion share one
// response). The per-call diff lives on the item, so multiple edits to the same file each
// see their own on expansion, without overwriting each other.
export function EditBrief({ item, path, lift }: { item: ToolItem; path: string; lift?: boolean }) {
  const briefDiffCache = useAppStore((s) => s.briefDiffCache); // Map reference subscription: response/placeholder writes trigger redraw
  const diff = ownDiffOf(item, path) ?? briefDiffCache.get(path);
  const cls = "ed-brief" + (lift ? " lift" : " drop");
  if (diff === undefined) {
    // Two kinds of "not yet arrived": the tool itself is still running (this response not
    // arrived → Spin), or the response arrived but the git diff request is in flight (tool
    // already finished → keep the original text). Same criterion: item.running
    return (
      <FadeBox className={cls}>
        <div className="text-faint text-ui-base py-[12px] px-[10px]">{item.running ? <Spin /> : t("common.loading")}</div>
      </FadeBox>
    );
  }
  if (!diff) return <FadeBox className={cls}><div className="text-faint text-ui-base py-[12px] px-[10px]">{t("chat.noDiffContent")}</div></FadeBox>;
  return (
    <FadeBox className={cls}>
      <LightweightDiff diff={diff} lang={langOfPath(path)} />
    </FadeBox>
  );
}

// ---------- Expandable read row (shared by standalone reads / entries inside lookup groups, interaction matches the edit row) ----------
// Click the whole row to expand/collapse; the expand body shows the raw text read this time
// (details.displayContent.text, no line-number prefixes), line numbers come from
// startLine/lineNumbers, falling back to sequential indices. No content means not expandable.

/** Format a line range the way the TUI suffixes a read path: `:140-215` (single line `:140`). */
function fmtRange(start: number, end: number): string {
  return start === end ? `:${start}` : `:${start}-${end}`;
}

// The row's `:start-end` badge. Shown only for partial reads; full reads carry none:
// 1. an explicit selector in args.path (the range the model asked for, TUI parity);
// 2. the lines actually shown — elided lineNumbers endpoints, truncation's shownRange,
//    or a summarized read's span (no lineNumbers at all; sequential numbering applies);
//    suppressed when the derived span covers the whole file (totalLines).
export function readRangeLabel(item: ToolItem): string {
  const d = item.details;
  const sel = readSelectorRange(item.args?.path);
  if (sel) return fmtRange(sel[0], sel[1]);
  const dc = d?.displayContent;
  let start: number | undefined;
  let end: number | undefined;
  if (Array.isArray(dc?.lineNumbers)) {
    for (const n of dc.lineNumbers) {
      if (typeof n !== "number") continue;
      if (start === undefined || n < start) start = n;
      if (end === undefined || n > end) end = n;
    }
  }
  if (start === undefined && d?.shownRange) {
    start = d.shownRange.start;
    end = d.shownRange.end;
  }
  if (start === undefined && typeof d?.summary?.lines === "number" && dc?.text) {
    start = dc.startLine ?? 1;
    end = start + d.summary.lines - 1;
  }
  if (start === undefined || end === undefined) return "";
  if (typeof d?.totalLines === "number" && start <= 1 && end >= d.totalLines) return ""; // full-file read
  return fmtRange(start, end);
}

export function ReadRow({ item, inGroup }: { item: ToolItem; inGroup?: boolean }) {
  let path = uniqueFiles(item.files?.length ? item.files : item.args?.path ? [item.args.path] : [])[0] || "";
  if (!path && item.text) {
    const m = item.text.match(/^\[read:\s*(.+?)\]$/);
    if (m) path = m[1].trim();
  }
  const cleanPath = stripReadSelector(path);
  const { dir } = splitPath(cleanPath);
  const rangeLabel = readRangeLabel(item);
  const [closing, close] = useLift();
  // The expand body reads details.displayContent. Missing content has two kinds: result not
  // yet arrived (item.running, e.g. "expanded by default while running" set readExpanded
  // before details arrived) and never present (directory reads, empty results). The former
  // shows a Spin placeholder when expanded, the latter is never expandable; when dc is absent
  // never take properties off dc.text, otherwise any single render insertion at runtime blows
  // up the whole component tree (BUG-016: root cause of the black screen while /goal streamed)
  const dc = item.details?.displayContent;
  const running = !!item.running;
  const canOpen = !item.details?.isDirectory && (!!dc || running);
  const open = item.readExpanded && !closing && canOpen;
  const hasContent = !!dc?.text;
  // Expand-state write channel: standalone rows live in session.items (including inside loop groups), sub-items of lookup groups live in item.group
  const writeExpand = (fn: (it: ToolItem) => void) => (inGroup ? patchGroupSub(item, fn) : patchActiveItem(item, fn));
  const toggle = () => {
    if (item.readExpanded) close(() => writeExpand((it) => { it.readExpanded = false; }));
    else writeExpand((it) => { it.readExpanded = true; });
  };
  return (
    <>
      {/* In-group compact state reuses chg-item (same spacing as edit rows inside change groups); standalone rows keep act.read */}
      {/* Directory read: folder icon + the directory label (not in lookup groups, not expandable) */}
      {item.details?.isDirectory ? (
        <div className={inGroup ? "chg-item" : "act read"}>
          <Icon name="folder" size={15} />
          <span className="lbl">{t("chat.labelDirectory")}</span>
          {cleanPath ? <Ellip className="path" title={cleanPath}>{cleanPath}</Ellip> : item.text || "read"}
        </div>
      ) : (
      <div
        className={inGroup ? "chg-item" : "act read"}
        style={canOpen ? { cursor: "pointer" } : undefined}
        onClick={canOpen ? toggle : undefined}
      >
        <Icon name="file" size={15} />
        <span className="lbl">{t("chat.labelRead")}</span>
        {cleanPath ? (
          <>
            <FileChip path={cleanPath} nameClass={hasContent ? "ed-name" : ""} onNameClick={hasContent ? () => openReadFileInSidebar(item, path || cleanPath) : undefined} />
            {" "}
            {dir && <Ellip className="path" title={cleanPath}>{dir}</Ellip>}
            {rangeLabel && <span className="path">{rangeLabel}</span>}
          </>
        ) : (
          item.text || "read"
        )}
        {running && <Spin />}
        {canOpen && (
          <span className={"ed-arrow" + (open ? " open" : "")}>
            <Icon name="chevronRight" />
          </span>
        )}
      </div>
      )}
      {open && (dc ? (
        <ReadBrief text={dc.text} startLine={dc.startLine} lineNumbers={dc.lineNumbers} lang={langOfPath(cleanPath || path)} lift={closing} />
      ) : (
        <FadeBox className={"ed-brief" + (closing ? " lift" : " drop")}>
          <div className="text-faint text-ui-base py-[12px] px-[10px]"><Spin /></div>
        </FadeBox>
      ))}
    </>
  );
}

// Line cap for the read brief expand body: overlong reads render only the first MAX lines
// inline, avoiding multi-thousand-line DOM and highlight stalls
// (users are hinted to click the file name to view the full file in the right panel)
const MAX_READ_BRIEF_LINES = 500;

// Read expand body: line-number gutter + raw text (reuses the ldiff row structure, no
// add/remove coloring); syntax highlighting when lang matches
function ReadBrief({ text, startLine, lineNumbers, lang, lift }: { text?: string; startLine?: number; lineNumbers?: number[] | null; lang: string | null; lift?: boolean }) {
  const allLines = useMemo(() => String(text || "").split("\n"), [text]);
  const omitted = Math.max(0, allLines.length - MAX_READ_BRIEF_LINES);
  const lines = useMemo(() => (omitted > 0 ? allLines.slice(0, MAX_READ_BRIEF_LINES) : allLines), [allLines, omitted]);
  const code = useMemo(() => lines.join("\n"), [lines]);
  const tokens = useCodeTokens(code, lang);
  return (
    <FadeBox className={"ed-brief" + (lift ? " lift" : " drop")}>
      <div className="ldiff">
        <div className="ldiff-scroll">
          {lines.map((ln, i) => (
            <div key={i} className="ldiff-row">
              <span className="ldiff-gutter" aria-hidden="true">{lineNumbers?.[i] ?? (startLine ?? 1) + i}</span>
              <code className="ldiff-code">{tokens?.[i] ? <CodeTokens line={tokens[i]} /> : ln || " "}</code>
            </div>
          ))}
          {omitted > 0 && (
            <div className="py-[6px] px-[12px] text-faint text-ui-xs">
              {t("chat.readOmitted", { count: omitted })}
            </div>
          )}
        </div>
      </div>
    </FadeBox>
  );
}

// ---------- Right-panel linkage (formerly tool-rows.js openFileDiffInSidebar / tool-labels.js openReadFileInSidebar) ----------
// Clicking an edit row's file name: switch the right panel to the gitdiff detail and expand the panel
export function openFileDiffInSidebar(path: string) {
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  if (!s || !s.isGit) return;
  openRightTab("gitdiff");
  st.setBriefDiff(path, undefined); // the detail and inline expansion share one response
  setBump({
    selectedFile: path,
    fileDiffCache: { ...st.fileDiffCache, loading: true, path },
    briefDiffPending: path,
    rightCollapsed: false, // former expandRightPanel: expanding the right panel collapses the process card out of the way
    todoCollapsed: true,
  });
  st.send({ type: "get_file_diff", cwd: s.cwd, path });
}

// Clicking a read row's file name: the file view first renders immediately with the read
// content while the full file is requested — the whole file shows once the response arrives
export function openReadFileInSidebar(item: ToolItem, path: string) {
  const d = item.details;
  if (!d?.displayContent?.text) return;
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  // The raw path may carry selectors (path:59-123 / path:683:raw): strip all selector
  // segments to get a clean path, and take the first line range in the selector for
  // right-panel line highlight. The range is read off args.path — resolvedPath and the files
  // backfill are clean, so reading the selector off `raw` (resolvedPath-first) yields null
  const raw = String(d.resolvedPath || item.args?.path || path);
  let clean = stripReadSelector(raw);
  if (!clean.startsWith("/")) clean = (s?.cwd || "") + "/" + clean;
  const offset = typeof item.args?.offset === "number" ? item.args.offset : undefined;
  const limit = typeof item.args?.limit === "number" ? item.args.limit : undefined;
  let reqRange: [number, number] | null = readSelectorRange(item.args?.path);
  if (!reqRange && (offset !== undefined || limit !== undefined)) {
    const start = offset ?? 1;
    reqRange = [start, limit !== undefined ? start + limit - 1 : start];
  }
  setBump({
    fileView: {
      path: clean,
      text: d.displayContent.text,
      startLine: d.displayContent.startLine || 1,
      lineNumbers: Array.isArray(d.displayContent.lineNumbers) ? d.displayContent.lineNumbers : null,
      reqRange,
    },
    fileViewPending: clean,
    rightCollapsed: false,
    todoCollapsed: true,
  });
  st.send({ type: "read_file", path: clean });
  openRightTab("file");
}
