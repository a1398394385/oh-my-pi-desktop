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
 * formDialog deadline answer: the form's own defaults (hidden inputs,
 * preselected options, prefilled text), flagged timedOut — the base submits
 * exactly that when `ask.timeout` elapses. Serialized because the approval
 * channel carries answers as strings (session-entry-core's formDialog parses
 * it back into `{ data, timedOut }`).
 */
export function timedOutFormAnswer(data: Record<string, unknown>): string {
  return JSON.stringify({ kind: "submit", data, timedOut: true });
}
