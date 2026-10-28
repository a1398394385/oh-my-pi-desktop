// Automation delivery framing, both ends in one file: the scheduler marks a delivered
// prompt on disk, and the replay (translate-history.ts) turns that marker back into the
// card header. The base's message entry has no room for the automation id, so the marker
// rides its own custom entry written immediately before the prompt.
//
// Deliveries made before that custom entry existed carry no marker on disk. For those the
// runs ledger in automations.json is the only surviving record, so the same module derives
// a prompt → marker index for one session file (deliveryMarkersForSession).
import { readAutomations } from "./store.ts";
import { AUTOMATION_DELIVERY_CUSTOM_TYPE } from "./types.ts";

export interface DeliveryMarker {
  id: string;
  title: string;
}

/** Writer subset of the SDK's SessionManager (appendCustomEntry returns the entry id). */
interface CustomEntryWriter {
  appendCustomEntry(customType: string, data?: unknown): string;
}

/** Write the durable marker; call it before the prompt so the reader can attach it to
 *  the user message that follows. */
export function appendDeliveryMarker(writer: CustomEntryWriter, marker: DeliveryMarker): void {
  writer.appendCustomEntry(AUTOMATION_DELIVERY_CUSTOM_TYPE, marker);
}

/** Marker carried by a disk entry, or null when the entry is not one. Tolerates a
 *  malformed payload (hand-edited file) by reporting no marker. */
export function deliveryMarkerOf(e: { customType?: string; data?: unknown }): DeliveryMarker | null {
  if (e.customType !== AUTOMATION_DELIVERY_CUSTOM_TYPE) return null;
  const data = (e.data ?? {}) as { id?: unknown; title?: unknown };
  if (typeof data.id !== "string") return null;
  return { id: data.id, title: typeof data.title === "string" ? data.title : "" };
}

/**
 * Prompt → marker for every automation that delivered into `sessionPath`, keyed by the
 * prompt text as stored in the automation record. Only a fallback for sessions written
 * before markers existed: two tasks sharing one prompt collapse to the first, and a
 * prompt the user later typed by hand would read as a delivery (accepted — it is the
 * same text the unattended run sent into this exact session).
 */
export function deliveryMarkersForSession(sessionPath: string): Map<string, DeliveryMarker> {
  const { automations, runs } = readAutomations();
  const out = new Map<string, DeliveryMarker>();
  for (const [automationId, list] of Object.entries(runs)) {
    if (!list.some((r) => r.sessionPath === sessionPath && r.status === "succeeded")) continue;
    const automation = automations.find((a) => a.id === automationId);
    const prompt = automation?.prompt.trim();
    if (!automation || !prompt || out.has(prompt)) continue;
    out.set(prompt, { id: automation.id, title: automation.title });
  }
  return out;
}
