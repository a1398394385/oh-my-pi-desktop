// Completion chip node for the composer: an atomic node (DecoratorNode)
// inserted after accepting an @ file / slash command candidate.
// __text is the serialized text (e.g. "@src/foo.ts ", "/compact "), byte-identical
// (trailing space included) to the insertion text of the textarea era's
// insertFile / insertCommand -- both the editor's plain-text view (flat.ts) and
// send serialization consume getTextContent() directly, keeping the WS prompt
// format unchanged. The chip is not inline-editable (atomic) and deletable as
// a whole (isKeyboardSelectable defaults to true).
import { DecoratorNode, $applyNodeReplacement } from "lexical";
import type { LexicalNode, SerializedLexicalNode, Spread } from "lexical";
import type { JSX } from "react";

export type SerializedChipNode = Spread<{ text: string }, SerializedLexicalNode>;

export class ChipNode extends DecoratorNode<JSX.Element> {
  __text: string;

  static getType(): string {
    return "chip";
  }

  static clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__text, node.__key);
  }

  static importJSON(json: SerializedChipNode): ChipNode {
    return $createChipNode(json.text);
  }

  constructor(text: string, key?: string) {
    super(key);
    this.__text = text;
  }

  // Serialized text: both $getRoot().getTextContent() and flat.ts flattening read it here
  getTextContent(): string {
    return this.getLatest().__text;
  }

  exportJSON(): SerializedChipNode {
    return { text: this.__text, type: ChipNode.getType(), version: 1 };
  }

  createDOM(): HTMLElement {
    // The DOM shell is only a document-flow placeholder; visuals are rendered
    // by decorate() (Lexical decorator layer)
    return document.createElement("span");
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    // Display text drops the trailing space (that is a delimiter in the send
    // text; visual spacing is carried by the chip itself)
    return <span className="chip">{this.__text.replace(/ +$/, "")}</span>;
  }

  isInline(): boolean {
    return true;
  }
}

export function $createChipNode(text: string): ChipNode {
  return $applyNodeReplacement(new ChipNode(text));
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode;
}
