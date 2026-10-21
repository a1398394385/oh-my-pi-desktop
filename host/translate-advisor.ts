// Advisor advice batches → transcript rows. The base injects them as customType "advisor"
// custom messages (details {notes}) on two paths: steered into a running turn, or preserved
// at the run boundary. Both are real conversation events, so the desktop renders them at
// their stream position instead of dropping the custom role.
import type { AdvisorNote, TranscriptItem, UiEvent } from "./wire/payloads.ts";
import type { PoolEntry } from "./state.ts";

// Missing/garbled details degrade to the raw content as one concern note rather than
// dropping the batch (an advice the model received must stay inspectable).
export function advisorNotesOf(msg: unknown): AdvisorNote[] | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { role?: unknown; customType?: unknown; content?: unknown; details?: unknown };
  if (m.role !== "custom" || m.customType !== "advisor") return null;
  const raw = (m.details as { notes?: unknown } | null)?.notes;
  const notes: AdvisorNote[] = [];
  if (Array.isArray(raw)) {
    for (const n of raw) {
      if (typeof n !== "object" || n === null) continue;
      const o = n as { note?: unknown; severity?: unknown; advisor?: unknown; turnsAgo?: unknown };
      if (typeof o.note !== "string" || !o.note.trim()) continue;
      notes.push({
        note: o.note,
        severity: o.severity === "blocker" || o.severity === "concern" || o.severity === "nit" ? o.severity : "concern",
        ...(typeof o.advisor === "string" && o.advisor ? { advisor: o.advisor } : {}),
        ...(typeof o.turnsAgo === "number" ? { turnsAgo: o.turnsAgo } : {}),
      });
    }
  }
  if (notes.length) return notes;
  const text = typeof m.content === "string" ? m.content.trim() : "";
  return text ? [{ note: text, severity: "concern" }] : null;
}

/** Live path: an advice batch arrives as a custom message (steered mid-run or preserved
 *  at the run boundary). Returns the event and records the same row in the pooled
 *  transcript; the row keeps its stream position, which is what makes a mid-run blocker
 *  land where it fired. */
export function advisorEvent(msg: unknown, entry: PoolEntry): UiEvent | null {
  const notes = advisorNotesOf(msg);
  if (!notes) return null;
  entry.transcript.push({ role: "advisor", text: "", notes });
  return { kind: "advisor", notes };
}

/** Reload path: the same batch on disk, as an outer row (the run group stays collapsed
 *  and a mid-run blocker keeps the position that also breaks a read-only fold). */
export function advisorHistoryRow(entry: any): TranscriptItem | null {
  if (entry?.type !== "custom_message") return null;
  const notes = advisorNotesOf({ role: "custom", customType: entry.customType, content: entry.content, details: entry.details });
  return notes ? { role: "advisor", text: "", notes } : null;
}
