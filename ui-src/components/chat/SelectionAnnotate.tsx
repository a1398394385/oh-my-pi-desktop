// Floating comment action over assistant output: selecting text in a message
// bubble (or in a subagent's result block) shows a dark pill next to the
// selection; it opens a small card with the quoted excerpt and an optional
// comment. Submitting stores a pending note (store/annotations) that the
// composer renders as a chip and the send path prepends to the prompt.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { placeMenu } from "../../shell";
import { REMOTE } from "../../store/layout";
import { addAnnotation } from "../../store/annotations";

// Only assistant output is annotatable: message bubbles (streaming tail included)
// and the subagent detail's submitted report (HubDetail tags its result box).
const ANNOTATABLE = "#stream .msg.assistant, .hub-box[data-annot-agent]";
const GAP = 8;
const EDGE = 8;

interface Target {
  text: string;
  agent?: string;
  /** Live range: the pill follows its text when the stream scrolls. */
  range: Range;
}

function annotatableRoot(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el || !el.isConnected) return null;
  if (el.closest("input, textarea, [contenteditable]")) return null;
  return el.closest<HTMLElement>(ANNOTATABLE);
}

function readTarget(): Target | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  // Both ends must sit in the same annotatable body: a cross-bubble selection has
  // no single owner, so it offers nothing.
  const root = annotatableRoot(sel.anchorNode);
  if (!root || root !== annotatableRoot(sel.focusNode)) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  return { text, agent: root.dataset.annotAgent || undefined, range: sel.getRangeAt(0) };
}

export default function SelectionAnnotate() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const targetRef = useRef<Target | null>(null);
  const editingRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  targetRef.current = target;
  editingRef.current = editing;

  const place = useCallback(() => {
    const el = boxRef.current;
    const tg = targetRef.current;
    if (!el || !tg || !tg.range.startContainer.isConnected) return;
    const r = tg.range.getBoundingClientRect();
    // A detached range reads as an all-zero rect: the pill must not sit at the CSS
    // origin (0, 0) in that case.
    if (r.width === 0 && r.height === 0) {
      el.style.visibility = "hidden";
      return;
    }
    // A selection scrolled behind the viewport edge has no visible anchor: the pill
    // would clamp to the edge and point at nothing, so it hides until the text returns
    // (the capture scroll listener re-places it).
    const offView = r.bottom < EDGE || r.top > window.innerHeight - EDGE;
    el.style.visibility = offView ? "hidden" : "";
    if (offView) return;
    placeMenu(el, 0, 0); // apply zoom before reading visual sizes
    const b = el.getBoundingClientRect();
    const maxTop = window.innerHeight - b.height - EDGE;
    const left = Math.min(Math.max(r.left + r.width / 2 - b.width / 2, EDGE), window.innerWidth - b.width - EDGE);
    const above = r.top - b.height - GAP;
    // Below-the-selection fallback must stay on screen: r.bottom alone can be negative
    // while the selection is only half visible.
    const top = above >= EDGE ? above : Math.min(r.bottom + GAP, maxTop);
    placeMenu(el, left, Math.max(top, EDGE));
  }, []);

  // Selection tracking: selectionchange covers drag/keyboard selection, mouseup and
  // keyup catch the end of a gesture, and the capture scroll listener keeps the pill
  // on its text. While the comment box owns the focus, selection changes are the box's
  // own caret and must not wipe the anchored card.
  useEffect(() => {
    if (REMOTE) return;
    let raf = 0;
    const refresh = () => {
      raf = 0;
      // The comment box owns the focus: its own caret moves are not a new selection
      if (editingRef.current || (document.activeElement instanceof HTMLElement && document.activeElement.closest(".annot-card")))
        return;
      setTarget(readTarget());
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(refresh);
    };
    const onScroll = () => {
      if (editingRef.current || !targetRef.current) return;
      if (!targetRef.current.range.startContainer.isConnected) {
        setTarget(null);
        return;
      }
      place();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("mouseup", schedule);
    document.addEventListener("keyup", schedule);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("mouseup", schedule);
      document.removeEventListener("keyup", schedule);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [place]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const close = () => {
    setEditing(false);
    setComment("");
    setTarget(null);
    window.getSelection()?.removeAllRanges();
  };

  // Esc closes the card before any global abort route sees it
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing]);

  useLayoutEffect(() => {
    if (target) place();
  }, [target, editing, place]);

  const submit = () => {
    const tg = targetRef.current;
    if (!tg) return;
    addAnnotation({ text: tg.text, comment: comment.trim(), ...(tg.agent ? { agent: tg.agent } : {}) });
    close();
  };

  const onTaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key !== "Enter" || e.shiftKey) return;
    // WebKit marks the candidate-commit Enter keyCode 229 with isComposing already false
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  if (REMOTE) return null;
  return createPortal(
    editing && target ? (
      <div className="annot-card" ref={boxRef}>
        <div className="annot-card-t">{t("composer.annotateTitle")}</div>
        <div className="annot-quote-row">
          <span className="annot-qm">“</span>
          <span className="annot-quote-text">{target.text}</span>
        </div>
        <textarea
          ref={taRef}
          className="annot-ta"
          value={comment}
          placeholder={t("composer.annotatePlaceholder")}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={onTaKeyDown}
        />
        <div className="annot-foot">
          <span className="annot-hint">{t("composer.annotateHint")}</span>
          <span className="sp" />
          <button type="button" className="annot-btn" onClick={close}>
            {t("common.cancel")}
          </button>
          <button type="button" className="annot-btn primary" onClick={submit}>
            {t("composer.annotateAdd")}
          </button>
        </div>
      </div>
    ) : target ? (
      <div className="annot-fab" ref={boxRef} onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className="annot-fab-act" onClick={() => setEditing(true)}>
          <Icon name="comment" size={13} />
          {t("composer.annotateAction")}
        </button>
      </div>
    ) : null,
    document.body,
  );
}
