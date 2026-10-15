// Editor plain-text view: flattens the Lexical tree into plain text equivalent
// to the old textarea -- TextNode verbatim / LineBreakNode and paragraph
// boundaries -> \n / ChipNode -> serialized text (@path, /command).
// Both sigil trigger detection (detectTrigger in composer/trigger.ts) and send
// serialization build on this view; the caret's global offset is also computed
// here (text anchors accumulate over leaf spans, element anchors count prefix
// subtree text by child index), keeping behavior byte-aligned with the
// textarea era.
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

// Global text span of any node (leaves carry text; an element's span is its content range)
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
      // Leaf (Text / LineBreak / Chip): a chip's getTextContent is already
      // overridden to its serialized text
      text += node.getTextContent();
    }
    spans.push({ node, start, end: text.length });
  };
  const blocks = root.getChildren();
  blocks.forEach((block, i) => {
    if (i > 0) text += "\n"; // paragraph boundary = newline (multiple paragraphs only occur in paste-like cases; typing is always single-paragraph)
    walk(block);
  });
  return { text, spans };
}

/** Plain-text form of the whole editor text (used by send / hasDraft / bash prefix detection) */
export function $flattenText(): string {
  return $flatten().text;
}

/** Whole text plus the caret's global offset (caret is null without a collapsed selection) */
export function $flattenWithCaret(): { text: string; caret: number | null } {
  const { text, spans } = $flatten();
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return { text, caret: null };
  const anchor = sel.anchor;
  if (anchor.type === "text") {
    const span = spans.find((s) => s.node.__key === anchor.key);
    return { text, caret: span ? span.start + anchor.offset : null };
  }
  // element anchor: offset is the child index (reached when the caret sits
  // before/after a chip or in an empty paragraph)
  const el = anchor.getNode();
  const span = spans.find((s) => s.node === el);
  if (!span) return { text, caret: null };
  let caret = span.start;
  const kids = el.getChildren();
  for (let i = 0; i < Math.min(anchor.offset, kids.length); i++) caret += kids[i].getTextContent().length;
  return { text, caret };
}

/** Global start of a leaf node's text (triggerFn checks whether the trigger
    range falls entirely inside the anchor node) */
export function $leafStart(node: LexicalNode): number | null {
  const { spans } = $flatten();
  return spans.find((s) => s.node === node)?.start ?? null;
}

/** Rebuild the editor content wholesale from plain text (external backfill:
    fork selected text / queued message recall). Newlines are expressed as a
    single paragraph + LineBreakNodes, inverse of $flattenText's flattening
    rules. */
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

/** Place the collapsed caret after a node (chip): the element anchor points to
    the next child slot within its parent */
export function $selectAfter(node: LexicalNode): void {
  const parent = node.getParentOrThrow();
  const idx = node.getIndexWithinParent();
  const sel = $createRangeSelection();
  sel.anchor.set(parent.getKey(), idx + 1, "element");
  sel.focus.set(parent.getKey(), idx + 1, "element");
  $setSelection(sel);
}
