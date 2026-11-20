// Ask form card (18.20 uiCtx.formDialog): the model writes one HTML `<form>`, the
// host parses it into AskFormWire with the same pi-tui parser the TUI and ACP hosts
// use, and this card draws it whole — every answer submitted at once. Hosts without
// a form surface fall back to per-field select/input rounds, which loses the layout
// and the submitted set; that is why the interface exists at all.
// The submission is answer = JSON of { kind: "submit", data } — anything else (the
// cancel button, a malformed payload) settles the base's ask tool as cancelled.
import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../../Icon";
import { useAppStore } from "../../store/index";
import { t } from "../../i18n";
import type { AskFormBlock, AskFormField, AskFormSpan, AskFormWire, PendingApproval } from "../../types/session";

type FormValue = string | number | string[];

/** Inline spans of a label/paragraph: code/strong/em keep their emphasis. */
function Spans({ spans }: { spans: AskFormSpan[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.style === "code" ? (
          <code key={i}>{span.text}</code>
        ) : span.style === "strong" ? (
          <strong key={i}>{span.text}</strong>
        ) : span.style === "em" ? (
          <em key={i}>{span.text}</em>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </>
  );
}

const plain = (spans: AskFormSpan[]): string => spans.map((s) => s.text).join("");

/** Seconds left on the host's dialog deadline, or 0 without one. The host owns the
 *  timer — it answers with the form's own defaults and pushes approval_resolved —
 *  so this only reports the remainder; the card never submits on its own. */
function useLeftSecs(expiresAt: number | undefined): number {
  const left = () => (expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0);
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    if (!expiresAt) return;
    setSecs(left());
    // 500ms keeps the displayed second within half a step of the host's clock.
    const id = setInterval(() => setSecs(left()), 500);
    return () => clearInterval(id);
  }, [expiresAt]);
  return secs;
}

/** Opening values: preselected options and prefilled text, exactly what the base
 *  submits on timeout (defaultFormData). */
function initialValues(form: AskFormWire): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const field of form.fields) {
    if (!field.name) continue;
    if (field.kind === "text") {
      out[field.name] = field.value;
      continue;
    }
    const checked = field.options.filter((o) => o.checked && !o.disabled);
    if (field.multi) out[field.name] = checked.map((o) => o.value);
    else if (checked[0]) out[field.name] = checked[0].value;
  }
  return out;
}

/** Submitted value of one text field: numbers stay numbers for numeric inputs. */
function textValue(field: Extract<AskFormField, { kind: "text" }>, text: string): FormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") return Number(text);
  return text;
}

export default function AskFormCard({ item }: { item: PendingApproval }) {
  const form = item.form!;
  const answered = item.answer !== null;
  const doneRef = useRef(false);
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(form));
  // Free-text "Other" answers per choice field (base: ChoiceField.other): the row
  // carries its input, so no separate open state is needed.
  const [others, setOthers] = useState<Record<string, string>>({});
  // Question-level notes, one row per single-choice field (the base's option notes
  // flattened): keyed by field name, and only sent when non-empty.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Collapsed: the card steps aside as one summary bar (same behaviour as the older
  // ask dialog), so the agent output above stays readable while the question waits.
  const [collapsed, setCollapsed] = useState(false);
  // Every named field the user must answer: a choice needs one checked option or
  // Other text, a text field needs non-empty text. Optional fields stay optional.
  const required = useMemo(() => form.fields.filter((f) => f.name && f.required), [form]);
  // One page per section that holds a field (the base's tab rule); a section without
  // fields is context and rides along with the page that follows it.
  const pages = useMemo(() => {
    const out: number[][] = [];
    let lead: number[] = [];
    form.sections.forEach((section, si) => {
      if (!section.blocks.some((block) => block.kind === "field")) {
        lead.push(si);
        return;
      }
      out.push([...lead, si]);
      lead = [];
    });
    if (lead.length > 0) {
      if (out.length === 0) out.push(lead);
      else out[out.length - 1]!.push(...lead);
    }
    return out;
  }, [form]);
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(pages.length - 1, 0));
  const formRef = useRef<HTMLFormElement>(null);
  // Deadline countdown (ask.timeout): 0 when the dialog waits for the user, which
  // is also the branch that keeps the old "every answer submits together" hint.
  const leftSecs = useLeftSecs(item.expiresAt);
  // Turning a page swaps content without a reload, so focus must follow it: the
  // keyboard user lands on the new page's first control instead of staying on the
  // pager button (guidance: move focus to the new step's content).
  const turnTo = (next: number) => {
    setPage(next);
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>(".ask-field input, .ask-field select, .ask-field textarea")?.focus();
    });
  };
  // A failed required check names a field, so it has to land on that field's page.
  const pageOfField = useMemo(() => {
    const map = new Map<string, number>();
    pages.forEach((sections, pi) => {
      for (const si of sections) {
        for (const block of form.sections[si]!.blocks) {
          if (block.kind === "field" && block.field.name) map.set(block.field.name, pi);
        }
      }
    });
    return map;
  }, [pages, form]);

  const reply = (answer: string) => {
    if (doneRef.current || item.answer !== null) return;
    doneRef.current = true;
    useAppStore.setState((st) => {
      for (const [path, sess] of st.openSessions) {
        const list = sess.pendingApprovals;
        const j = list?.findIndex((r) => r.requestId === item.requestId) ?? -1;
        if (!list || j < 0) continue;
        const pendingApprovals = list.slice();
        pendingApprovals[j] = { ...list[j], answer };
        return { openSessions: new Map(st.openSessions).set(path, { ...sess, pendingApprovals }) };
      }
      return {};
    });
    // Host contract: approval_response carries the serialized submission; the
    // requestId never leaves the client (the store's dispatch owns the socket).
    void useAppStore.getState().send({ type: "approval_response", requestId: item.requestId, answer });
  };

  const submit = (snapshot?: Record<string, FormValue>) => {
    const pickedNow = snapshot ?? values;
    const missing = required.find((f) => {
      if (f.kind === "text") return String(pickedNow[f.name] ?? "").trim() === "";
      const picked = pickedNow[f.name];
      return Array.isArray(picked) ? picked.length === 0 && !(others[f.name] ?? "").trim() : !picked;
    });
    if (missing) {
      setPage(pageOfField.get(missing.name) ?? 0);
      setError(t("compExt.askFormRequired", { name: missing.kind === "text" ? plain(missing.label) || missing.name : missing.name }));
      return;
    }
    const data: Record<string, FormValue> = {};
    for (const [name, value] of form.hidden) data[name] = value;
    for (const field of form.fields) {
      if (!field.name) continue;
      const value = pickedNow[field.name];
      const other = (others[field.name] ?? "").trim();
      if (field.kind === "text") {
        data[field.name] = textValue(field, String(value ?? ""));
        continue;
      }
      if (field.multi) {
        const picked = Array.isArray(value) ? value : [];
        data[field.name] = other ? [...picked, other] : picked;
        continue;
      }
      // A typed Other answer stands in for the radio's value (base: choiceValue).
      if (other) data[field.name] = other;
      else if (typeof value === "string" && value) data[field.name] = value;
    }
    // Notes ride the same submission: the host fills question/option/value from the
    // form, so only the field name and the typed text leave the card.
    const fieldNotes = form.fields
      .filter((f) => f.kind === "choice" && !f.multi && f.name)
      .map((f) => ({ name: f.name, text: (notes[f.name] ?? "").trim() }))
      .filter((note) => note.text !== "");
    reply(JSON.stringify({ kind: "submit", data, ...(fieldNotes.length ? { notes: fieldNotes } : {}) }));
  };

  // The older ask dialog answered on pick; here a single choice moves on by itself
  // once the page's required answers are complete, and the last page submits.
  const advanceOnPick = (field: Extract<AskFormField, { kind: "choice" }>, value: string) => {
    if (answered || field.multi) return;
    const next: Record<string, FormValue> = { ...values, [field.name]: value };
    const pageFields = (pages[current] ?? []).flatMap((si) =>
      form.sections[si]!.blocks.flatMap((block) => (block.kind === "field" ? [block.field] : [])),
    );
    const complete = pageFields
      .filter((f) => f.name && f.required)
      .every((f) => {
        const picked = next[f.name];
        return Array.isArray(picked) ? picked.length > 0 : !!(picked || (others[f.name] ?? "").trim());
      });
    if (!complete) return;
    if (current < pages.length - 1) turnTo(current + 1);
    else submit(next);
  };

  const pickChoice = (field: Extract<AskFormField, { kind: "choice" }>, value: string) => {
    if (answered) return;
    setError(null);
    // A single-choice pick drops a typed Other (they are exclusive answers)
    setOthers((prev) => (field.multi ? prev : { ...prev, [field.name]: "" }));
    setValues((prev) => {
      if (!field.multi) return { ...prev, [field.name]: value };
      const picked = Array.isArray(prev[field.name]) ? (prev[field.name] as string[]) : [];
      return { ...prev, [field.name]: picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value] };
    });
  };

  const renderField = (field: AskFormField) => {
    if (field.kind === "text") {
      const value = String(values[field.name] ?? "");
      const set = (next: string) => {
        setError(null);
        setValues((prev) => ({ ...prev, [field.name]: next }));
      };
      return (
        <fieldset className="ask-q ask-field" key={field.name}>
          {field.label.length > 0 && (
            <legend className="approval-label">
              <Spans spans={field.label} />
              {field.required && <span className="ask-req">*</span>}
            </legend>
          )}
          {field.multiline ? (
            <textarea
              className="approval-inp ask-form-textarea"
              rows={field.rows}
              value={value}
              placeholder={field.placeholder || undefined}
              disabled={answered}
              onChange={(e) => set(e.target.value)}
            />
          ) : (
            <input
              type={field.type === "number" ? "number" : "text"}
              className="approval-inp"
              value={value}
              placeholder={field.placeholder || undefined}
              min={field.min}
              max={field.max}
              maxLength={field.maxLength}
              disabled={answered}
              onChange={(e) => set(e.target.value)}
            />
          )}
        </fieldset>
      );
    }

    const picked = values[field.name];
    const isOn = (optionValue: string) => (Array.isArray(picked) ? picked.includes(optionValue) : picked === optionValue);
    const enabled = field.options.filter((o) => !o.disabled);
    const supportsOther = field.other && enabled.length >= 2;
    const otherText = others[field.name] ?? "";

    return (
      <fieldset className="ask-q ask-field" key={field.name}>
        {field.label.length > 0 && (
          <legend className="approval-label">
            <Spans spans={field.label} />
            {field.required && <span className="ask-req">*</span>}
          </legend>
        )}
        {field.select ? (
          <select
            className="approval-inp ask-form-select"
            value={typeof picked === "string" ? picked : ""}
            disabled={answered}
            onChange={(e) => pickChoice(field, e.target.value)}
          >
            <option value="" />
            {enabled.map((option) => (
              <option key={option.value} value={option.value}>
                {plain(option.label) || option.value}
              </option>
            ))}
          </select>
        ) : (
          <div className="approval-list">
            {enabled.map((option) => {
              const on = isOn(option.value);
              const commitPick = () => {
                pickChoice(field, option.value);
                advanceOnPick(field, option.value);
              };
              return (
                <label
                  key={option.value}
                  className={"approval-opt ask-opt" + (on ? " selected" : "") + (answered ? " dim" : "")}
                >
                  {/* The row is a <label>: the browser forwards a click to the control,
                      and arrow keys/Space reach it natively. A fresh pick rides
                      `change`; a click on the already-checked radio fires no change,
                      so the click path takes that case — the two never overlap, and a
                      multi-select click always carries its own change (no double toggle). */}
                  <input
                    type={field.multi ? "checkbox" : "radio"}
                    name={`${item.requestId}:${field.name}`}
                    value={option.value}
                    checked={on}
                    disabled={answered}
                    onChange={commitPick}
                    onClick={() => {
                      if (on && !field.multi) commitPick();
                    }}
                    aria-label={plain(option.label)}
                  />
                  <span className="approval-label">
                    <Spans spans={option.label} />
                  </span>
                </label>
              );
            })}
            {supportsOther && (
              // The base draws one `Other: <input>` row: the label picks the answer, the
              // text beside it is that answer, so both live on the same line.
              <div
                className={"approval-opt ask-opt ask-other-opt" + (otherText ? " selected" : "") + (answered ? " dim" : "")}
                onClick={(e) => {
                  if (answered) return;
                  setError(null);
                  if (!field.multi) setValues((prev) => ({ ...prev, [field.name]: "" }));
                  e.currentTarget.querySelector<HTMLInputElement>(".ask-other-inp")?.focus();
                }}
              >
                <label className="ask-other-pick">
                  <input
                    type={field.multi ? "checkbox" : "radio"}
                    name={`${item.requestId}:${field.name}`}
                    checked={otherText !== ""}
                    disabled={answered}
                    onChange={() => {
                      if (answered) return;
                      setError(null);
                      if (!field.multi) setValues((prev) => ({ ...prev, [field.name]: "" }));
                    }}
                    aria-label={t("compExt.askOther")}
                  />
                  <span className="approval-label">{t("compExt.askOther")}</span>
                </label>
                <input
                  type="text"
                  className="ask-other-inp"
                  placeholder={t("compExt.askOtherPlaceholder")}
                  value={otherText}
                  disabled={answered}
                  onChange={(e) => {
                    setError(null);
                    setOthers((prev) => ({ ...prev, [field.name]: e.target.value }));
                  }}
                />
              </div>
            )}
          </div>
        )}
        {/* Question-level note: the base's option notes flattened to one row per
            field. Single choice only — a multi-select has no single option label
            to report, and the host names the picked option from the submitted
            value. Empty text never reaches the submission. */}
        {field.name && !field.multi && !answered && (
          <div className="ask-note">
            <Icon name="messageSquareText" size={14} />
            <input
              type="text"
              className="ask-note-inp"
              placeholder={t("compExt.askFormNote")}
              aria-label={t("compExt.askFormNote")}
              value={notes[field.name] ?? ""}
              onChange={(e) => {
                setError(null);
                setNotes((prev) => ({ ...prev, [field.name]: e.target.value }));
              }}
            />
          </div>
        )}
      </fieldset>
    );
  };

  const renderBlock = (block: AskFormBlock, key: string) => {
    switch (block.kind) {
      case "text":
        return block.heading ? (
          <div className="ask-form-heading" key={key}>
            <Spans spans={block.spans} />
          </div>
        ) : (
          <p key={key}>
            <Spans spans={block.spans} />
          </p>
        );
      case "list":
        return block.ordered ? (
          <ol key={key}>
            {block.items.map((item2, i) => (
              <li key={i}>
                <Spans spans={item2} />
              </li>
            ))}
          </ol>
        ) : (
          <ul key={key}>
            {block.items.map((item2, i) => (
              <li key={i}>
                <Spans spans={item2} />
              </li>
            ))}
          </ul>
        );
      case "pre":
        return (
          <pre key={key} className="ask-form-pre">
            {block.text}
          </pre>
        );
      case "table":
        return (
          <table key={key} className="ask-form-table">
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) =>
                    r < block.headerRows ? (
                      <th key={c}>
                        <Spans spans={cell} />
                      </th>
                    ) : (
                      <td key={c}>
                        <Spans spans={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case "image":
        // Only real sources render: http(s) and data: URLs. The host rewrites inline
        // svg and workspace paths into data URIs, so a path here means that failed
        // and the alt text stands in, like the TUI's media note.
        return /^(https?:|data:)/i.test(block.src) ? (
          <img key={key} className="ask-form-img" src={block.src} alt={block.alt} />
        ) : (
          <div key={key} className="ask-form-img-alt">
            {block.alt || block.src}
          </div>
        );
      case "svg":
        // Inline markup from the model is never injected: the alt text stands in.
        return (
          <div key={key} className="ask-form-img-alt">
            {block.alt}
          </div>
        );
      case "field":
        return renderField(block.field);
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="approval-min"
        title={t("chat.approvalExpand")}
        onClick={() => setCollapsed(false)}
      >
        <Icon name="circleHelp" size={14} />
        <span className="approval-min-tt">{t("chat.awaitingConfirm")}</span>
        <span className="approval-min-q">{item.title}</span>
        {item.expiresAt && (
          // The countdown must survive collapsing: a hidden card whose clock keeps
          // running is the one the user most needs warned.
          <span className="ask-deadline">{t("compExt.askFormDeadlineShort", { s: leftSecs })}</span>
        )}
        <Icon name="chevronUp" size={14} />
      </button>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="ask-head-q">{item.title}</span>
        {pages.length > 1 && (
          <span className="ask-pager">
            <span className="ask-page">
              {current + 1}/{pages.length}
            </span>
            <button
              type="button"
              className="approval-collapse-btn ask-page-btn"
              disabled={current === 0}
              title={t("compExt.askPrev")}
              aria-label={t("compExt.askPrev")}
              onClick={() => turnTo(current - 1)}
            >
              <Icon name="chevronLeft" size={14} />
            </button>
            <button
              type="button"
              className="approval-collapse-btn ask-page-btn"
              disabled={current >= pages.length - 1}
              title={t("compExt.askNext")}
              aria-label={t("compExt.askNext")}
              onClick={() => turnTo(current + 1)}
            >
              <Icon name="chevronRight" size={14} />
            </button>
          </span>
        )}
        {!answered && (
          <button
            type="button"
            className="approval-collapse-btn ask-collapse-btn"
            title={t("chat.approvalCollapse")}
            aria-label={t("chat.approvalCollapse")}
            onClick={() => setCollapsed(true)}
          >
            <Icon name="chevronDown" size={14} />
          </button>
        )}
      </div>
      {/* A real <form> so the submit button needs no key handler and textareas keep
          their newline; Enter is remapped in the keydown handler (turn, submit last). */}
      <form
        className="ask-form"
        noValidate
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          // Esc cancels; PgUp/PgDn turn pages (the base's keys for the same job on
          // text fields). Arrows stay with the native radio groups.
          if (e.key === "Escape" && !answered) {
            e.preventDefault();
            reply("cancel");
            return;
          }
          if (pages.length > 1 && (e.key === "PageDown" || e.key === "PageUp")) {
            e.preventDefault();
            turnTo(Math.min(Math.max(current + (e.key === "PageDown" ? 1 : -1), 0), pages.length - 1));
            return;
          }
          // Enter is a click, not a submit: it confirms the focused answer and then
          // turns the page, and only the last page submits. The browser's implicit
          // form submit would settle the whole dialog from page one; textareas keep
          // their newline (their Enter never reaches this branch's preventDefault).
          if (e.key === "Enter" && !answered) {
            const el = e.target as HTMLElement;
            // Buttons activate on Enter natively (submit, pager, cancel); textareas keep
            // their newline. Only the other controls get the click-like remap.
            if (el.tagName === "TEXTAREA" || el.tagName === "BUTTON") return;
            e.preventDefault();
            const box = el.tagName === "INPUT" ? (el as HTMLInputElement) : null;
            const field =
              box && (box.type === "radio" || box.type === "checkbox")
                ? form.fields.find((f) => f.kind === "choice" && box.name === `${item.requestId}:${f.name}`)
                : undefined;
            if (box && field?.kind === "choice") {
              pickChoice(field, box.value);
              advanceOnPick(field, box.value);
              return;
            }
            if (current < pages.length - 1) turnTo(current + 1);
            else submit();
          }
        }}
      >
        {(pages[current] ?? []).map((si) => {
          const section = form.sections[si]!;
          return (
            <fieldset className="ask-form-section" key={si}>
              {section.title.length > 0 && (
                <legend className="ask-form-heading">
                  <Spans spans={section.title} />
                </legend>
              )}
              {section.blocks.map((block, bi) => renderBlock(block, `${si}:${bi}`))}
            </fieldset>
          );
        })}
        {error && <div className="ask-form-error">{error}</div>}
        {!answered && (
          <div className="approval-foot">
            <span className="approval-hint">
              {item.expiresAt
                ? t("compExt.askFormDeadline", { s: leftSecs })
                : t("compExt.askFormHint")}
            </span>
            <span className="approval-foot-actions">
              <button type="button" className="approval-cancel" onClick={() => reply("cancel")}>
                {t("chat.approvalCancel")}
              </button>
              <button type="submit" className="approval-confirm">
                {t("chat.approvalSubmit")}
              </button>
            </span>
          </div>
        )}
      </form>
    </div>
  );
}
