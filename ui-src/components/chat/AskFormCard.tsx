// Ask form card (18.20 uiCtx.formDialog): the model writes one HTML `<form>`, the
// host parses it into AskFormWire with the same pi-tui parser the TUI and ACP hosts
// use, and this card draws it whole — every answer submitted at once. Hosts without
// a form surface fall back to per-field select/input rounds, which loses the layout
// and the submitted set; that is why the interface exists at all.
// The submission is answer = JSON of { kind: "submit", data } — anything else (the
// cancel button, a malformed payload) settles the base's ask tool as cancelled.
import { useMemo, useRef, useState } from "react";
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
  // Free-text "Other" answers per choice field (base: ChoiceField.other), plus
  // whether the row is open: clicking it must reveal its input before any typing.
  const [others, setOthers] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // Every named field the user must answer: a choice needs one checked option or
  // Other text, a text field needs non-empty text. Optional fields stay optional.
  const required = useMemo(() => form.fields.filter((f) => f.name && f.required), [form]);

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

  const submit = () => {
    const missing = required.find((f) => {
      if (f.kind === "text") return String(values[f.name] ?? "").trim() === "";
      const picked = values[f.name];
      return Array.isArray(picked) ? picked.length === 0 && !(others[f.name] ?? "").trim() : !picked;
    });
    if (missing) {
      setError(t("compExt.askFormRequired", { name: missing.kind === "text" ? plain(missing.label) || missing.name : missing.name }));
      return;
    }
    const data: Record<string, FormValue> = {};
    for (const [name, value] of form.hidden) data[name] = value;
    for (const field of form.fields) {
      if (!field.name) continue;
      const value = values[field.name];
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
    reply(JSON.stringify({ kind: "submit", data }));
  };

  const pickChoice = (field: Extract<AskFormField, { kind: "choice" }>, value: string) => {
    if (answered) return;
    setError(null);
    // A single-choice pick drops a typed Other (they are exclusive answers)
    setOthers((prev) => (field.multi ? prev : { ...prev, [field.name]: "" }));
    if (!field.multi) setOtherOpen((prev) => ({ ...prev, [field.name]: false }));
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
        <div className="ask-q" key={field.name}>
          {field.label.length > 0 && (
            <div className="approval-label">
              <Spans spans={field.label} />
            </div>
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
        </div>
      );
    }

    const picked = values[field.name];
    const isOn = (optionValue: string) => (Array.isArray(picked) ? picked.includes(optionValue) : picked === optionValue);
    const enabled = field.options.filter((o) => !o.disabled);
    const supportsOther = field.other && enabled.length >= 2;
    const otherText = others[field.name] ?? "";

    return (
      <div className="ask-q" key={field.name}>
        {field.label.length > 0 && (
          <div className="approval-label">
            <Spans spans={field.label} />
          </div>
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
          <div className="approval-list" role={field.multi ? "group" : "radiogroup"} aria-label={plain(field.label)}>
            {enabled.map((option, oi) => {
              const on = isOn(option.value);
              return (
                <div
                  key={option.value}
                  className={"approval-opt ask-opt" + (on ? " selected" : "") + (answered ? " dim" : "")}
                  onClick={() => pickChoice(field, option.value)}
                >
                  <input
                    type={field.multi ? "checkbox" : "radio"}
                    name={`${item.requestId}:${field.name}`}
                    checked={on}
                    disabled={answered}
                    readOnly
                    aria-label={plain(option.label)}
                  />
                  {!field.multi && <span className="approval-num">{oi + 1}.</span>}
                  <span className="approval-label">
                    <Spans spans={option.label} />
                  </span>
                </div>
              );
            })}
            {supportsOther && (
              <div
                className={"approval-opt ask-opt ask-other-opt" + (otherText ? " selected" : "") + (answered ? " dim" : "")}
                onClick={() => {
                  if (answered) return;
                  setError(null);
                  setOtherOpen((prev) => ({ ...prev, [field.name]: true }));
                  if (!field.multi) setValues((prev) => ({ ...prev, [field.name]: "" }));
                }}
              >
                <input
                  type={field.multi ? "checkbox" : "radio"}
                  name={`${item.requestId}:${field.name}`}
                  checked={otherText !== ""}
                  disabled={answered}
                  readOnly
                  aria-label={t("compExt.askOther")}
                />
                {!field.multi && <span className="approval-num">{enabled.length + 1}.</span>}
                <span className="approval-label">{t("compExt.askOther")}</span>
              </div>
            )}
            {supportsOther && (otherOpen[field.name] === true || otherText !== "") && (
              <div className="ask-other">
                <input
                  type="text"
                  className="approval-inp"
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
      </div>
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
        // Only real sources render: http(s) and data: URLs, like the base's media
        // resolver. A local path is not reachable from the renderer.
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

  return (
    <div className="approval-card">
      <div className="approval-head">{t("chat.awaitingConfirm")}</div>
      <div className="approval-title">{item.title}</div>
      <div className="ask-form" role="form">
        {form.sections.map((section, si) => (
          <div className={"ask-form-section" + (section.fieldset ? " fieldset" : "")} key={si}>
            {section.title.length > 0 && (
              <div className="ask-form-heading">
                <Spans spans={section.title} />
              </div>
            )}
            {section.blocks.map((block, bi) => renderBlock(block, `${si}:${bi}`))}
          </div>
        ))}
        {error && <div className="ask-form-error">{error}</div>}
      </div>
      {!answered && (
        <div className="approval-foot">
          <span className="approval-hint">
            {t("compExt.askFormHint")}
          </span>
          <span className="approval-foot-actions">
            <button type="button" className="approval-cancel" onClick={() => reply("cancel")}>
              {t("chat.approvalCancel")}
            </button>
            <button type="button" className="approval-confirm" onClick={submit}>
              {t("chat.approvalSubmit")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
