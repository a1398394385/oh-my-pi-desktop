// 消息流共享渲染件：省略号截断 / 文件标签 / 内联代码 / 外链文本 / 渐变遮掩 / 展开体时序 /
// 内联 diff 展开体 / 右栏联动动作。迁移自 ui/tool-rows.js 的共享工具（命令式 DOM 构造
// 翻译为组件）；纯函数（splitPath/uniqueFiles）直接 import 旧模块复用不重写。
import { useEffect, useRef, useState } from "react";
import { S, send, notify, activeOpen, invoke, toast, briefDiffCache, fileDiffCache, setBriefDiff } from "../../store.js";
import { uniqueFiles, splitPath } from "./util.js";
import Icon from "../../Icon.jsx";
import { fileTypeIcon } from "../../../ui/icons.js";
import { langOfPath } from "../../lib/highlighter.js";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens.jsx";
import { openRightTab } from "../RightPanel.jsx";
import LightweightDiff from "../diff/LightweightDiff.jsx";

export { uniqueFiles, splitPath };

// ---------- 省略号截断（e-wrap：文本段 e-tx + 省略号段 e-dot） ----------
// 「…」与前文字 3px 间距：原生 text-overflow:ellipsis 做不到。文本段被裁切时省略号段
// 才显示；共享 ResizeObserver 跟随容器宽窄/界面缩放重算（原 ellipsizable 的组件化）
const eObs = new ResizeObserver((list) => {
  for (const e of list) syncDot(e.target);
});
function syncDot(tx) {
  const dot = tx.nextElementSibling;
  if (!dot || !dot.classList.contains("e-dot")) return;
  dot.style.display = tx.scrollWidth > tx.clientWidth + 1 ? "" : "none";
}
export function Ellip({ className = "", title, children }) {
  const ref = useRef(null);
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
export function FileChip({ path, nameClass, onNameClick }) {
  const { name } = splitPath(path);
  return (
    <span className="f-ic" title={path}>
      <Icon name={fileTypeIcon(name || path)} />
      <span
        className={(nameClass || "") + (onNameClick ? " lnk" : "")}
        onClick={onNameClick ? (e) => { e.stopPropagation(); onNameClick(e); } : undefined}
      >
        {name || path}
      </span>
    </span>
  );
}

// ---------- 内联代码（文本中 `code` 段渲染为 <code>，原 fillInlineCode） ----------
export function InlineCode({ text }) {
  return String(text || "")
    .split(/(`[^`]+`)/)
    .map((p, i) =>
      p.length > 2 && p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p || null,
    );
}

// ---------- 外链文本（结果输出里的 URL 段变链接；仅 ⌘+点击在系统浏览器外开） ----------
const LINK_RE = /https?:\/\/[^\s<>"'，、。；：！？]+/u;
const TRAIL_PUNCT_RE = /[.,;:!?，、。；：！？)\]}〉》」』】'"”’]+$/u;
async function openExternal(url) {
  try {
    if (invoke) await invoke("plugin:opener|open_url", { url });
    else window.open(url, "_blank", "noopener");
  } catch (err) {
    toast(`打开链接失败：${err}`);
  }
}
export function LinkedText({ text }) {
  const out = [];
  let rest = String(text || "");
  let k = 0;
  for (;;) {
    const m = rest.match(LINK_RE);
    if (!m) break;
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const url = m[0].replace(TRAIL_PUNCT_RE, ""); // 尾部悬挂标点留在文本里
    out.push(
      <a
        key={k++}
        className="ext-link"
        title="⌘+点击在默认浏览器打开"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation(); // 不冒泡到整行的展开/收起点击
          if (e.metaKey) openExternal(url);
        }}
      >
        {url}
      </a>,
    );
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(rest);
  return out;
}

// ---------- 渐变遮掩（滚到底/内容不足一屏时加 .no-fade 解除底部虚化，原 attachFadeMask） ----------
export function FadeBox({ className, as = "div", children, html }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const sync = () => el.classList.toggle("no-fade", el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    el.addEventListener("scroll", sync, { passive: true });
    requestAnimationFrame(sync);
    return () => el.removeEventListener("scroll", sync);
  });
  const Tag = as;
  return html !== undefined
    ? <Tag className={className} ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
    : <Tag className={className} ref={ref}>{children}</Tag>;
}

// ---------- 展开体时序（原 liftEl 的组件化等价物） ----------
// 展开体挂载即带 .drop/.kids-in 播入场动画——React 复用节点，流式重绘不重播（与原版
// 「仅点击展开那次播」等价；切会话重挂载会重播一次，属可接受差异）；
// 收起先播 .lift/.closing 收拢动画，210ms（loop 组 310ms）后才落盘数据卸载节点。
export function useLift() {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = (commit, delay = 210) => {
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
export function Counts({ item }) {
  return (
    <>
      {item.added > 0 && <> <span className="add">{`+${item.added}`}</span></>}
      {item.removed > 0 && <> <span className="del">{`−${item.removed}`}</span></>}
    </>
  );
}

// ---------- 编辑行内联展开的简略 diff 体（原 buildEditBrief） ----------
// diff 来源：item.briefDiff（当次工具回包的真实修改，优先）→ briefDiffCache[path]
// （git diff，右栏详情/内联展开共用回包）。按调用挂在 item 上而非按 path 缓存——
// 同一文件多次编辑时各次展开各看各的，不互相覆盖
export function EditBrief({ item, path, lift }) {
  const diff = item.briefDiff !== undefined ? item.briefDiff : briefDiffCache.get(path);
  const cls = "ed-brief" + (lift ? " lift" : " drop");
  if (diff === undefined) return <FadeBox className={cls}><div className="placeholder">加载中…</div></FadeBox>;
  if (!diff) return <FadeBox className={cls}><div className="placeholder">（无差异内容）</div></FadeBox>;
  return (
    <FadeBox className={cls}>
      <LightweightDiff diff={diff} lang={langOfPath(path)} />
    </FadeBox>
  );
}

// ---------- 可展开读取行（单条 read / 查阅组内条目共用，交互与编辑行一致） ----------
// 点击整行展开/收起；展开体显示本次读取到的原文（details.displayContent.text，
// 无行号前缀），行号来自 startLine/lineNumbers，缺省按序号推。无内容不可展开。
export function ReadRow({ item, inGroup }) {
  const path = uniqueFiles(item.files?.length ? item.files : item.args?.path ? [item.args.path] : [])[0] || "";
  const { dir } = splitPath(path);
  const [closing, close] = useLift();
  const open = item.readExpanded && !closing;
  const hasContent = !!item.details?.displayContent?.text;
  const toggle = () => {
    if (item.readExpanded) close(() => { item.readExpanded = false; notify(); });
    else {
      item.readExpanded = true;
      notify();
    }
  };
  const dc = item.details?.displayContent;
  return (
    <>
      {/* 组内紧凑态复用 chg-item（与更改组内编辑行同款间距）；独立行保持 act.read */}
      {/* 目录读取：folder 图标 + 「目录」标签（不进查阅组、不可展开） */}
      {item.details?.isDirectory ? (
        <div className={inGroup ? "chg-item" : "act read"}>
          <Icon name="folder" size={13} />
          <span className="lbl">目录</span>
          {path ? <Ellip className="path" title={path}>{path}</Ellip> : item.text || "read"}
        </div>
      ) : (
      <div
        className={inGroup ? "chg-item" : "act read"}
        style={hasContent ? { cursor: "pointer" } : undefined}
        onClick={hasContent ? toggle : undefined}
      >
        <Icon name="file" size={13} />
        <span className="lbl">读取</span>
        {path ? (
          <>
            <FileChip path={path} nameClass={hasContent ? "ed-name" : ""} onNameClick={hasContent ? () => openReadFileInSidebar(item, path) : undefined} />
            {" "}
            {dir && <Ellip className="path" title={path}>{dir}</Ellip>}
          </>
        ) : (
          item.text || "read"
        )}
        {hasContent && (
          <span className={"ed-arrow" + (open ? " open" : "")}>
            <Icon name="chevronRight" />
          </span>
        )}
      </div>
      )}
      {open && (
        <ReadBrief text={dc.text} startLine={dc.startLine} lineNumbers={dc.lineNumbers} lang={langOfPath(path)} lift={closing} />
      )}
    </>
  );
}

// 读取展开体：行号 gutter + 原文（ldiff 行结构复用，无增删着色）；lang 命中走语法染色
function ReadBrief({ text, startLine, lineNumbers, lang, lift }) {
  const lines = String(text).split("\n");
  const tokens = useCodeTokens(lines.join("\n"), lang);
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
        </div>
      </div>
    </FadeBox>
  );
}

// ---------- 右栏联动（原 tool-rows.js openFileDiffInSidebar / tool-labels.js openReadFileInSidebar） ----------
// 点击编辑行文件名：右侧边栏切到 gitdiff 详情并展开面板
export function openFileDiffInSidebar(path) {
  const s = activeOpen();
  if (!s || !s.isGit) return;
  openRightTab("gitdiff");
  S.selectedFile = path;
  fileDiffCache.loading = true;
  fileDiffCache.path = path;
  setBriefDiff(path, undefined); // 详情与内联展开共用一次回包
  S.briefDiffPending = path;
  send({ type: "get_file_diff", cwd: s.cwd, path });
  S.rightCollapsed = false; // 原版 expandRightPanel：展开右栏时进程卡让位收起
  S.todoCollapsed = true;
  notify();
}

// 点击读取行文件名：文件页先用读取到的内容即时渲染，同时请求全文件——回包后整文件展示
export function openReadFileInSidebar(item, path) {
  const d = item.details;
  if (!d?.displayContent?.text) return;
  // 原始路径可能带行号选择器（path:59-123）：解析出请求范围用于行号高亮，并剥掉后缀得到干净路径
  const raw = String(d.resolvedPath || path);
  const m = raw.match(/:(\d+)(?:-(\d+))?$/);
  let clean = m ? raw.slice(0, m.index) : raw;
  if (!clean.startsWith("/")) clean = (activeOpen()?.cwd || "") + "/" + clean;
  S.fileView = {
    path: clean,
    text: d.displayContent.text,
    startLine: d.displayContent.startLine || 1,
    lineNumbers: Array.isArray(d.displayContent.lineNumbers) ? d.displayContent.lineNumbers : null,
    reqRange: m ? [Number(m[1]), Number(m[2] || m[1])] : null,
  };
  S.fileViewPending = clean;
  send({ type: "read_file", path: clean });
  openRightTab("file");
  S.rightCollapsed = false;
  S.todoCollapsed = true;
  notify();
}
