// Ghost inline-completion node (contract v1 complete_text RPC): a transient
// DecoratorNode rendered right after the caret while an inline suggestion is
// pending. getTextContent() returns "" so the node is invisible to the
// flattened plain-text view (flat.ts) and to send serialization -- the ghost
// text lives purely in decorate(). Tab (GhostTextPlugin) swaps the node for
// real text nodes; any other edit or caret move removes it. Drafts restored
// with a stale ghost inside are cleaned on plugin mount; updates that
// insert/remove it carry the "historic" tag so it never lands in the undo
// stack (undoing an accept must not resurrect a ghost).
import { DecoratorNode, $applyNodeReplacement, $getRoot, $isElementNode } from "lexical";
import type { LexicalNode, SerializedLexicalNode, Spread } from "lexical";
import type { JSX } from "react";

export type SerializedGhostNode = Spread<{ suggestion: string }, SerializedLexicalNode>;

export class GhostNode extends DecoratorNode<JSX.Element> {
  __suggestion: string;

  static getType(): string {
    return "ghost";
  }

  static clone(node: GhostNode): GhostNode {
    return new GhostNode(node.__suggestion, node.__key);
  }

  static importJSON(json: SerializedGhostNode): GhostNode {
    return $createGhostNode(json.suggestion);
  }

  constructor(suggestion: string, key?: string) {
    super(key);
    this.__suggestion = suggestion;
  }

  // Visual-only node: contributes nothing to the flattened text / send payload
  getTextContent(): string {
    return "";
  }

  exportJSON(): SerializedGhostNode {
    return { suggestion: this.__suggestion, type: GhostNode.getType(), version: 1 };
  }

  createDOM(): HTMLElement {
    // Document-flow shell; visuals render through decorate() into this span
    return document.createElement("span");
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <span className="ghost-t" aria-hidden={true}>
        {this.__suggestion}
      </span>
    );
  }

  isInline(): boolean {
    return true;
  }

  // Never keyboard-selectable: the ghost has no editing semantics of its own
  isKeyboardSelectable(): boolean {
    return false;
  }

  // Keep the ghost out of copy/cut fragment generation
  excludeFromCopy(): boolean {
    return true;
  }
}

export function $createGhostNode(suggestion: string): GhostNode {
  return $applyNodeReplacement(new GhostNode(suggestion));
}

/** Locate the (at most one) ghost node in the tree, or null */
export function $findGhostNode(): GhostNode | null {
  const walk = (node: LexicalNode): GhostNode | null => {
    if (node instanceof GhostNode) return node;
    if (!$isElementNode(node)) return null;
    for (const child of node.getChildren()) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk($getRoot());
}
