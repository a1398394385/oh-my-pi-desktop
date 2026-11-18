// Parsing one formDialog answer off the approval channel, plus the question-level
// notes the card collects. Kept out of session-entry-core because host/session-*.ts
// shares a hard LOC budget, and beside form-media (the other module that decorates
// a parsed form).
import { formAnswers, type HtmlFormData, type OptionNote } from "@oh-my-pi/pi-tui/html-form/data";
import type { HtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { ExtensionFormDialogResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

/**
 * One submitted formDialog answer, or undefined when the payload is not a submit
 * (cancel, malformed JSON) — the base treats that as cancelled.
 *
 * The card sends notes as `{ name, text }`; the base's OptionNote also wants
 * question/option/value, which only the host can fill without duplicating every
 * option's label into the UI.
 */
export function formSubmission(form: HtmlForm, answer: string): ExtensionFormDialogResult | undefined {
  try {
    const submitted = JSON.parse(answer) as { kind?: unknown; data?: unknown; notes?: unknown; timedOut?: unknown };
    if (submitted?.kind !== "submit" || !submitted.data || typeof submitted.data !== "object") return undefined;
    const data = submitted.data as HtmlFormData;
    const notes = formNotes(form, data, submitted.notes);
    return {
      data,
      ...(notes ? { notes } : {}),
      ...(submitted.timedOut === true ? { timedOut: true } : {}),
    };
  } catch {
    // Malformed submissions count as cancelled, not as an error frame
    return undefined;
  }
}

/**
 * Notes on single-choice fields: each card row is the base's option notes
 * flattened to one per question, so `option` is the submitted answer's label and
 * `value` its wire value. formAnswers already renders `Other: <text>` for a
 * custom answer, and leaves both empty when nothing was picked.
 */
function formNotes(form: HtmlForm, data: HtmlFormData, raw: unknown): OptionNote[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const answers = new Map(formAnswers(form, data).map((answer) => [answer.name, answer]));
  const notes: OptionNote[] = [];
  for (const entry of raw as { name?: unknown; text?: unknown }[]) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    const answer = answers.get(name);
    if (!answer || !text) continue;
    notes.push({ name, question: answer.question, option: answer.answer, value: String(data[name] ?? ""), text });
  }
  return notes.length > 0 ? notes : undefined;
}
