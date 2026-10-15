// ! bash-mode completion (terminal-style): unlike the sigil TypeaheadMenu's
// token triggers, the whole line is the completion domain. Debounced
// bash_complete RPC against the host (PATH executables for the first token,
// cwd-relative paths afterwards); the card reuses the palette menu classes and
// placePaletteCard anchoring. Keyboard: ↑/↓ highlight, Tab/Enter accept,
// Esc close. While open the shared typeaheadOpenRef makes ComposerPlugin's
// Enter-send / Esc-blur / Alt+↑ yield (mineRef restores it on close so a
// concurrently open sigil panel is never clobbered).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
} from "lexical";
import type { TextNode } from "lexical";
import type { RefObject } from "react";
import { useAppStore } from "../../../store";
import { $flattenWithCaret } from "./flat";
import { isBashMode } from "../trigger";
import { placePaletteCard } from "../place";

type Item = { label: string; kind: "cmd" | "dir" | "file" };

const DEBOUNCE_MS = 150;

type Props = {
  typeaheadOpenRef: RefObject<boolean>;
  composerRef: RefObject<HTMLDivElement | null>;
};

export default function BashCompletePlugin({ typeaheadOpenRef, composerRef }: Props) {
  const [editor] = useLexicalComposerContext();
  const [items, setItems] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const lastKeyRef = useRef("");
  const indexRef = useRef(0);
  const mineRef = useRef(false);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  // Share the open flag through the ref without clobbering a concurrently open
  // sigil panel: only the flag this plugin raised is lowered on close
  useEffect(() => {
    if (open) {
      mineRef.current = true;
      typeaheadOpenRef.current = true;
    } else if (mineRef.current) {
      mineRef.current = false;
      typeaheadOpenRef.current = false;
    }
  }, [open, typeaheadOpenRef]);

  // Replace the token before the caret with the accepted candidate. The token
  // must live inside the anchor text node (bash lines are plain single-node
  // text; chips never appear), cross-node tokens are left untouched.
  const accept = (item: Item) => {
    editor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
      const anchor = sel.anchor;
      if (anchor.type !== "text") return;
      const node: TextNode = anchor.getNode();
      if (!$isTextNode(node)) return;
      const text = node.getTextContent();
      const offset = anchor.offset;
      const match = text.slice(0, offset).match(/(\S*)$/);
      const token = match ? match[1] : "";
      if (!token) return;
      // The first token carries the ! mode sigil (candidate labels do not);
      // re-attach it so accepting keeps the line in bash mode
      const label = (token.startsWith("!") ? "!" : "") + item.label;
      const replacement = $createTextNode(text.slice(0, offset - token.length) + label + text.slice(offset));
      node.replace(replacement);
      const caret = offset - token.length + label.length;
      replacement.select(caret, caret);
    });
    setOpen(false);
  };

  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  // Debounced request on every editor update while in bash mode
  useEffect(
    () =>
      editor.registerUpdateListener(() => {
        const { text, caret } = editor.read(() => $flattenWithCaret());
        clearTimeout(timerRef.current);
        if (!isBashMode(text) || caret == null) {
          lastKeyRef.current = "";
          setOpen(false);
          return;
        }
        const key = `${text}|${caret}`;
        if (key === lastKeyRef.current) return;
        lastKeyRef.current = key;
        timerRef.current = window.setTimeout(() => {
          const st = useAppStore.getState();
          const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
          const reqId = st.bashCompleteSeq + 1;
          useAppStore.setState({ bashCompleteSeq: reqId });
          reqRef.current = reqId;
          st.send({
            type: "bash_complete",
            reqId,
            text,
            caret,
            ...(sess ? { sessionId: sess.sessionId } : { cwd: st.newSessionProject || undefined }),
          });
        }, DEBOUNCE_MS);
      }),
    [editor],
  );

  // Reply landing: only the result matching the latest request opens the card
  useEffect(
    () =>
      useAppStore.subscribe((s, prev) => {
        if (s.bashCompleteResult === prev.bashCompleteResult) return;
        const r = s.bashCompleteResult;
        if (!r || r.reqId !== reqRef.current) return;
        setItems(r.items);
        setIndex(0);
        setOpen(r.items.length > 0);
      }),
    [],
  );

  // Card anchoring (same recipe as the sigil palette; re-run as the list grows)
  useLayoutEffect(() => {
    if (open) placePaletteCard(composerRef.current, menuRef.current, 2.2);
  }, [composerRef, open, items.length]);

  // Keyboard: high priority so the send/blur handlers in ComposerPlugin yield
  useEffect(() => {
    if (!open || items.length === 0) return;
    const move = (delta: number) => {
      setIndex((i) => (i + delta + items.length) % items.length);
    };
    return mergeRegister(
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (ev) => {
          ev.preventDefault();
          move(1);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (ev) => {
          ev.preventDefault();
          move(-1);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (ev) => {
          ev.preventDefault();
          acceptRef.current(items[indexRef.current]);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (ev) => {
          if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
          }
          acceptRef.current(items[indexRef.current]);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, open, items]);

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (!open) return false;
          setOpen(false);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, open],
  );

  // Cleanup on unmount (session switch remounts the editor)
  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      if (mineRef.current) typeaheadOpenRef.current = false;
    },
    [typeaheadOpenRef],
  );

  if (!open || items.length === 0) return null;
  return (
    <div className="menu palette open bash" ref={menuRef}>
      {items.map((it, i) => (
        <button
          key={it.label}
          type="button"
          className={"mi" + (i === index ? " on" : "")}
          onMouseDown={(e) => {
            e.preventDefault(); // keep editor focus; accept rewrites the line
            accept(it);
          }}
          onMouseEnter={() => setIndex(i)}
        >
          <span>{it.label.trimEnd()}</span>
          <span className="sub">{it.kind}</span>
        </button>
      ))}
    </div>
  );
}
