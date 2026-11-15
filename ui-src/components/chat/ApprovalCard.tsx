// Approval card (confirm/editor/input/plan/select dialogs): same as ZCodium's
// PermissionDialog —
// an "awaiting confirmation" title + question body + numbered option rows + bottom
// keyboard hint and confirm button.
// Interaction mirrors ZCodium: single click selects, second click / Enter / the confirm
// button answers, number keys answer directly, up/down / Tab move the selection;
// with editable (editor dialogs) the submit row embeds an inline input (ZCodium feedback
// row styling; empty input is treated as cancel).
// While pending the card substitutes the composer (the App dock hides it), so a
// document-capture listener owns up/down/Enter from anywhere in the session
// view — no click on the card needed to arm the keys first.
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
import type { PlanOutput } from "../../types/session";

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
  // input variant's grey hint (placeholder), never a submitted value
  placeholder?: string;
  // Ask round extras (18.20 select): cursor row, marker style on the leading
  // `markableCount` rows, and which rows are already checked
  initialIndex?: number;
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: readonly number[];
  markableCount?: number;
  requestId: string;
  // Plan variant: raw plan text + title + on-disk path, rendered as a scrollable
  // body between the title and the options
  plan?: PlanOutput;
  answer?: string | null;
  prefill?: string;
}

export default function ApprovalCard({ item }: { item: ApprovalItem }) {
  // Ask rounds (18.20) open on the row the base asked for (initialIndex): the
  // recommended option, or the next unchecked row during a multi-select round.
  const [selected, setSelected] = useState(item.initialIndex ?? 0);
  const selectedRef = useRef(item.initialIndex ?? 0); // the confirm button reads the latest option without waiting for React's next render
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
  const cardRef = useRef<HTMLElement | null>(null); // card root: visibility + containment checks for the global key capture
  // Collapsed to a slim bar while the user reads the agent output above; the
  // ref (not state) guards the global key capture so arrows/Enter pass through
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  const setCardCollapsed = (v: boolean) => {
    collapsedRef.current = v;
    setCollapsed(v);
  };
  const answered = item.answer !== null;
  const n = item.options.length;
  // editable protocol: editableIndex points at the inline-input row (host
  // always sends it with the frame); located by index, never by display text.
  const inpIdx = item.editable ? (item.editableIndex ?? -1) : -1;
  // Plan rows the operator may not pick (context nearly full).
  const disabled = new Set(item.disabledIndices ?? []);

  // Write the answer back to the pending approval entry (freeze) and reply to the host
  const writeAnswer = (answer: string) => {
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
  // an existing input focus (the user may be typing).
  useEffect(() => {
    const ae = document.activeElement;
    // Skip only a *visible* focused editor: the composer hides the moment the
    // approval dock takes over, but its Lexical root can still report as
    // activeElement until layout settles — that must not block the row focus
    if (
      ae &&
      ae.getClientRects().length > 0 &&
      (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)
    )
      return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    (row?.querySelector("input") ?? row)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ---- Global key capture: the pending card substitutes the composer ----
  // The dock hides the composer while an approval is pending (App.tsx), so the
  // card is the page's input surface: up/down step its rows and Enter answers
  // from anywhere in the session view. Registered on document capture, so it
  // also serves in-card keydowns; it yields to (a) editable surfaces outside
  // the card (sidebar search / right-panel terminal & browser / popup inputs),
  // (b) the settings page, modal masks and the image lightbox, (c) focused
  // buttons (Enter keeps native activation — Cancel stays Cancel), and (d) the
  // tree page's arrow cursor (its window-capture listener runs before this
  // one). Landing on a single-choice option row also checks it: the checked
  // plate is the row highlight, so arrows alone pick the answer; multi rows
  // keep Space-to-check semantics.
  useEffect(() => {
    if (answered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // IME composition owns every key
      if (collapsedRef.current) return; // collapsed: the card yields the keyboard to the page
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Enter" && !/^[1-9]$/.test(e.key)) return;
      const root = cardRef.current;
      if (!root || root.getClientRects().length === 0) return; // hidden = not the active surface
      if (useAppStore.getState().settingsOpen || document.querySelector(".lp-mask,[data-modal]")) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (!root.contains(target) && target !== document.body && target !== document.documentElement) {
        // Outside the card only the bare session page counts (#main message
        // flow); focusables elsewhere keep their own arrow semantics
        const main = document.getElementById("main");
        if (!main || !main.contains(target)) return;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLElement).isContentEditable) return;
      }
      // Digit keys pick an option row directly (1..n); the list stays the only
      // multi-state surface now that ask rounds carry their own form card.
      if (/^[1-9]$/.test(e.key)) {
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLElement).isContentEditable) return;
        const k = Number(e.key);
        if (k > n) return;
        e.preventDefault();
        e.stopPropagation();
        choose(k - 1);
        return;
      }
      if (e.key === "Enter") {
        if (target.closest("button")) return; // native activation: Cancel / slider segments / option rows
        e.preventDefault();
        e.stopPropagation();
        const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-idx]"));
        const i = rows.findIndex((r) => r.contains(document.activeElement ?? target));
        choose(i >= 0 ? i : selectedRef.current);
        return;
      }
      const d = e.key === "ArrowDown" ? 1 : -1;
      {
        // Option listbox: the same stepping the in-card rows use (disabled rows skipped)
        const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-idx]"));
        if (rows.length === 0) return;
        let idx = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
        if (idx < 0) idx = selectedRef.current;
        for (let step = 0; step < rows.length; step++) {
          idx = (idx + d + rows.length) % rows.length;
          const row = rows[idx];
          if (!row.classList.contains("disabled") && !(row instanceof HTMLButtonElement && row.disabled)) {
            e.preventDefault();
            e.stopPropagation();
            focusRow(idx);
            return;
          }
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // The captured closures read refs / DOM / functional state only, and the
    // card remounts per requestId, so [answered] is the sole lifecycle edge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);

  const frozenChosen = answered
    ? chosen >= 0
      ? chosen
      : typeof item.answer === "string"
        ? item.options.indexOf(item.answer)
        : -1
    : -1;

  // Collapsed: a slim bar in place of the card (the pending question rides as a
  // one-line summary); clicking anywhere on it restores the full card
  if (collapsed) {
    const minLabel = item.title?.trim() || "";
    return (
      <button
        type="button"
        className="approval-min"
        ref={(el) => { cardRef.current = el; }}
        title={t("chat.approvalExpand")}
        onClick={() => setCardCollapsed(false)}
      >
        <Icon name="comment" size={14} />
        <span className="approval-min-tt">{t("chat.awaitingConfirm")}</span>
        {minLabel ? <span className="approval-min-q">{minLabel}</span> : null}
        <Icon name="chevronUp" size={14} />
      </button>
    );
  }

  return (
    <div className="approval-card" ref={(el) => { cardRef.current = el; }}>
      <div className="approval-head">
        {t("chat.awaitingConfirm")}
        {!answered && (
          <button
            type="button"
            className="approval-collapse-btn"
            title={t("chat.approvalCollapse")}
            onClick={() => setCardCollapsed(true)}
          >
            <Icon name="chevronDown" size={14} />
          </button>
        )}
      </div>
      <div className="approval-title">{item.title}</div>
      {/* Plan-proposal body: the raw plan text between the title and the options.
          Content was captured by the host before the proposal turn aborted, so it
          is complete and independent of the local:// file handle. */}
      {item.plan && (
        <div className="approval-plan">
          <pre>{item.plan.content}</pre>
        </div>
      )}
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
      <div className="approval-list" role="listbox" aria-label={t("chat.confirmOptions")} ref={listRef}>
        {item.options.map((opt, i) => {
          // Ask rounds mark the leading `markableCount` rows with a radio/checkbox
          // glyph instead of the digit: the base repeats one select per toggle, so
          // checkedIndices is the only way a checked row stays visible. Trailing
          // rows ("Other"/"Done selecting") keep the plain cursor.
          const markable = item.selectionMarker !== undefined && i < (item.markableCount ?? n);
          const marker = markable
            ? item.selectionMarker === "checkbox"
              ? (item.checkedIndices?.includes(i) ? "☑" : "☐")
              : (i === selected ? "◉" : "○")
            : undefined;
          const num = answered && i === frozenChosen ? "✓" : (marker ?? `${i + 1}.`);
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
                  placeholder={item.placeholder || t("chat.typeToSubmit")}
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
