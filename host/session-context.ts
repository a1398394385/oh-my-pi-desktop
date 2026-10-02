// ReadSessionContext built-in tool: literal search and expansion over the
// current profile's Pi session history.
//
// Modeled on pi-session-memory (npm:pi-session-memory, MIT) recall_memory /
// fetch_session semantics: literal (substring) matching rather than semantic
// retrieval, hits return the raw conversation text, read-only with no state
// changes, and hit results carry a session id so a second call can expand
// specific turns. Three things from that package were deliberately cut —
// cross-harness indexing (Claude Code / Codex JSONL), full SQLite indexing
// with background sync, and session migration — this app only reads its own
// Pi sessions: the profile-isolated sessions directory is listed and parsed
// directly by the SDK's listAllSessions / loadEntriesFromFile (measured: the
// default profile's 169 sessions / 35979 entries fully read in 0.25s, no
// custom index needed).
import { type } from "@oh-my-pi/omptype";
import type { FileEntry, SessionInfo } from "@oh-my-pi/pi-coding-agent";
import { FileSessionStorage, listAllSessions, loadEntriesFromFile } from "./bootstrap.ts";

/** A "user question + assistant reply" pair inside a session — the minimal unit of search and expansion. */
interface SessionTurn {
  index: number;
  ts: number;
  user: string;
  assistant: string;
  tools: string[];
}

interface ScannedSession {
  info: SessionInfo;
  turns: SessionTurn[];
}

interface SessionContextHit {
  session: ScannedSession;
  turn: SessionTurn;
  /** Number of matched query terms (more = more relevant). */
  score: number;
}

// ---- parse: session file -> turn list ----

/** Extract plain-text blocks from a message, ignoring image / thinking / tool blocks. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type: kind, text } = block as { type?: unknown; text?: unknown };
    if (kind === "text" && typeof text === "string" && text.trim()) parts.push(text.trim());
  }
  return parts.join("\n");
}

/** Collect tool call names initiated by an assistant message (pre-dedup). */
function blockToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type: kind, name } = block as { type?: unknown; name?: unknown };
    if (kind === "toolCall" && typeof name === "string") names.push(name);
  }
  return names;
}

/** Fold message entries into turns in file order: a user message opens a new turn; assistant text / tool calls after it belong to that turn until the next user message. */
function turnsFromEntries(entries: FileEntry[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let current: SessionTurn | null = null;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const user = blockText(message.content);
      if (!user) continue;
      current = { index: turns.length, ts: message.timestamp, user, assistant: "", tools: [] };
      turns.push(current);
      continue;
    }
    if (message.role !== "assistant" || !current) continue;
    const text = blockText(message.content);
    if (text) current.assistant += (current.assistant ? "\n" : "") + text;
    current.tools.push(...blockToolNames(message.content));
  }
  return turns;
}

// ---- scan and search ----

interface ScanOptions {
  /** Keep only sessions started in this directory (exact match, same cwd filtering as pi-session-memory). */
  cwd?: string;
  /** Keep only sessions modified within the last N days. */
  days?: number;
  /** Session file to exclude (the current session itself — searching itself is usually worthless). */
  excludePath?: string | null;
}

/** List the current profile's Pi sessions and parse them into turn lists. */
async function scanSessions(options: ScanOptions = {}): Promise<ScannedSession[]> {
  const storage = new FileSessionStorage();
  const infos = await listAllSessions(storage);
  const cutoff = options.days && options.days > 0 ? Date.now() - options.days * 86_400_000 : 0;
  const sessions: ScannedSession[] = [];
  for (const info of infos) {
    if (options.cwd && info.cwd !== options.cwd) continue;
    if (cutoff && info.modified.getTime() < cutoff) continue;
    if (options.excludePath && info.path === options.excludePath) continue;
    sessions.push({ info, turns: turnsFromEntries(await loadEntriesFromFile(info.path, storage)) });
  }
  return sessions;
}

/** Query terms: split on whitespace / comma / ideographic comma, all lowercased (literal containment matching). */
function splitQueryTerms(query: string): string[] {
  return query
    .split(/[\s,，、]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

/** Literal search: return matching turns (more matched terms first, then newest first). */
function searchSessionContext(
  sessions: ScannedSession[],
  query: string,
  limit: number,
): SessionContextHit[] {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return [];
  const hits: SessionContextHit[] = [];
  for (const session of sessions) {
    for (const turn of session.turns) {
      const haystack = `${turn.user}\n${turn.assistant}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score++;
      if (score > 0) hits.push({ session, turn, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.turn.ts - a.turn.ts);
  return hits.slice(0, limit);
}

// ---- output formatting ----

const USER_CLIP = 1200;
const ASSISTANT_CLIP = 1500;
/** Output budget for a single expansion; exceeding it prompts narrowing the turn range. */
const EXPAND_BUDGET = 24_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatHits(hits: SessionContextHit[], query: string, scanned: number): string {
  if (hits.length === 0) {
    return `No stored Pi session turn matches "${query}" (scanned ${scanned} sessions). Search is literal substring matching — try fewer, more distinctive terms, or drop the cwd/days filters.`;
  }
  const lines = [
    `# Session context matches`,
    ``,
    `**Query:** ${query}`,
    `**Scanned:** ${scanned} sessions · **Matches:** ${hits.length}`,
    `**Expand:** call \`read_session_context\` with \`{ sessionId, fromTurn, toTurn }\` to read a hit verbatim.`,
  ];
  hits.forEach((hit, i) => {
    const { info } = hit.session;
    lines.push(
      ``,
      `## ${i + 1}. ${stamp(hit.turn.ts)} · score ${hit.score} · ${info.cwd || "(unknown cwd)"}`,
      `**Session:** \`${info.id}\` · turn ${hit.turn.index} of ${hit.session.turns.length}`,
      ``,
      `**User:** ${clip(hit.turn.user, USER_CLIP)}`,
    );
    if (hit.turn.assistant) lines.push(``, `**Assistant:** ${clip(hit.turn.assistant, ASSISTANT_CLIP)}`);
    else lines.push(``, `**Assistant:** (no assistant text persisted for this turn)`);
  });
  return lines.join("\n");
}

function formatTurns(session: ScannedSession, fromTurn: number, toTurn: number): string {
  const { info } = session;
  const selected = session.turns.filter((turn) => turn.index >= fromTurn && turn.index <= toTurn);
  const header = [
    `# Session ${info.id}`,
    ``,
    `**Project:** ${info.cwd || "(unknown)"} · **Started:** ${stamp(info.created.getTime())} · **Modified:** ${stamp(info.modified.getTime())}`,
    `**Turns:** ${session.turns.length} (showing ${selected.length}${selected.length ? `: ${fromTurn}..${toTurn}` : ""}) · **File:** ${info.path}`,
  ];
  if (selected.length === 0) {
    return [...header, ``, `No turns in range ${fromTurn}..${toTurn}.`].join("\n");
  }
  const lines = [...header];
  let used = 0;
  let truncatedAt = -1;
  for (const turn of selected) {
    if (used >= EXPAND_BUDGET) {
      truncatedAt = turn.index;
      break;
    }
    const tools = turn.tools.length ? [...new Set(turn.tools)].join(", ") : "none";
    const user = clip(turn.user, USER_CLIP);
    const assistant = turn.assistant ? clip(turn.assistant, ASSISTANT_CLIP) : "(no assistant text persisted)";
    used += user.length + assistant.length;
    lines.push(
      ``,
      `## Turn ${turn.index} · ${stamp(turn.ts)}`,
      `**User:** ${user}`,
      ``,
      `**Assistant:** ${assistant}`,
      `**Tools:** ${tools}`,
    );
  }
  if (truncatedAt >= 0) {
    lines.push(``, `(output budget reached — narrowing the turn range to start at turn ${truncatedAt} will show the rest)`);
  }
  return lines.join("\n");
}

// ---- tool definition ----

const READ_SESSION_CONTEXT_DESCRIPTION = `Search this machine's stored Pi sessions for prior conversations, and expand one session's turns verbatim.

USE WHEN
- The user references an earlier discussion ("as we discussed", "the plan from last week", "we already fixed this").
- You need prior context absent from the current session: earlier conclusions, file paths, commands, or rejected approaches.

HOW IT SEARCHES
- Literal, case-insensitive substring matching over the raw user and assistant text of every stored turn. No embeddings, no synonyms — pass 2-8 specific entities (file names, symbols, error strings), not a vague sentence.
- The current session is excluded; sessions from every project are searched unless \`cwd\` is given. Sessions live in the active profile's session directory.

EXPANDING
- Every hit carries a \`sessionId\`. Call this tool again with \`{ sessionId, fromTurn, toTurn }\` to read that session's turns verbatim. Fetch the smallest useful range.

EXAMPLES
- { query: "session-context.ts read_session_context" }
- { query: "BUG-007 turn_end", days: 30 }
- { sessionId: "01a0beb2-5c8f-714d-b234-eec23fc82ec7", fromTurn: 12, toTurn: 14 }

Read-only: it never modifies sessions, transcripts, or memory.`;

const readSessionContextParams = type({
  "query?": type("string").describe(
    "Literal search terms (2-8 specific entities), separated by spaces or commas. Mutually exclusive with sessionId.",
  ),
  "sessionId?": type("string").describe(
    "Session id (or file path) from a previous result. Switches to expand mode: read that session's turns instead of searching.",
  ),
  "fromTurn?": type("number").describe(
    "First turn to read in expand mode (0-based). Omit to start at turn 0.",
  ),
  "toTurn?": type("number").describe(
    "Last turn to read in expand mode (0-based, inclusive). Omit for the last turn of the session.",
  ),
  "limit?": type("number").describe("Maximum matched turns to return in search mode (default: 10)."),
  "cwd?": type("string").describe("Search mode: only sessions started in this directory."),
  "days?": type("number").describe("Search mode: only sessions modified within the last N days."),
});

function textResult(text: string, useless?: boolean) {
  return useless ? { content: [{ type: "text" as const, text }], useless: true } : { content: [{ type: "text" as const, text }] };
}

/** Build the ReadSessionContext tool (stateless; the same array can be shared across sessions). */
export function createSessionContextTools() {
  return [
    {
      name: "read_session_context",
      label: "Read Session Context",
      description: READ_SESSION_CONTEXT_DESCRIPTION,
      parameters: readSessionContextParams,
      loadMode: "essential" as const,
      approval: "read" as const,
      execute: async (
        _id: string,
        params: Record<string, unknown>,
        _signal?: unknown,
        _onUpdate?: unknown,
        ctx?: { sessionManager?: { getSessionFile?: () => string | null } },
      ) => {
        const query = typeof params?.query === "string" ? params.query.trim() : "";
        const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
        if (!query && !sessionId) {
          return textResult(
            "Error: pass either query (search mode) or sessionId (expand mode). See the tool description for examples.",
          );
        }
        const excludePath = ctx?.sessionManager?.getSessionFile?.() ?? null;
        const days = typeof params?.days === "number" && params.days > 0 ? params.days : undefined;
        const cwd = typeof params?.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;

        if (sessionId) {
          // Expand mode locates a single session by id/file path only: no
          // cwd/days filters (those narrow search mode) and no other sessions
          // parsed — expansion is O(1), not a full scan
          const storage = new FileSessionStorage();
          const info = (await listAllSessions(storage)).find(
            (candidate) => candidate.id === sessionId || candidate.path === sessionId,
          );
          if (!info) {
            return textResult(
              `Error: session "${sessionId}" not found. Copy the exact Session id from a read_session_context search result.`,
            );
          }
          const session: ScannedSession = {
            info,
            turns: turnsFromEntries(await loadEntriesFromFile(info.path, storage)),
          };
          const fromTurn = typeof params?.fromTurn === "number" ? Math.max(0, params.fromTurn) : 0;
          const toTurn =
            typeof params?.toTurn === "number" ? Math.max(fromTurn, params.toTurn) : session.turns.length - 1;
          return textResult(formatTurns(session, fromTurn, toTurn));
        }

        const limit = typeof params?.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 10;
        const sessions = await scanSessions({ excludePath, cwd, days });
        const hits = searchSessionContext(sessions, query, limit);
        return textResult(formatHits(hits, query, sessions.length), hits.length === 0);
      },
    },
  ];
}