// 自研轻量 diff 渲染：移植 ZCode packages/ui/src/components/ui/lightweight-diff-preview.tsx
// （纯 CSS 行解析，无第三方依赖）。只用行背景 color-mix + 行首 inset 状态条 + 行号 gutter
// 着色表达增删，不显示 unified diff 的 +/-/空格 marker。语法高亮不做（markdown.js 同为纯文本）。
import { useMemo } from "react";

// 渲染行数上限：host 对 file_diff 回包按 500k 字符截断，超长 diff 只画前 MAX 行，
// 尾部补一行省略提示，避免单文件超大 diff 卡渲染
const MAX_RENDER_LINES = 4000;

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/;
const META_RE = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/;
const NOTE_RE = /^\\ /;

// 解析 unified diff 文本为行结构：按 +/-/空格 前缀分类正文行并跟踪 hunk 头里的
// 新旧行号；文件头（diff --git/index/---/+++ 等）与 hunk 头单独成行，便于样式分层。
// 行数记账对残缺 hunk 宽容——host 截断或模型产出 off-by-one 时不中断渲染。
function parseUnifiedDiff(diff) {
  const lines = String(diff ?? "").split("\n");
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let omitted = 0;
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
      rows.push({ kind: "hunk", text: raw });
    } else if (META_RE.test(raw)) {
      rows.push({ kind: "meta", text: raw });
    } else if (NOTE_RE.test(raw)) {
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

export default function LightweightDiff({ diff, className = "" }) {
  const { rows, omitted } = useMemo(() => parseUnifiedDiff(diff), [diff]);
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
            <code className="ldiff-code">{row.text || " "}</code>
          </div>
        ))}
        {omitted > 0 && <div className="ldiff-truncated">… 内容过长，已省略剩余 {omitted} 行</div>}
      </div>
    </div>
  );
}
