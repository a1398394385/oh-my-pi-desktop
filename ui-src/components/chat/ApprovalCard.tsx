// Approval card (ask/confirm/editor/plan dialogs): same as ZCodium's PermissionDialog —
// an "awaiting confirmation" title + question body + numbered option rows + bottom
// keyboard hint and confirm button.
// Interaction mirrors ZCodium: single click selects, second click / Enter / the confirm
// button answers, number keys answer directly, up/down / Tab move the selection;
// with editable (editor dialogs) the submit row embeds an inline input (ZCodium feedback
// row styling; empty input is treated as cancel).
// The plan variant adds an execution-model tier slider above the options and may
// disable the keep-context row once the context is nearly full (both host-driven:
// slider/disabledIndices ride the frame, the picked index rides back on the answer).
// After answering, the answer freezes (chosen/dim/disabled); local clicks take effect
// immediately.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";
import type { AskQuestion } from "../../types/session";

// Stable option ids sent by host-built approval frames (editor/plan variants).
// Labels come from i18n so the wire stays language-independent; SDK-generated
// options (select/confirm variants) pass through as plain display text.
const OPTION_LABEL_KEYS: Record<string, string> = {
  submit: "chat.approvalSubmit",
  cancel: "chat.approvalCancel",
  "plan:execute": "chat.planApprove",
  "plan:compact": "chat.planApproveCompact",
  "plan:keep": "chat.planApproveKeep",
  "plan:refine": "chat.planRefine",
  "plan:save-quit": "chat.planSaveQuit",
};
const optionLabel = (opt: string, keepTokens?: { tokens: number; contextWindow: number }): string => {
  // The keep-context row carries live token counts; the host sends raw numbers so
  // the formatted label stays localizable. A zero window (no model resolved)
  // falls back to the bare label rather than rendering "/ 0".
  if (opt === "plan:keep" && keepTokens && keepTokens.contextWindow > 0) {
    return t("chat.planApproveKeepCounted", {
      count: formatTokens(keepTokens.tokens),
      window: formatTokens(keepTokens.contextWindow),
    });
  }
  const key = OPTION_LABEL_KEYS[opt];
  return key ? t(key) : opt;
};

/** Token count the way the plan review shows it (44k / 1m). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

// Approval request entry (built by the store from host approval frames): answer/prefill
// are written back in place by this card
interface ApprovalItem {
  title?: string;
  options: string[];
  keepContextTokens?: { tokens: number; contextWindow: number };
  disabledIndices?: number[];
  slider?: { caption: string; index: number; segments: { label: string; detail: string }[] };
  editable?: boolean;
  editableIndex?: number;
  requestId: string;
  answer?: string | null;
  prefill?: string;
  // Ask-dialog variant only (18.5 uiCtx.askDialog): the merged multi-question
  // form rendered as radio/checkbox rows with one submit for all answers
  questions?: AskQuestion[];
}

export default function ApprovalCard({ item }: { item: ApprovalItem }) {
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0); // the confirm button reads the latest option without waiting for React's next render
  const select = (i: number) => {
    selectedRef.current = i;
    setSelected(i);
  };
  const [chosen, setChosen] = useState(-1); // answered row index (frozen locally; remount falls back to matching against answer)
  // The picked execution tier (plan variant). The host parked it on `default`;
  // left/right (or clicking a segment) moves it, and the index rides back on
  // the answer so approval can apply the role model.
  const [sliderIndex, setSliderIndex] = useState(item.slider?.index ?? 0);
  const sliderIndexRef = useRef(sliderIndex);
  const setTier = (i: number) => {
    sliderIndexRef.current = i;
    setSliderIndex(i);
  };
  const listRef = useRef<HTMLDivElement | null>(null);
  const inpRef = useRef<HTMLInputElement | null>(null);
  const answered = item.answer !== null;
  const n = item.options.length;
  // editable protocol: editableIndex points at the inline-input row (host
  // always sends it with the frame); located by index, never by display text.
  const inpIdx = item.editable ? (item.editableIndex ?? -1) : -1;
  // Plan rows the operator may not pick (context nearly full).
  const disabled = new Set(item.disabledIndices ?? []);

  // ---- Ask-dialog variant (questions[]): merged radio/checkbox form ----
  const askQs = (item.questions ?? []).filter((q): q is AskQuestion => !!q && Array.isArray(q.options) && q.options.length > 0);
  // One selection set per question (single = exactly one index, defaulted to
  // the recommended row; multi = any subset, empty by default). Mirrors the
  // base's timeout auto-selection semantics.
  const [picks, setPicks] = useState<number[][]>(() =>
    askQs.map((q) => (q.multi ? [] : [q.recommended !== undefined && q.recommended >= 0 ? q.recommended : 0])),
  );
  const picksRef = useRef(picks);
  const togglePick = (qi: number, oi: number, multi: boolean | undefined) => {
    if (answered) return;
    setPicks((prev) => {
      const next = prev.slice();
      next[qi] = multi ? (next[qi]?.includes(oi) ? next[qi].filter((j) => j !== oi) : [...(next[qi] ?? []), oi]) : [oi];
      picksRef.current = next;
      return next;
    });
  };
  // One approval_response carrying every answer: answer = JSON of the base's
  // ExtensionAskDialogSubmitResult (host parses; a parse failure counts as cancel)
  const submitAll = () => {
    if (item.answer !== null) return;
    const results = askQs.map((q, i) => {
      const labels = (q.options ?? []).map((o) => o.label ?? "");
      const picked = (picksRef.current[i] ?? []).filter((j) => j < labels.length && labels[j]);
      return {
        id: q.id ?? String(i),
        question: q.question ?? "",
        options: labels,
        multi: !!q.multi,
        selectedOptions: picked.map((j) => labels[j]),
      };
    });
    const answer = JSON.stringify({ kind: "submit", results });
    useAppStore.setState((st) => {
      for (const [p, sess] of st.openSessions) {
        const list = sess.pendingApprovals;
        const j = list?.findIndex((r) => r.requestId === item.requestId) ?? -1;
        if (!list || j < 0) continue;
        const pendingApprovals = list.slice();
        pendingApprovals[j] = { ...list[j], answer };
        return { openSessions: new Map(st.openSessions).set(p, { ...sess, pendingApprovals }) };
      }
      return {};
    });
    useAppStore.getState().send({ type: "approval_response", requestId: item.requestId, answer });
  };

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
        pendingApprovals[j] = { ...list[j], answer: answer ?? opt, sliderIndex: sliderIndexRef.current };
        return { openSessions: new Map(st.openSessions).set(p, { ...sess, pendingApprovals }) };
      }
      return {};
    });
    useAppStore.getState().send({
      type: "approval_response",
      requestId: item.requestId,
      answer,
      ...(item.slider ? { sliderIndex: sliderIndexRef.current } : {}),
    });
  };

  // Select and focus row i (the editable row focuses its inline input)
  const focusRow = (i: number) => {
    select(i);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    (row?.querySelector("input") ?? row)?.focus({ preventScroll: true });
  };
  // Step d rows, skipping disabled ones (the plan keep row is often disabled).
  const move = (from: number, d: number) => {
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + d + n) % n;
      if (!disabled.has(i)) {
        focusRow(i);
        return;
      }
    }
  };

  // Row keyboard: number keys answer directly; up/down / left/right / Tab move; Enter
  // answers this row (mirroring ZCodium's PermissionDialog). A number key on a
  // disabled row is ignored rather than answering it.
  const onRowKey = (i: number) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key >= "1" && e.key <= String(n)) {
      e.preventDefault();
      const target = Number(e.key) - 1;
      if (!disabled.has(target)) choose(target);
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
      {/* Execution-model tier slider (plan variant): pick which configured role
          model runs the approved plan. Segments are click targets, so the hover
          highlight is an affordance here, not decoration. */}
      {item.slider && !answered && (
        <div className="approval-slider">
          <span className="approval-slider-cap">{item.slider.caption}</span>
          <div className="approval-slider-track" role="radiogroup" aria-label={item.slider.caption}>
            {item.slider.segments.map((seg, i) => (
              <button
                key={seg.label}
                type="button"
                role="radio"
                aria-checked={i === sliderIndex}
                className={"approval-seg" + (i === sliderIndex ? " on" : "")}
                onClick={() => setTier(i)}
                title={seg.detail}
              >
                {seg.label}
              </button>
            ))}
          </div>
          <span className="approval-slider-detail">{item.slider.segments[sliderIndex]?.detail}</span>
        </div>
      )}
      {askQs.length > 0 ? (
        <div className="ask-form" role="form">
          {askQs.map((q, qi) => (
            <div className="ask-q" key={q.id ?? qi}>
              <div className="ask-q-t">
                {qi + 1}. {q.header ? <b>{q.header}</b> : null}
                {q.question}
              </div>
              <div className="approval-list" role={q.multi ? "group" : "radiogroup"} aria-label={q.question}>
                {(q.options ?? []).map((o, oi) => {
                  const on = (picks[qi] ?? []).includes(oi);
                  return (
                    <label key={oi} className={"approval-opt ask-opt" + (on ? " selected" : "") + (answered ? " dim" : "")}>
                      <input
                        type={q.multi ? "checkbox" : "radio"}
                        name={`${item.requestId}:${qi}`}
                        checked={on}
                        disabled={answered}
                        onChange={() => togglePick(qi, oi, q.multi)}
                      />
                      <span className="approval-label">
                        {o.label}
                        {oi === q.recommended ? " ★" : ""}
                        {o.description ? <span className="ask-desc">{o.description}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="approval-list" role="listbox" aria-label={t("chat.confirmOptions")} ref={listRef}>
        {item.options.map((opt, i) => {
          const num = answered && i === frozenChosen ? "✓" : `${i + 1}.`;
          const isDisabled = disabled.has(i);
          const cls =
            "approval-opt" +
            (i === inpIdx ? " has-input" : "") +
            (isDisabled ? " disabled" : "") +
            (!answered && !isDisabled && i === selected ? " selected" : "") +
            (answered ? (i === frozenChosen ? " chosen selected" : " dim") : "");
          const sel = !answered && !isDisabled && i === selected;
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
              aria-disabled={isDisabled || undefined}
              title={isDisabled ? t("chat.planDisabled") : undefined}
              tabIndex={sel ? 0 : -1}
              disabled={answered || isDisabled}
              onFocus={() => !answered && select(i)}
              onKeyDown={onRowKey(i)}
              onClick={() => (sel ? choose(i) : focusRow(i))}
            >
              <span className="approval-num">{num}</span>
              <span className="approval-label">{optionLabel(opt, item.keepContextTokens)}</span>
            </button>
          );
        })}
      </div>
      )}
      {!answered &&
        (askQs.length > 0 ? (
          <div className="approval-foot">
            <span className="approval-hint">
              <Icon name="info" size={15} />
              {t("compExt.askMultiHint")}
            </span>
            <button type="button" className="approval-confirm" onClick={submitAll}>
              {t("compExt.askSubmitAll")}
            </button>
          </div>
        ) : (
          <div className="approval-foot">
            <span className="approval-hint">
              <Icon name="info" size={15} />
              {t("chat.approvalHint")}
            </span>
            <button type="button" className="approval-confirm" onClick={() => choose(selectedRef.current)}>
              {t("common.confirm")}
            </button>
          </div>
        ))}
    </div>
  );
}
