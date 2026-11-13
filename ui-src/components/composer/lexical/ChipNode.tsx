// Completion chip node for the composer: an atomic node (DecoratorNode)
// inserted after accepting an @ file / slash command candidate.
// __text is the serialized text (e.g. "@src/foo.ts ", "/compact "), byte-identical
// (trailing space included) to the insertion text of the textarea era's
// insertFile / insertCommand -- both the editor's plain-text view (flat.ts) and
// send serialization consume getTextContent() directly, keeping the WS prompt
// format unchanged. The chip is not inline-editable (atomic) and deletable as
// a whole (isKeyboardSelectable defaults to true).
// decorate() splits display from serialization: the kind is derived from the
// text prefix alone, skills render the bare name, and the icon + category tint
// come from the kind-specific class in composer.css. Session chips are the one
// kind that carries a display label: the serialized "@session:<path>" is a
// machine key, while the user reads the session title.
import { DecoratorNode, $applyNodeReplacement } from "lexical";
import type { LexicalNode, SerializedLexicalNode, Spread } from "lexical";
import type { JSX } from "react";
import Icon from "../../../Icon";

export type SerializedChipNode = Spread<{ text: string; label?: string }, SerializedLexicalNode>;

// Chip kind: derived from the text prefix, mirroring trigger.ts insertFile
// ("@path "), insertCommand ("/cmd " or "/skill:<name> ") and insertSessionRef
// ("@session:<path> " -- a conversation reference the host inlines)
type ChipKind = "file" | "command" | "skill" | "session";

/** Fallback display for a session chip without a captured title: the session
 *  file's name minus directory and extension. */
function sessionFileLabel(text: string): string {
  const raw = text.slice("@session:".length).replace(/^\"|\"$/g, "");
  return (raw.split("/").pop() ?? raw).replace(/\.jsonl$/, "");
}

function chipKindOf(text: string): ChipKind {
  if (text.startsWith("@session:")) return "session";
  if (text.startsWith("@")) return "file";
  if (text.startsWith("/skill:")) return "skill";
  return "command";
}

const CHIP_ICON: Record<ChipKind, string> = { file: "file", command: "commands", skill: "skills", session: "comment" };

export class ChipNode extends DecoratorNode<JSX.Element> {
  __text: string;
  __label?: string;

  static getType(): string {
    return "chip";
  }

  static clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__text, node.__label, node.__key);
  }

  static importJSON(json: SerializedChipNode): ChipNode {
    return $createChipNode(json.text, json.label);
  }

  constructor(text: string, label?: string, key?: string) {
    super(key);
    this.__text = text;
    this.__label = label;
  }

  // Serialized text: both $getRoot().getTextContent() and flat.ts flattening read it here
  getTextContent(): string {
    return this.getLatest().__text;
  }

  exportJSON(): SerializedChipNode {
    return { text: this.__text, label: this.__label, type: ChipNode.getType(), version: 1 };
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
    const text = this.__text.replace(/ +$/, "");
    const kind = chipKindOf(text);
    // Skills display the bare name; the "/skill:" prefix stays in the serialized
    // text so the host still dispatches parseSkillInvocation. Session chips show
    // the title captured at insert time and fall back to the session file name.
    const label =
      kind === "skill"
        ? text.slice("/skill:".length)
        : kind === "session"
          ? (this.__label ?? sessionFileLabel(text))
          : text;
    return (
      <span className={`chip chip-${kind}`}>
        <Icon name={CHIP_ICON[kind]} size={12} className="chip-ic" />
        <span className="chip-t">{label}</span>
      </span>
    );
  }

  isInline(): boolean {
    return true;
  }
}

export function $createChipNode(text: string, label?: string): ChipNode {
  return $applyNodeReplacement(new ChipNode(text, label));
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode;
}
