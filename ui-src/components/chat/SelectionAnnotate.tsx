// Floating comment action over assistant output: selecting text in a message
// bubble (or in a subagent's result block) shows a dark pill next to the
// selection; it opens a small card with the quoted excerpt and an optional
// comment. Submitting stores a pending note (store/annotations) that the
// composer renders as a chip and the send path prepends to the prompt.
// The file / diff panes trigger the same pill and the same card; their note
// additionally carries the absolute path and line span of the text, which is
// the only difference (the pane tags its rows with data-annot-file / data-line).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { isImeKey } from "../../keys";
import { placeMenu } from "../../shell";
import { addAnnotation } from "../../store/annotations";
import { useAppStore, effZoom } from "../../store";

// Touch-only clients (phones, tablets — remote viewers included) select through
// long-press and drag handles: mouseup / keyup never fire reliably there and the pill
// fights the handles, so annotating stays a pointer-device feature.
const coarseMql = window.matchMedia("(pointer: coarse)");

// Only assistant output is annotatable: message bubbles (streaming tail included)
// and the subagent detail's submitted report (HubDetail tags its result box).
const ANNOTATABLE = "#stream .msg.assistant, .hub-box[data-annot-agent]";
// Code panes (file tab, git / run diff) mark their scroller with the absolute
// path and every row with its displayed line number.
const CODE_ROOT = "[data-annot-file]";
const GAP = 8;
const EDGE = 8;

interface Target {
  text: string;
  agent?: string;
  file?: string;
  lines?: string;
  /** Live range: the pill follows its text when the stream scrolls. */
  range: Range;
}

// Focusing the textarea collapses the document selection, so the anchored text would lose
// its highlight while the card is open. The CSS Custom Highlight API keeps drawing it
// independently of the selection (WebKit 17.2+; absent registries are a silent no-op).
const ANCHOR_HIGHLIGHT = "annot-anchor";
function setAnchorHighlight(range: Range | null): void {
  // lib.dom has no CSS Custom Highlight API types yet; this one cast is that gap.
  const g = globalThis as unknown as {
    Highlight?: new (r: Range) => object;
    CSS?: { highlights?: Map<string, object> };
  };
  const registry = g.CSS?.highlights;
  const Ctor = g.Highlight;
  if (!registry || !Ctor) return;
  if (range) registry.set(ANCHOR_HIGHLIGHT, new Ctor(range.cloneRange()));
  else registry.delete(ANCHOR_HIGHLIGHT);
}

function annotatableRoot(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el || !el.isConnected) return null;
  if (el.closest("input, textarea, [contenteditable]")) return null;
  return el.closest<HTMLElement>(ANNOTATABLE);
}

function codeRoot(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el || !el.isConnected) return null;
  return el.closest<HTMLElement>(CODE_ROOT);
}

function lineAt(node: Node | null): number | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const row = el?.closest<HTMLElement>("[data-line]");
  const n = row ? Number(row.dataset.line) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Rows without a number (a diff's removed side, a hole in a read range) fall back
// to whichever end does carry one; no number at all leaves the span out.
function lineSpan(range: Range): string | undefined {
  const a = lineAt(range.startContainer);
  const b = lineAt(range.endContainer);
  if (a == null) return b == null ? undefined : String(b);
  return b == null || b === a ? String(a) : `${a}-${b}`;
}

function readTarget(): Target | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  // Both ends must sit in the same annotatable body: a cross-bubble selection has
  // no single owner, so it offers nothing.
  const root = annotatableRoot(sel.anchorNode);
  if (root && root === annotatableRoot(sel.focusNode))
    return { text, agent: root.dataset.annotAgent || undefined, range };
  const pane = codeRoot(sel.anchorNode);
  if (!pane || pane !== codeRoot(sel.focusNode)) return null;
  const file = pane.dataset.annotFile;
  if (!file) return null;
  return { text, file, lines: lineSpan(range), range };
}

export default function SelectionAnnotate() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [touch, setTouch] = useState(coarseMql.matches);
  const targetRef = useRef<Target | null>(null);
  const editingRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  targetRef.current = target;
  editingRef.current = editing;

  // A tablet gaining or losing a mouse flips the pointer media query.
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setTouch(e.matches);
    coarseMql.addEventListener("change", on);
    return () => coarseMql.removeEventListener("change", on);
  }, []);

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
    // The tail points at the selection: on the card's bottom edge when the card sits
    // above the text, on its top edge otherwise. Measured in visual px, stored in layout
    // px (the card lives under #center's zoom), clamped so it never leaves the card.
    const z = effZoom();
    const tail = Math.min(Math.max((r.left + r.width / 2 - left) / z, 12), b.width / z - 12);
    el.dataset.side = above >= EDGE ? "top" : "bottom";
    el.style.setProperty("--annot-tail", `${tail}px`);
    placeMenu(el, left, Math.max(top, EDGE));
  }, []);

  // Selection tracking: selectionchange covers drag/keyboard selection, mouseup and
  // keyup catch the end of a gesture, and the capture scroll listener keeps the pill
  // on its text. While the comment box owns the focus, selection changes are the box's
  // own caret and must not wipe the anchored card.
  useEffect(() => {
    if (touch) return;
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
  }, [place, touch]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  // Switching sessions replaces the stream under the card: its selection no longer
  // exists in the visible transcript, so the card (and the pill) goes with it.
  const activePath = useAppStore((st) => st.activePath);
  const pathRef = useRef(activePath);
  useEffect(() => {
    if (pathRef.current === activePath) return;
    pathRef.current = activePath;
    setEditing(false);
    setComment("");
    setTarget(null);
    setAnchorHighlight(null);
  }, [activePath]);

  const close = useCallback(() => {
    setEditing(false);
    setComment("");
    setTarget(null);
    setAnchorHighlight(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // A press anywhere outside the card cancels it: the selection it edits is gone once the
  // user moves on. Presses inside the card (textarea drag, buttons) are its own.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const el = boxRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [editing, close]);

  // Esc closes the card before any global abort route sees it. An IME Esc (isImeKey) only
  // cancels the candidate window: swallow it, keep the card.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (isImeKey(e)) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, close]);

  useLayoutEffect(() => {
    if (target) place();
  }, [target, editing, place]);

  const submit = () => {
    const tg = targetRef.current;
    if (!tg) return;
    addAnnotation({
      text: tg.text,
      comment: comment.trim(),
      ...(tg.agent ? { agent: tg.agent } : {}),
      ...(tg.file ? { file: tg.file, lines: tg.lines } : {}),
    });
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

  if (touch) return null;
  return createPortal(
    editing && target ? (
      <div className="annot-card" ref={boxRef}>
        <div className="annot-quote-row">
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
          <span className="annot-foot-hint">{t("composer.annotateHint")}</span>
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
        <button type="button" className="annot-fab-act" onClick={() => { setAnchorHighlight(target.range); setEditing(true); }}>
          <Icon name="messageSquareText" />
          {t("composer.annotateAction")}
        </button>
      </div>
    ) : null,
    document.body,
  );
}
