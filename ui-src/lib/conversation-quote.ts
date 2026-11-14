// Selection annotations travel to the model inside the prompt text: a
// <conversation_quote> JSON block prefixed to the user body, separated by one
// blank line. This module owns that format — the send path builds the prefix,
// every surface that shows an already-sent prompt strips it back off, and the
// prompt_dropped rollback parses it into pending notes again. The host's own
// attachment framing (<attached-file> / <attached-session>) lives in the same
// text and is cut here too, so a display surface only ever shows what the user wrote.
export interface QuoteNote {
  text: string;
  /** "" when the user left the comment empty. */
  comment: string;
  /** Subagent name when the quoted text came from a subagent's output. */
  agent?: string;
  /** Absolute path when the quote was taken from the file / diff pane. */
  file?: string;
  /** New-side line span in the file ("12" or "12-18"); absent when unknown. */
  lines?: string;
}

const OPEN = "<conversation_quote>\n";
const CLOSE = "\n</conversation_quote>\n\n";

/** Prompt prefix for the pending notes ("" when there are none). Field order and
 *  shape are part of the contract: text, comment, optional agent / file + lines. */
export function buildQuotePrefix(notes: QuoteNote[]): string {
  if (notes.length === 0) return "";
  const rows = notes.map((n) => ({
    text: n.text,
    comment: n.comment,
    ...(n.agent ? { agent: n.agent } : {}),
    ...(n.file ? { file: n.file, ...(n.lines ? { lines: n.lines } : {}) } : {}),
  }));
  return OPEN + JSON.stringify(rows) + CLOSE;
}

// The host inlines attachment framing into the prompt text itself: pasted file bodies
// (<attached-file>) and @session references (<attached-session>). It is model input, not
// what the user wrote, so it never reaches a display surface. Attribute values may hold a
// `>` (a legacy title carried a whole nested block), hence the quoted-value run; a block
// cut at an unterminated opening tag (a truncated message) loses that tail too.
const ATTACHED_RE = /<attached-(?:file|session)(?:\s+[\w-]+="[^"]*")*\s*>[\s\S]*?(?:<\/attached-(?:file|session)>|$)/g;

/** The @ session references a sent prompt carries, in prompt order (a backfill
 *  puts them back as "@session:<path>" so the host re-inlines them). */
export type SessionRefs = Array<{ title: string; path: string }>;

function sessionRefs(block: string): SessionRefs {
  const attrs = block.match(/^<attached-session((?:\s+[\w-]+="[^"]*")*)/)?.[1] ?? "";
  const attr = (key: string) => attrs.match(new RegExp(`${key}="([^"]*)"`))?.[1]?.replace(/&quot;/g, '"') ?? "";
  const path = attr("path");
  return path ? [{ title: attr("title"), path }] : [];
}

function stripAttached(text: string): { body: string; sessions: SessionRefs } {
  const sessions: SessionRefs = [];
  const body = text
    .replace(ATTACHED_RE, (block: string) => {
      sessions.push(...sessionRefs(block));
      return "";
    })
    // A preview/title truncates mid-header, leaving no closing `>` to match: drop the tail
    .replace(/<attached-(?:file|session)[\s\S]*$/, "")
    .replace(/[ \t]*\n[ \t]*(?=\n|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, sessions };
}

interface RawNote {
  text?: unknown;
  comment?: unknown;
  agent?: unknown;
  file?: unknown;
  lines?: unknown;
}

/** Split a sent prompt back into the user body, its quote block and the session
 *  references the host inlined. Every display surface goes through here, so the
 *  host's attachment framing is cut once instead of in each consumer. */
export function splitQuote(text: string): { body: string; notes: QuoteNote[]; sessions: SessionRefs } {
  const { body, notes } = parseQuote(text);
  return { ...stripAttached(body), notes };
}

function parseQuote(text: string): { body: string; notes: QuoteNote[] } {
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
          ...(typeof r.file === "string" && r.file
            ? { file: r.file, ...(typeof r.lines === "string" && r.lines ? { lines: r.lines } : {}) }
            : {}),
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
