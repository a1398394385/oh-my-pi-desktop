// 消息流共享渲染件：省略号截断 / 文件标签 / 内联代码 / 外链文本 / 渐变遮掩 / 展开体时序 /
// 内联 diff 展开体 / 右栏联动动作。迁移自 ui/tool-rows.js 的共享工具（命令式 DOM 构造
// 翻译为组件）；纯函数（splitPath/uniqueFiles）直接 import 旧模块复用不重写。
import { useEffect, useRef, useState } from "react";
import { S, send, notify, activeOpen, invoke, toast, briefDiffCache, fileDiffCache } from "../../store.js";
import { uniqueFiles, splitPath } from "./util.js";
import Icon from "../../Icon.jsx";
import { openRightTab } from "../RightPanel.jsx";

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
function fileTypeIcon(name) {
  const base = String(name || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  const ext = i >= 0 ? base.slice(i + 1).toLowerCase() : "";
  if (ext === "html" || ext === "htm") return "ftHtml";
  if (ext === "css") return "ftCss";
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "tsx") return "ftJs";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "ftImg";
  return "ftFile";
}
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
export function EditBrief({ path, lift }) {
  const diff = briefDiffCache[path];
  const cls =
    "ed-brief" +
    (lift ? " lift" : " drop") +
    (document.documentElement.dataset.theme === "dark" ? " d2h-dark-color-scheme" : "");
  let html;
  if (diff === undefined) html = '<div class="placeholder">加载中…</div>';
  else if (!diff) html = '<div class="placeholder">（无差异内容）</div>';
  else
    html = window.Diff2Html.html(diff, {
      drawFileList: false,
      outputFormat: "line-by-line",
      matching: "words",
      highlight: true,
    });
  return <FadeBox className={cls} html={html} />;
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
  briefDiffCache[path] = undefined; // 详情与内联展开共用一次回包
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
