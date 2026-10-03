// Composer sigil trigger computation (@ file completion / line-leading /
// command completion / line-leading $ skill completion / ! bash mode): pure
// functions, no React dependency. Semantics aligned with the base TUI's
// autocomplete.ts extractAtPrefix / findLeadingSlashCommandStart and
// input-controller.ts's isBashMode.

// Word-boundary delimiters: hitting any of these characters inside a trigger
// token truncates it (aligned with the TUI)
const DELIM = new Set([" ", "\t", "\n", '"', "'", "="]);

/** Word-boundary token start: scan back from the caret until just past a delimiter */
function tokenStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0 && !DELIM.has(text[i - 1])) i--;
  return i;
}

/** If an unclosed double quote exists before the caret, return its index
    (paired scanning, aligned with TUI findUnclosedQuoteStart) */
function findUnclosedQuote(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

/** @ file mention completion trigger range */
export type FileTrigger = { kind: "file"; start: number; end: number; query: string; quoted: boolean };
/** Line-leading / slash command completion trigger range */
export type CommandTrigger = { kind: "command"; start: number; end: number; query: string };
/** Line-leading $ skill completion trigger range */
export type SkillTrigger = { kind: "skill"; start: number; end: number; query: string };
export type Trigger = FileTrigger | CommandTrigger | SkillTrigger;

/**
 * Trigger detection. Returns:
 *   null                                            -- no trigger
 *   { kind:"file", start, end, query, quoted }      -- @ file mention completion
 *   { kind:"command", start, end, query }           -- line-leading / slash
 *                                                      command completion
 *   { kind:"skill", start, end, query }             -- line-leading $ skill
 *                                                      completion ($name is
 *                                                      sugar for /skill:name)
 * start/end is the token's range in text (used for replacement); query is the
 * search term without the sigil.
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  // Quotes take priority: whitespace inside an unclosed @"..." does not break
  // the token (completion for paths with spaces, aligned with TUI
  // extractQuotedPrefix)
  const qs = findUnclosedQuote(before);
  if (qs !== null && qs > 0 && before[qs - 1] === "@" && (qs - 1 === 0 || DELIM.has(before[qs - 2]))) {
    return { kind: "file", start: qs - 1, end: caret, query: text.slice(qs + 1, caret), quoted: true };
  }
  const start = tokenStart(text, caret);
  const ch = text[start];
  if (ch === "@") {
    let query = text.slice(start + 1, caret);
    let quoted = false;
    if (query.startsWith('"')) {
      quoted = true;
      query = query.slice(1);
    }
    // Whitespace in an unquoted query means the token has ended (e.g. the caret
    // is on "bar" in "@foo bar"); whitespace inside quotes is allowed
    // (paths with spaces, e.g. @"a b.txt")
    if (!quoted && /\s/.test(query)) return null;
    return { kind: "file", start, end: caret, query, quoted };
  }
  if (ch === "/" && text.slice(0, start).trim() === "") {
    // Only a / at line start (leading whitespace tolerated) triggers command
    // completion; a mid-line / does not
    const query = text.slice(start + 1, caret);
    if (/\s/.test(query)) return null; // the command name is typed out and the argument section is entered: close the popup
    return { kind: "command", start, end: caret, query };
  }
  if (ch === "$" && text.slice(0, start).trim() === "") {
    // Line-leading $ triggers skill completion (same line-start rule as /:
    // the accepted candidate inserts "/skill:<name>", which the host only
    // dispatches in leading position, so mid-prompt $ stays inert)
    const query = text.slice(start + 1, caret);
    if (/\s/.test(query)) return null; // arguments started: close the popup
    return { kind: "skill", start, end: caret, query };
  }
  return null;
}

/** The composer is in bash mode: after trimStart it starts with ! (aligned
    with the TUI input-controller isBashMode) */
export function isBashMode(text: string): boolean {
  return text.trimStart().startsWith("!");
}

/** Insertion text after accepting a file candidate: quote paths with spaces;
    directories get no trailing space (to allow chained expansion) */
export function insertFile(value: string, dir: boolean, quoted: boolean): string {
  const needsQuote = quoted || value.includes(" ");
  const body = needsQuote ? `"${value}"` : value;
  return "@" + body + (dir ? "" : " ");
}

/** Insertion text after accepting a command/skill candidate: command name +
    space goes straight into the argument section (skill entries reuse this --
    their name is "skill:<name>", so the text becomes "/skill:<name> " which
    the host dispatches via parseSkillInvocation) */
export function insertCommand(name: string): string {
  return "/" + name + " ";
}
