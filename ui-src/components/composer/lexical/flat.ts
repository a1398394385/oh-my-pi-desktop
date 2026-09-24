// 编辑器纯文本视图：把 Lexical 树压平成与旧 textarea 等价的纯文本——
// TextNode 原样 / LineBreakNode 与段落边界 → \n / ChipNode → 序列化文本（@路径、/命令）。
// sigil 触发检测（composer/trigger.ts 的 detectTrigger）与发送序列化都基于这一视图，
// 光标的全局偏移同样在此换算（text anchor 按叶子区间累加，element anchor 按子节点
// 索引把前缀子树文本计入），保证行为与 textarea 时代逐字节对齐。
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $createRangeSelection,
  $setSelection,
} from "lexical";
import type { LexicalNode } from "lexical";

// 任意节点的全局文本区间（叶子承载文本，element 区间为其内容范围）
type NodeSpan = { node: LexicalNode; start: number; end: number };

function $flatten(): { text: string; spans: NodeSpan[] } {
  const root = $getRoot();
  let text = "";
  const spans: NodeSpan[] = [];
  const walk = (node: LexicalNode) => {
    const start = text.length;
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) walk(child);
    } else {
      // 叶子（Text / LineBreak / Chip）：chip 的 getTextContent 已覆写为序列化文本
      text += node.getTextContent();
    }
    spans.push({ node, start, end: text.length });
  };
  const blocks = root.getChildren();
  blocks.forEach((block, i) => {
    if (i > 0) text += "\n"; // 段落边界 = 换行（多段只见于粘贴等场景，输入恒为单段）
    walk(block);
  });
  return { text, spans };
}

/** 编辑器全文的纯文本形态（发送 / hasDraft / bash 前缀判定用） */
export function $flattenText(): string {
  return $flatten().text;
}

/** 全文 + 光标的全局偏移（无折叠选区时 caret 为 null） */
export function $flattenWithCaret(): { text: string; caret: number | null } {
  const { text, spans } = $flatten();
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return { text, caret: null };
  const anchor = sel.anchor;
  if (anchor.type === "text") {
    const span = spans.find((s) => s.node.__key === anchor.key);
    return { text, caret: span ? span.start + anchor.offset : null };
  }
  // element anchor：offset 是子节点索引（caret 停在 chip 前后 / 空段落时走到这里）
  const el = anchor.getNode();
  const span = spans.find((s) => s.node === el);
  if (!span) return { text, caret: null };
  let caret = span.start;
  const kids = el.getChildren();
  for (let i = 0; i < Math.min(anchor.offset, kids.length); i++) caret += kids[i].getTextContent().length;
  return { text, caret };
}

/** 某叶子节点文本的全文起点（triggerFn 校验触发区间是否完整落在 anchor 节点内） */
export function $leafStart(node: LexicalNode): number | null {
  const { spans } = $flatten();
  return spans.find((s) => s.node === node)?.start ?? null;
}

/** 用纯文本整体重建编辑器内容（外部回填：分叉选文 / 排队消息编辑拉回）。
    换行用单段 + LineBreakNode 表达，与 $flattenText 的压平规则互逆。 */
export function $setText(text: string): void {
  const root = $getRoot();
  root.clear();
  const p = $createParagraphNode();
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) p.append($createLineBreakNode());
    if (line) p.append($createTextNode(line));
  });
  root.append(p);
  p.selectEnd();
}

/** 把折叠光标放到某节点（chip）之后：element anchor 指向其父内的下一子位 */
export function $selectAfter(node: LexicalNode): void {
  const parent = node.getParentOrThrow();
  const idx = node.getIndexWithinParent();
  const sel = $createRangeSelection();
  sel.anchor.set(parent.getKey(), idx + 1, "element");
  sel.focus.set(parent.getKey(), idx + 1, "element");
  $setSelection(sel);
}
