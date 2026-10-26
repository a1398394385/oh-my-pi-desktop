// Dialog deadlines for the approval channel: how long an ask dialog or a
// permission approval waits before the run answers for the user. Kept out of
// session-entry-core so the deadline policy (settings resolution + the
// ask-dialog auto-answer shape) stays one greppable place.
import type { PoolEntry } from "./state.ts";
import { settingsGet } from "./settings-compat.ts";

/**
 * Permission-approval deadline for a session, in ms: an automation run carries
 * the automation settings page's deadline (spawn-time snapshot), every other
 * session follows ask.timeout (the same setting the base resolves for ask).
 * 0 or absent = wait forever.
 *
 * The ask tool does not come through here: the base reads ask.timeout itself
 * and hands the ms deadline in the dialog options.
 */
export function approvalDeadlineMs(entry: PoolEntry): number | undefined {
  const secs = entry.approvalTimeoutSec ?? (settingsGet(entry.session.settings, "ask.timeout") as number);
  return typeof secs === "number" && secs > 0 ? secs * 1000 : undefined;
}

/**
 * Ask-dialog deadline answer, mirroring the base's timedOutAskDialogResult
 * contract: every question keeps its recommended row (else the first) and is
 * flagged timedOut. Serialized because the approval channel carries answers as
 * strings (session-entry-core's parseAskAnswer parses it back).
 */
export function timedOutAskAnswer(questions: unknown[]): string {
  const results = questions.map((raw) => {
    const q = (raw ?? {}) as {
      id?: unknown;
      question?: unknown;
      multi?: unknown;
      recommended?: unknown;
      options?: { label?: unknown }[];
    };
    const options = (q.options ?? []).map((o) => String(o?.label ?? ""));
    const recommended = typeof q.recommended === "number" ? q.recommended : 0;
    const pick = options[Math.min(Math.max(recommended, 0), Math.max(options.length - 1, 0))];
    return {
      id: q.id,
      question: q.question,
      options,
      multi: q.multi === true,
      selectedOptions: pick === undefined ? [] : [pick],
      customInput: undefined,
      timedOut: true,
    };
  });
  return JSON.stringify({ kind: "submit", results });
}
