// Selection annotations travel to the model inside the prompt text: a
// <conversation_quote> JSON block prefixed to the user body, separated by one
// blank line. This module owns that format — the send path builds the prefix,
// every surface that shows an already-sent prompt strips it back off, and the
// prompt_dropped rollback parses it into pending notes again.
export interface QuoteNote {
  text: string;
  /** "" when the user left the comment empty. */
  comment: string;
  /** Subagent name when the quoted text came from a subagent's output. */
  agent?: string;
}

const OPEN = "<conversation_quote>\n";
const CLOSE = "\n</conversation_quote>\n\n";

/** Prompt prefix for the pending notes ("" when there are none). Field order and
 *  shape are part of the contract: text, comment, optional agent. */
export function buildQuotePrefix(notes: QuoteNote[]): string {
  if (notes.length === 0) return "";
  const rows = notes.map((n) => ({ text: n.text, comment: n.comment, ...(n.agent ? { agent: n.agent } : {}) }));
  return OPEN + JSON.stringify(rows) + CLOSE;
}

interface RawNote {
  text?: unknown;
  comment?: unknown;
  agent?: unknown;
}

/** Split a sent prompt back into the user body and its quote block. */
export function splitQuote(text: string): { body: string; notes: QuoteNote[] } {
  if (!text.startsWith(OPEN)) return { body: text, notes: [] };
  const end = text.indexOf(CLOSE, OPEN.length);
  if (end < 0) return { body: text, notes: [] };
  let notes: QuoteNote[] = [];
  try {
    const rows = JSON.parse(text.slice(OPEN.length, end)) as RawNote[];
    if (Array.isArray(rows)) {
      notes = rows
        .filter((r) => r && typeof r.text === "string")
        .map((r) => ({
          text: r.text as string,
          comment: typeof r.comment === "string" ? r.comment : "",
          ...(typeof r.agent === "string" && r.agent ? { agent: r.agent } : {}),
        }));
    }
  } catch {
    return { body: text, notes: [] };
  }
  if (notes.length === 0) return { body: text, notes: [] };
  return { body: text.slice(end + CLOSE.length), notes };
}

/** Display form of a prompt that may carry the quote prefix. */
export function stripQuote(text: string): string {
  return splitQuote(text).body;
}
