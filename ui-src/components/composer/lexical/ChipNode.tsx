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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import Icon from "../../../Icon";
import { isDirToken } from "../../../lib/at-mentions";
import { placeMenu } from "../../../shell";

export type SerializedChipNode = Spread<{ text: string; label?: string }, SerializedLexicalNode>;

// Chip kind: derived from the text prefix, mirroring trigger.ts insertFile
// ("@path "), insertCommand ("/cmd " or "/skill:<name> ") and insertSessionRef
// ("@session:<path> " -- a conversation reference the host inlines), plus the
// browser mirror's picked-element block ("[element] sel WxH" + fenced html).
type ChipKind = "file" | "command" | "skill" | "session" | "element";

/** Fallback display for a session chip without a captured title: the session
 *  file's name minus directory and extension. */
function sessionFileLabel(text: string): string {
  const raw = text.slice("@session:".length).replace(/^\"|\"$/g, "");
  return (raw.split("/").pop() ?? raw).replace(/\.jsonl$/, "");
}

function chipKindOf(text: string): ChipKind {
  if (text.startsWith("[element]")) return "element";
  if (text.startsWith("@session:")) return "session";
  if (text.startsWith("@")) return "file";
  if (text.startsWith("/skill:")) return "skill";
  return "command";
}

const CHIP_ICON: Record<ChipKind, string> = {
  // Directory mentions reuse the sidebar's expanded-project icon (folderOpen)
  file: "file",
  command: "commands",
  skill: "skills",
  session: "comment",
  element: "squareMousePointer",
};

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
          : // The slash is a composer sigil, not part of the command name
            kind === "command"
            ? text.replace(/^\//, "")
            : text;
    if (kind === "element") return <ElementChip text={text} />;
    return (
      <span className={`chip chip-${kind}`}>
        <Icon name={kind === "file" && isDirToken(this.__text) ? "folderOpen" : CHIP_ICON[kind]} size={12} className="chip-ic" />
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

// Picked element from the browser mirror: the header line and the fenced html stay one
// chip, so the payload the Agent will read lives in the hover card instead of eating
// composer lines. Serialization is untouched (getTextContent returns the block as-is).
const EL_GAP = 10;
const EL_EDGE = 8;

/** Split the block back into its header fields: "[element] sel WxH", the meta lines,
 *  and the html between the fences. */
function parseElement(text: string) {
  const [head, ...rest] = text.split("\n");
  const body = head.replace(/^\[element\] /, "");
  const cut = body.lastIndexOf(" ");
  const fence = rest.findIndex((line) => line.startsWith("```"));
  const end = fence < 0 ? -1 : rest.indexOf("```", fence + 1);
  return {
    selector: cut > 0 ? body.slice(0, cut) : body,
    size: cut > 0 ? body.slice(cut + 1) : "",
    meta: fence < 0 ? rest : rest.slice(0, fence),
    html: fence < 0 ? "" : rest.slice(fence + 1, end < 0 ? rest.length : end).join("\n"),
  };
}

function ElementChip({ text }: { text: string }) {
  const { selector, size, meta, html } = parseElement(text);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  // Grace so the pointer can cross the gap into the card
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => cancelClose, []);

  // Same anchoring recipe as AnnotationChips: above the chip, flipped below when clipped
  useLayoutEffect(() => {
    const chip = chipRef.current;
    const pop = popRef.current;
    if (!open || !chip || !pop) return;
    placeMenu(pop, 0, 0); // apply zoom before reading visual sizes
    const c = chip.getBoundingClientRect();
    const b = pop.getBoundingClientRect();
    const left = Math.min(Math.max(c.left, EL_EDGE), window.innerWidth - b.width - EL_EDGE);
    const above = c.top - b.height - EL_GAP;
    const top = above >= EL_EDGE ? above : Math.min(c.bottom + EL_GAP, window.innerHeight - b.height - EL_EDGE);
    placeMenu(pop, left, top);
  });

  return (
    <>
      <span
        ref={chipRef}
        className="chip chip-element"
        tabIndex={0}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
      >
        <Icon name="squareMousePointer" size={12} className="chip-ic" />
        <span className="chip-t">{selector}</span>
        {size ? <span className="chip-sz">{size}</span> : null}
      </span>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="el-pop"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="el-pop-head">
              <span className="el-pop-sel">{selector}</span>
              <span className="el-pop-sz">{size}</span>
            </div>
            {meta.map((line, i) => (
              <div className="el-pop-kv" key={i}>
                {line}
              </div>
            ))}
            {html ? <pre className="el-pop-code">{html}</pre> : null}
          </div>,
          document.body,
        )}
    </>
  );
}
