// 自研轻量 diff 渲染：移植 ZCode packages/ui/src/components/ui/lightweight-diff-preview.tsx
// （纯 CSS 行解析，无第三方依赖）。只用行背景 color-mix + 行首 inset 状态条 + 行号 gutter
// 着色表达增删，不显示 unified diff 的 +/-/空格 marker。
// 语法染色移植 ZCode highlighted-lightweight-diff-preview：整段内容一次 tokenize
// （ZCode 同款，跨行语法状态一致），按行回贴 token span；行底色仍归本组件 CSS。
// 行过滤同 ZCode collectPlainTextPreviewLines：文件头（diff --git/index/---/+++ 等）与
// hunk 头（@@）一律不渲染，只画 hunk 正文——预览不暴露协议头。
import { useMemo } from "react";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens.jsx";

// 渲染行数上限：host 对 file_diff 回包按 500k 字符截断，超长 diff 只画前 MAX 行，
// 尾部补一行省略提示，避免单文件超大 diff 卡渲染
const MAX_RENDER_LINES = 4000;

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/;
const META_RE = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/;
const NOTE_RE = /^\\ /;
// 底座 edit 工具 details.diff 的行号格式（TUI 同款）：「符号 + 行号 + |/│ + 文本」，
// 符号 ∈ 空格(上下文) / -(旧) / +(新)；分隔符也可能是全角 │。非 unified diff，无 hunk 头
const LN_RE = /^([-+\s])\s*(\d+)[|│](.*)$/;

// 解析 unified diff 文本为行结构：按 +/-/空格 前缀分类正文行并跟踪 hunk 头里的
// 新旧行号；文件头与 hunk 头跳过不渲染（行号仍在 hunk 头处对齐，残缺 hunk 宽容记账）。
function parseUnifiedDiff(diff) {
  const lines = String(diff ?? "").split("\n");
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let omitted = 0;
  let inHunk = false; // ZCode 同款过滤：进 hunk 前只认 hunk 头，进了之后 @@/文件头全跳过
  for (let i = 0; i < lines.length; i++) {
    if (rows.length >= MAX_RENDER_LINES) {
      omitted = lines.length - i;
      break;
    }
    const raw = lines[i];
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk || META_RE.test(raw)) continue;
    if (NOTE_RE.test(raw)) {
      rows.push({ kind: "note", text: raw });
    } else if (raw.startsWith("+")) {
      rows.push({ kind: "added", text: raw.slice(1), no: newLine++ });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "removed", text: raw.slice(1), no: oldLine++ });
    } else {
      // 空格前缀上下文行；完全空行按上下文兜底（git 正文不会输出空行）
      rows.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, no: newLine++, oldNo: oldLine++ });
    }
  }
  return { rows, omitted };
}

// 解析底座行号 diff（edit 工具 details.diff）：每行自带新旧行号，无需 hunk 头对齐
function parseLnDiff(diff) {
  const lines = String(diff ?? "").split("\n");
  const rows = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (rows.length >= MAX_RENDER_LINES) {
      omitted = lines.length - i;
      break;
    }
    const m = LN_RE.exec(lines[i]);
    if (!m) continue;
    const no = Number(m[2]);
    if (m[1] === "-") rows.push({ kind: "removed", text: m[3], no });
    else if (m[1] === "+") rows.push({ kind: "added", text: m[3], no });
    else rows.push({ kind: "context", text: m[3], no });
  }
  return { rows, omitted };
}

// 统一入口：unified diff 优先；无 hunk 正文（底座行号格式）时回落行号解析
function parseDiff(diff) {
  const unified = parseUnifiedDiff(diff);
  if (unified.rows.length > 0) return unified;
  return parseLnDiff(diff);
}

export default function LightweightDiff({ diff, lang, className = "" }) {
  const { rows, omitted } = useMemo(() => parseDiff(diff), [diff]);
  // 整段内容（行文本按序 join）一次 tokenize，按行下标回贴；lang 为空/超长按纯文本渲染
  const code = useMemo(() => rows.map((r) => r.text).join("\n"), [rows]);
  const tokens = useCodeTokens(code, lang);
  return (
    <div className={"ldiff" + (className ? " " + className : "")}>
      <div className="ldiff-scroll">
        {rows.map((row, i) => (
          <div key={i} className={"ldiff-row ldiff-" + row.kind}>
            {"no" in row || "oldNo" in row ? (
              <span className="ldiff-gutter" aria-hidden="true">{row.no}</span>
            ) : (
              <span className="ldiff-gutter" aria-hidden="true" />
            )}
            <code className="ldiff-code">
              {tokens?.[i] ? <CodeTokens line={tokens[i]} /> : row.text || " "}
            </code>
          </div>
        ))}
        {omitted > 0 && <div className="ldiff-truncated">… 内容过长，已省略剩余 {omitted} 行</div>}
      </div>
    </div>
  );
}
