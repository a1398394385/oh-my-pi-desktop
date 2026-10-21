// Framing of a session delivery: the run's prompt is posted as a custom user message, so
// the model must be able to tell a timer wake-up from typed input. Both ends live here —
// the scheduler writes the header, translate.ts strips it back into the bubble.
import { AUTOMATION_DELIVERY_CUSTOM_TYPE } from "./types.ts";

/** `[automation] {json header}` + blank line + prompt: what lands in the journal. */
export function deliveryText(a: { id: string; title: string; prompt: string }, at: number): string {
  return `[automation] ${JSON.stringify({ id: a.id, title: a.title, at: new Date(at).toISOString() })}\n\n${a.prompt}`;
}

/** Journal entry / live event → bubble text plus the marker. null = not a delivery. */
export function parseDelivery(msg: { customType?: unknown; content?: unknown }): {
  text: string;
  marker: { id: string; title: string };
} | null {
  if (msg.customType !== AUTOMATION_DELIVERY_CUSTOM_TYPE) return null;
  const raw = typeof msg.content === "string" ? msg.content : "";
  const match = /^\[automation\] (\{[^\n]*\})\n\n([\s\S]*)$/.exec(raw);
  if (!match) return { text: raw, marker: { id: "", title: "" } };
  let id = "";
  let title = "";
  try {
    const header = JSON.parse(match[1] ?? "{}") as { id?: unknown; title?: unknown };
    id = typeof header.id === "string" ? header.id : "";
    title = typeof header.title === "string" ? header.title : "";
  } catch {
    // Host-written header: a parse failure only costs the marker labels.
  }
  return { text: match[2] ?? "", marker: { id, title } };
}
