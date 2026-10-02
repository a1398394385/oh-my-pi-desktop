// Approval card (ask/confirm/editor dialogs): same as ZCodium's PermissionDialog —
// an "awaiting confirmation" title + question body + numbered option rows + bottom
// keyboard hint and confirm button.
// Interaction mirrors ZCodium: single click selects, second click / Enter / the confirm
// button answers, number keys answer directly, up/down / Tab move the selection;
// with editable (editor dialogs) the submit row embeds an inline input (ZCodium feedback
// row styling; empty input is treated as cancel).
// After answering, the answer freezes (chosen/dim/disabled); local clicks take effect
// immediately.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";

// Stable option ids sent by host-built approval frames (editor/plan variants).
// Labels come from i18n so the wire stays language-independent; SDK-generated
// options (select/confirm variants) pass through as plain display text.
const OPTION_LABEL_KEYS: Record<string, string> = {
  submit: "chat.approvalSubmit",
  cancel: "chat.approvalCancel",
  approve: "chat.planApprove",
  refine: "chat.planRefine",
};
const optionLabel = (opt: string): string => {
  const key = OPTION_LABEL_KEYS[opt];
  return key ? t(key) : opt;
};

// Approval request entry (built by the store from host approval frames): answer/prefill
// are written back in place by this card
interface ApprovalItem {
  title?: string;
  options: string[];
  editable?: boolean;
  editableIndex?: number;
  requestId: string;
  answer?: string | null;
  prefill?: string;
}

export default function ApprovalCard({ item }: { item: ApprovalItem }) {
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0); // the confirm button reads the latest option without waiting for React's next render
  const select = (i: number) => {
    selectedRef.current = i;
    setSelected(i);
  };
  const [chosen, setChosen] = useState(-1); // answered row index (frozen locally; remount falls back to matching against answer)
  const listRef = useRef<HTMLDivElement | null>(null);
  const inpRef = useRef<HTMLInputElement | null>(null);
  const answered = item.answer !== null;
  const n = item.options.length;
  // editable protocol: editableIndex points at the inline-input row (host
  // always sends it with the frame); located by index, never by display text.
  const inpIdx = item.editable ? (item.editableIndex ?? -1) : -1;

  const choose = (i: number) => {
    if (item.answer !== null) return;
    const opt = item.options[i];
    let answer: string | null | undefined = opt;
    if (item.editable) {
      if (i === inpIdx) answer = inpRef.current!.value.trim() || null; // empty input is treated as cancel (the editable row is guaranteed mounted)
      else answer = undefined;
    }
    setChosen(i);
    // Write the answer back to the pending approval entry: locate by requestId, copy the
    // array and replace the element (both the selector and _v subscribers pick it up)
    useAppStore.setState((st) => {
      for (const [p, sess] of st.openSessions) {
        const list = sess.pendingApprovals;
        const j = list?.findIndex((r) => r.requestId === item.requestId) ?? -1;
        if (!list || j < 0) continue;
        const pendingApprovals = list.slice();
        pendingApprovals[j] = { ...list[j], answer: answer ?? opt };
        return { openSessions: new Map(st.openSessions).set(p, { ...sess, pendingApprovals }) };
      }
      return {};
    });
    useAppStore.getState().send({ type: "approval_response", requestId: item.requestId, answer });
  };

  // Select and focus row i (the editable row focuses its inline input)
  const focusRow = (i: number) => {
    select(i);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    (row?.querySelector("input") ?? row)?.focus({ preventScroll: true });
  };
  const move = (from: number, d: number) => focusRow((from + d + n) % n);

  // Row keyboard: number keys answer directly; up/down / left/right / Tab move; Enter
  // answers this row (mirroring ZCodium's PermissionDialog)
  const onRowKey = (i: number) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key >= "1" && e.key <= String(n)) {
      e.preventDefault();
      choose(Number(e.key) - 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(i, -1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(i);
    }
  };

  // Inline input keyboard (same as ZCodium's feedback row): Enter submits, up/down / Tab
  // change rows, Esc blurs;
  // stopPropagation — key presses on the input row must not trigger global shortcuts (Esc
  // interrupting generation, etc.)
  const onInpKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(inpIdx);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(inpIdx, -1);
    } else if (e.key === "ArrowDown" || e.key === "Tab") {
      e.preventDefault();
      move(inpIdx, 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      inpRef.current?.blur();
    }
  };

  // Focus the selected row on mount (number / Enter shortcuts usable at once); do not steal
  // an existing input focus (the user may be typing)
  useEffect(() => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)) return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    (row?.querySelector("input") ?? row)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frozenChosen = answered
    ? chosen >= 0
      ? chosen
      : typeof item.answer === "string"
        ? item.options.indexOf(item.answer)
        : -1
    : -1;

  return (
    <div className="approval-card">
      <div className="approval-head">{t("chat.awaitingConfirm")}</div>
      <div className="approval-title">{item.title}</div>
      <div className="approval-list" role="listbox" aria-label={t("chat.confirmOptions")} ref={listRef}>
        {item.options.map((opt, i) => {
          const num = answered && i === frozenChosen ? "✓" : `${i + 1}.`;
          const cls =
            "approval-opt" +
            (i === inpIdx ? " has-input" : "") +
            (!answered && i === selected ? " selected" : "") +
            (answered ? (i === frozenChosen ? " chosen selected" : " dim") : "");
          const sel = !answered && i === selected;
          if (i === inpIdx) {
            // Uncontrolled input: typing only writes back item.prefill (preserving entered
            // content across full redraws), without triggering a re-render
            return (
              <div
                key={opt}
                data-idx={i}
                className={cls}
                role="option"
                aria-selected={sel || (answered && i === frozenChosen)}
                onFocus={() => !answered && select(i)}
                onClick={(e) => {
                  if (e.target !== inpRef.current) inpRef.current?.focus();
                }}
              >
                <span className="approval-num">{num}</span>
                <input
                  type="text"
                  className="approval-inp"
                  placeholder={t("chat.typeToSubmit")}
                  defaultValue={item.prefill || ""}
                  disabled={answered}
                  ref={inpRef}
                  onChange={(e) => { item.prefill = e.target.value; }}
                  onKeyDown={onInpKey}
                />
              </div>
            );
          }
          return (
            <button
              key={opt}
              type="button"
              data-idx={i}
              className={cls}
              role="option"
              aria-selected={sel || (answered && i === frozenChosen)}
              tabIndex={sel ? 0 : -1}
              disabled={answered}
              onFocus={() => !answered && select(i)}
              onKeyDown={onRowKey(i)}
              onClick={() => (sel ? choose(i) : focusRow(i))}
            >
              <span className="approval-num">{num}</span>
              <span className="approval-label">{optionLabel(opt)}</span>
            </button>
          );
        })}
      </div>
      {!answered && (
        <div className="approval-foot">
          <span className="approval-hint">
            <Icon name="info" size={15} />
            {t("chat.approvalHint")}
          </span>
          <button type="button" className="approval-confirm" onClick={() => choose(selectedRef.current)}>
            {t("common.confirm")}
          </button>
        </div>
      )}
    </div>
  );
}
