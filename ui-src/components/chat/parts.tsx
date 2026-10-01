// 消息流共享渲染件：省略号截断 / 文件标签 / 内联代码 / 外链文本 / 渐变遮掩 / 展开体时序 /
// 内联 diff 展开体 / 右栏联动动作。迁移自 ui/tool-rows.js 的共享工具（命令式 DOM 构造
// 翻译为组件）；纯函数（splitPath/uniqueFiles）直接 import 旧模块复用不重写。
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

/** setTimeout 句柄(DOM 与 Node 环境返回类型不同,统一别名) */
type TimerHandle = ReturnType<typeof setTimeout>;

// ---------- item 级写入通道（zustand 迁移：拷贝替换 + _v bump，替代旧「mutate + notify」） ----------

/** 当前会话内按引用定位 item（穿透 loop 组）并拷贝替换：展开/折叠态等 item 级切换用。
 *  patch 回调的 it 是拷贝出的同型条目，读当前值取反即可。 */
export function patchActiveItem<T extends object>(item: T, patch: (it: T) => void): void {
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  if (!s) return;
  // props item 即 store 当前条目引用（引用匹配天然唯一）；经 unknown 中转把拷贝交回同型回调
  patchSessionItem(s.sessionId, (it) => it === item, (it) => {
    patch(it as unknown as T);
    migrateGroupExpand(item as unknown as ToolItem, it as unknown as ToolItem);
  });
}

/** tool 合并组（item.group）内子项的拷贝替换：
 *  合并组是由 renderItems 动态构建的视图分组，底层真实条目在 s.items 或 loop.items 中作为独立元素平铺存储。
 *  定位时优先匹配平铺的 it === sub，同时也兼顾直接挂在 it.group 下的情况。
 *  若更新的子项是组首，同步迁移其在 groupExpand WeakMap 中的组展开态。 */
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

// ---------- 工具结果未到的统一占位（转圈 + 省略号） ----------
// 判据固定取 item.running（tool 帧已到、tool_update 未到）：所有工具的 output 位在结果
// 到达前一律渲染它。各行不得再用「内容缺省」反推运行态——内容缺失既可能是「还没到」
// 也可能是「本来就没有」（目录读取、空结果），只有 running 分得清（BUG-016 的同源教训）
export function Spin() {
  return (
    <span className="flex-none inline-flex items-center gap-[6px] text-dim text-ui-base" role="status">
      <Icon name="loader" size={15} className="pend-ico" />
      …
    </span>
  );
}

// ---------- 省略号截断（e-wrap：文本段 e-tx + 省略号段 e-dot） ----------
// 「…」与前文字 3px 间距：原生 text-overflow:ellipsis 做不到。文本段被裁切时省略号段
// 才显示；共享 ResizeObserver 跟随容器宽窄/界面缩放重算（原 ellipsizable 的组件化）
const eObs = new ResizeObserver((list) => {
  for (const e of list) syncDot(e.target as HTMLElement); // 观察对象均为本组件 span;target 声明为 Element,收窄即可
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

// ---------- 文件标签（f-ic：文件类型图标 + 文件名；onNameClick 时文件名可点） ----------
// fileTypeIcon（按扩展名/文件名取 vscode-icons 彩色图标）见 ui/icons.js
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

// ---------- 内联代码（文本中 `code` 段渲染为 <code>，原 fillInlineCode） ----------
export function InlineCode({ text }: { text?: string }) {
  return String(text || "")
    .split(/(`[^`]+`)/)
    .map((p, i) =>
      p.length > 2 && p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p || null,
    );
}

// ---------- 外链文本（结果输出里的 URL 段变链接；仅 ⌘+点击在系统浏览器外开） ----------
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
    if (m.index) out.push(rest.slice(0, m.index)); // index 恒存在(match 非全局),0 时无前缀段
    const url = m[0].replace(TRAIL_PUNCT_RE, ""); // 尾部悬挂标点留在文本里
    out.push(
      <a
        key={k++}
        className="cursor-pointer text-blue no-underline hover:underline"
        title={t("chat.openInBrowser", { mod: MOD })}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation(); // 不冒泡到整行的展开/收起点击
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

// ---------- 渐变遮掩（滚到底/内容不足一屏时加 .no-fade 解除底部虚化，原 attachFadeMask） ----------
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
  // 动态标签收窄：as 实际仅 "div"（默认）/"pre"（CmdCard 输出体）两种取值，
  // 分支渲染 + 回调 ref 以保住两种具体标签的 ref 类型（等价原 <Tag ref>）
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

// ---------- 展开体时序（原 liftEl 的组件化等价物） ----------
// 展开体挂载即带 .drop/.kids-in 播入场动画——React 复用节点，流式重绘不重播（与原版
// 「仅点击展开那次播」等价；切会话重挂载会重播一次，属可接受差异）；
// 收起先播 .lift/.closing 收拢动画，210ms（loop 组 310ms）后才落盘数据卸载节点。
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

// ---------- 行尾 +n/−n 行数变化（编辑行 / 更改组内行共用，原 appendCounts） ----------
export function Counts({ item }: { item: ToolItem }) {
  return (
    <>
      {(item.added ?? 0) > 0 && <> <span className="add">{`+${item.added}`}</span></>}
      {(item.removed ?? 0) > 0 && <> <span className="del">{`−${item.removed}`}</span></>}
    </>
  );
}

// ---------- 编辑行内联展开的简略 diff 体（原 buildEditBrief） ----------
// diff 来源：item.briefDiff（当次工具回包的真实修改，优先）→ briefDiffCache[path]
// （git diff，右栏详情/内联展开共用回包）。按调用挂在 item 上而非按 path 缓存——
// 同一文件多次编辑时各次展开各看各的，不互相覆盖
export function EditBrief({ item, path, lift }: { item: ToolItem; path: string; lift?: boolean }) {
  const briefDiffCache = useAppStore((s) => s.briefDiffCache); // Map 引用订阅：回包/占位写入即重绘
  const diff = item.briefDiff !== undefined ? item.briefDiff : briefDiffCache.get(path);
  const cls = "ed-brief" + (lift ? " lift" : " drop");
  if (diff === undefined) {
    // 两种「还没到」：工具本身还在跑（当次回包未到 → Spin），或回包已到但 git diff
    // 请求在途（工具已结束 → 保留原文案）。判据同一口径：item.running
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

// ---------- 可展开读取行（单条 read / 查阅组内条目共用，交互与编辑行一致） ----------
// 点击整行展开/收起；展开体显示本次读取到的原文（details.displayContent.text，
// 无行号前缀），行号来自 startLine/lineNumbers，缺省按序号推。无内容不可展开。
export function ReadRow({ item, inGroup }: { item: ToolItem; inGroup?: boolean }) {
  let path = uniqueFiles(item.files?.length ? item.files : item.args?.path ? [item.args.path] : [])[0] || "";
  if (!path && item.text) {
    const m = item.text.match(/^\[read:\s*(.+?)\]$/);
    if (m) path = m[1].trim();
  }
  const cleanPath = stripReadSelector(path);
  const { dir } = splitPath(cleanPath);
  const [closing, close] = useLift();
  // 展开体渲染读 details.displayContent。内容缺失分两种：结果还没到（item.running，
  // 如「运行中默认展开」在 details 到达前就置了 readExpanded）与本来就没有（目录读取、
  // 空结果）。前者展开显示 Spin 占位，后者一律不可展开；dc 缺省时绝不对 dc.text 取属性，
  // 否则运行期任意一次插入渲染直接炸掉整棵组件树（BUG-016：/goal 流式中黑屏根因）
  const dc = item.details?.displayContent;
  const running = !!item.running;
  const canOpen = !item.details?.isDirectory && (!!dc || running);
  const open = item.readExpanded && !closing && canOpen;
  const hasContent = !!dc?.text;
  // 展开态写入通道：独立行在 session.items 里（含 loop 组内），查阅组内子项在 item.group 里
  const writeExpand = (fn: (it: ToolItem) => void) => (inGroup ? patchGroupSub(item, fn) : patchActiveItem(item, fn));
  const toggle = () => {
    if (item.readExpanded) close(() => writeExpand((it) => { it.readExpanded = false; }));
    else writeExpand((it) => { it.readExpanded = true; });
  };
  return (
    <>
      {/* 组内紧凑态复用 chg-item（与更改组内编辑行同款间距）；独立行保持 act.read */}
      {/* 目录读取：folder 图标 + 「目录」标签（不进查阅组、不可展开） */}
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

// 读取简略展开体行数上限：超长读取只在内联渲染前 MAX 行，避免几千行 DOM 与染色卡死
// （提示用户点击文件名可在右栏查看完整文件）
const MAX_READ_BRIEF_LINES = 500;

// 读取展开体：行号 gutter + 原文（ldiff 行结构复用，无增删着色）；lang 命中走语法染色
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

// ---------- 右栏联动（原 tool-rows.js openFileDiffInSidebar / tool-labels.js openReadFileInSidebar） ----------
// 点击编辑行文件名：右侧边栏切到 gitdiff 详情并展开面板
export function openFileDiffInSidebar(path: string) {
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  if (!s || !s.isGit) return;
  openRightTab("gitdiff");
  st.setBriefDiff(path, undefined); // 详情与内联展开共用一次回包
  setBump({
    selectedFile: path,
    fileDiffCache: { ...st.fileDiffCache, loading: true, path },
    briefDiffPending: path,
    rightCollapsed: false, // 原版 expandRightPanel：展开右栏时进程卡让位收起
    todoCollapsed: true,
  });
  st.send({ type: "get_file_diff", cwd: s.cwd, path });
}

// 点击读取行文件名：文件页先用读取到的内容即时渲染，同时请求全文件——回包后整文件展示
export function openReadFileInSidebar(item: ToolItem, path: string) {
  const d = item.details;
  if (!d?.displayContent?.text) return;
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  // 原始路径可能带选择器（path:59-123 / path:683:raw）：剥离全部选择器段得到干净路径，
  // 并取选择器里的首个行范围用于右栏行号高亮
  const raw = String(d.resolvedPath || item.args?.path || path);
  let clean = stripReadSelector(raw);
  if (!clean.startsWith("/")) clean = (s?.cwd || "") + "/" + clean;
  const offset = typeof item.args?.offset === "number" ? item.args.offset : undefined;
  const limit = typeof item.args?.limit === "number" ? item.args.limit : undefined;
  let reqRange: [number, number] | null = readSelectorRange(raw);
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
